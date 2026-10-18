import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const FORMAT = 'fetch-cassette-kit/v1';
const SECRET_KEY = /(?:authorization|cookie|password|passwd|secret|token|api[_-]?key|client[_-]?secret|private[_-]?key|access[_-]?key|session|credential)/i;
const SECRET_HEADER = /^(?:set-cookie|cookie|authorization|proxy-authorization)$/i;
const REDACTED = '[REDACTED]';

export class CassetteError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CassetteError';
  }
}

function redactObject(value) {
  if (Array.isArray(value)) return value.map(redactObject);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [
      key, SECRET_KEY.test(key) ? REDACTED : redactObject(child),
    ]));
  }
  return value;
}

function normalizeUrl(input) {
  const url = new URL(input);
  if (url.username) url.username = REDACTED;
  if (url.password) url.password = REDACTED;
  url.hash = '';
  const params = [...url.searchParams.entries()]
    .map(([key, value]) => [key, SECRET_KEY.test(key) ? REDACTED : value])
    .sort(([a, av], [b, bv]) => a.localeCompare(b) || av.localeCompare(bv));
  url.search = '';
  for (const [key, value] of params) url.searchParams.append(key, value);
  return url.toString();
}

function bodyKind(contentType) {
  if (/\bapplication\/json\b|\+json\b/i.test(contentType)) return 'json';
  if (/\bapplication\/x-www-form-urlencoded\b/i.test(contentType)) return 'form';
  if (/^text\//i.test(contentType)) return 'text';
  return 'unsupported';
}

async function safeBody(message, maxBodyBytes, allowTextResponses = false, redactJson, side) {
  const bytes = new Uint8Array(await message.clone().arrayBuffer());
  if (bytes.byteLength > maxBodyBytes) {
    throw new CassetteError(`Body exceeds maxBodyBytes (${maxBodyBytes}).`);
  }
  if (bytes.byteLength === 0) return { kind: 'empty', value: '' };
  const contentType = message.headers.get('content-type') || '';
  const kind = bodyKind(contentType);
  const raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (kind === 'json') {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new CassetteError(`Invalid JSON body: ${error.message}`);
    }
    const cleaned = redactObject(parsed);
    const value = JSON.stringify(redactJson ? redactJson(cleaned, side) : cleaned);
    if (value === undefined) throw new CassetteError('redactJson must return a JSON value.');
    return { kind, value };
  }
  if (kind === 'form') {
    const entries = [...new URLSearchParams(raw).entries()]
      .map(([key, value]) => [key, SECRET_KEY.test(key) ? REDACTED : value])
      .sort(([a, av], [b, bv]) => a.localeCompare(b) || av.localeCompare(bv));
    return { kind, value: new URLSearchParams(entries).toString() };
  }
  if (kind === 'text' && allowTextResponses) return { kind, value: raw };
  throw new CassetteError(`Cannot store ${contentType || 'untyped'} body safely. Use JSON/form data, or explicitly enable text responses.`);
}

function safeResponseHeaders(headers) {
  return [...headers.entries()]
    .filter(([name]) => !SECRET_HEADER.test(name) && !SECRET_KEY.test(name) &&
      !/^(?:content-length|content-encoding|transfer-encoding)$/i.test(name))
    .sort(([a], [b]) => a.localeCompare(b));
}

function validateFile(data, file) {
  if (!data || data.format !== FORMAT || !Array.isArray(data.entries)) {
    throw new CassetteError(`Invalid cassette format: ${file}`);
  }
  for (const entry of data.entries) {
    if (!entry || typeof entry.key !== 'string' || !entry.response ||
        !Number.isInteger(entry.response.status) ||
        !Array.isArray(entry.response.headers) ||
        typeof entry.response.body !== 'string' ||
        !['empty', 'json', 'form', 'text'].includes(entry.response.kind)) {
      throw new CassetteError(`Invalid cassette entry: ${file}`);
    }
  }
  return data.entries;
}

/** Create a fetch wrapper backed by a JSON cassette on disk. */
export async function createCassette({
  file,
  mode = 'auto',
  fetch: fetchImpl = globalThis.fetch,
  maxBodyBytes = 1_000_000,
  allowTextResponses = false,
  redactJson,
} = {}) {
  if (typeof file !== 'string' || !file) throw new TypeError('file must be a non-empty path');
  if (!['auto', 'record', 'replay'].includes(mode)) throw new TypeError('mode must be auto, record, or replay');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch must be a function');
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1) throw new TypeError('maxBodyBytes must be a positive integer');
  if (redactJson !== undefined && typeof redactJson !== 'function') throw new TypeError('redactJson must be a function');

  let existing;
  if (mode !== 'record') {
    try {
      existing = JSON.parse(await readFile(file, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') {
        if (error instanceof SyntaxError) throw new CassetteError(`Invalid JSON cassette: ${file}`);
        throw error;
      }
    }
  }
  const resolvedMode = mode === 'auto' ? (existing ? 'replay' : 'record') : mode;
  if (resolvedMode === 'replay' && !existing) throw new CassetteError(`Cassette does not exist: ${file}`);
  const entries = resolvedMode === 'replay' ? validateFile(existing, file) : [];
  const used = new Set();
  const pending = new Set();

  async function cassetteFetch(input, init) {
    const request = new Request(input, init);
    const body = await safeBody(request, maxBodyBytes, false, redactJson, 'request');
    const key = JSON.stringify([
      request.method, normalizeUrl(request.url),
      request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() || '',
      body.kind, body.value,
    ]);

    if (resolvedMode === 'replay') {
      const index = entries.findIndex((entry, position) => entry.key === key && !used.has(position));
      if (index < 0) {
        throw new CassetteError(`No unused recording for ${request.method} ${normalizeUrl(request.url)}.`);
      }
      used.add(index);
      const recorded = entries[index].response;
      return new Response(recorded.kind === 'empty' ? null : recorded.body, {
        status: recorded.status,
        statusText: recorded.statusText,
        headers: recorded.headers,
      });
    }

    const operation = (async () => {
      const response = await fetchImpl(request);
      const captured = await safeBody(response, maxBodyBytes, allowTextResponses, redactJson, 'response');
      entries.push({ key, response: {
        status: response.status,
        statusText: response.statusText,
        headers: safeResponseHeaders(response.headers),
        kind: captured.kind,
        body: captured.value,
      } });
      return response;
    })();
    pending.add(operation);
    try {
      return await operation;
    } finally {
      pending.delete(operation);
    }
  }

  async function save() {
    if (resolvedMode === 'replay') return;
    if (pending.size) throw new CassetteError('Wait for all fetch calls before saving the cassette.');
    await mkdir(dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify({ format: FORMAT, entries }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      await rename(temporary, file);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
  }

  return { fetch: cassetteFetch, save, mode: resolvedMode };
}

/** Run a callback and save recordings when it completes successfully. */
export async function withCassette(options, callback) {
  if (typeof callback !== 'function') throw new TypeError('callback must be a function');
  const cassette = await createCassette(options);
  const result = await callback(cassette.fetch);
  await cassette.save();
  return result;
}
