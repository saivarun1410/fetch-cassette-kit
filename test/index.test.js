import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCassette, withCassette, CassetteError } from '../src/index.js';

async function fixture(testContext) {
  const directory = await mkdtemp(join(tmpdir(), 'fetch-cassette-kit-'));
  testContext.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, 'nested', 'api.json');
}

test('records redacted JSON and replays without network access', async (t) => {
  const file = await fixture(t);
  let liveCalls = 0;
  const liveFetch = async () => {
    liveCalls++;
    return new Response(JSON.stringify({ result: 'ok', access_token: 'response-secret', nested: { password: 'hidden' } }), {
      status: 201,
      headers: { 'content-type': 'application/json', 'set-cookie': 'session=secret', 'content-length': '999' },
    });
  };
  const options = { file, fetch: liveFetch };
  const url = 'https://example.test/items?api_key=url-secret&z=2';
  const init = {
    method: 'POST',
    headers: { authorization: 'Bearer header-secret', 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'widget', token: 'body-secret' }),
  };
  const recorded = await withCassette(options, (fetch) => fetch(url, init));
  assert.equal(recorded.status, 201);
  assert.equal(liveCalls, 1);

  const disk = await readFile(file, 'utf8');
  for (const secret of ['response-secret', 'hidden', 'session=secret', 'url-secret', 'header-secret', 'body-secret']) {
    assert.equal(disk.includes(secret), false, `${secret} leaked into cassette`);
  }
  assert.match(disk, /REDACTED/);

  const replayed = await withCassette(options, (fetch) => fetch('https://example.test/items?z=2&api_key=another-secret', {
    ...init,
    body: JSON.stringify({ name: 'widget', token: 'new-secret' }),
  }));
  assert.equal(liveCalls, 1);
  assert.equal(replayed.status, 201);
  assert.deepEqual(await replayed.json(), { result: 'ok', access_token: '[REDACTED]', nested: { password: '[REDACTED]' } });
  assert.equal(replayed.headers.has('set-cookie'), false);
  assert.equal(replayed.headers.has('content-length'), false);
});

test('replays repeated matching requests once each, then fails closed', async (t) => {
  const file = await fixture(t);
  let count = 0;
  const cassette = await createCassette({ file, mode: 'record', fetch: async () => {
    count++;
    return Response.json({ count });
  } });
  await cassette.fetch('https://example.test/repeated');
  await cassette.fetch('https://example.test/repeated');
  await cassette.save();

  const replay = await createCassette({ file, mode: 'replay', fetch: () => { throw new Error('network called'); } });
  assert.equal((await (await replay.fetch('https://example.test/repeated')).json()).count, 1);
  assert.equal((await (await replay.fetch('https://example.test/repeated')).json()).count, 2);
  await assert.rejects(replay.fetch('https://example.test/repeated'), CassetteError);
  await assert.rejects(replay.fetch('https://example.test/unknown'), CassetteError);
});

test('refuses unsupported response bodies unless text is explicitly enabled', async (t) => {
  const file = await fixture(t);
  const options = { file, mode: 'record', fetch: async () => new Response('private log', { headers: { 'content-type': 'text/plain' } }) };
  await assert.rejects(withCassette(options, (fetch) => fetch('https://example.test/log')), CassetteError);
  const cassette = await createCassette({ ...options, allowTextResponses: true });
  await cassette.fetch('https://example.test/log');
  await cassette.save();
  assert.match(await readFile(file, 'utf8'), /private log/);
});

test('missing replay file and malformed cassette produce useful errors', async (t) => {
  const file = await fixture(t);
  await assert.rejects(createCassette({ file, mode: 'replay' }), /does not exist/);
  await assert.rejects(createCassette({ file: '' }), TypeError);
  await mkdir(join(file, '..'), { recursive: true });
  await writeFile(file, 'broken json');
  await assert.rejects(createCassette({ file, mode: 'auto' }), /Invalid JSON cassette/);
  const replacement = await createCassette({ file, mode: 'record', fetch: async () => Response.json({ ok: true }) });
  await replacement.fetch('https://example.test/refresh');
  await replacement.save();
  assert.equal(JSON.parse(await readFile(file, 'utf8')).entries.length, 1);
});

test('form fields are redacted and normalized for matching', async (t) => {
  const file = await fixture(t);
  const live = await createCassette({ file, mode: 'record', fetch: async () => new Response('result=ok&api_key=server-secret', {
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  }) });
  await live.fetch('https://example.test/form', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'token=client-secret&name=Pat',
  });
  await live.save();
  const contents = await readFile(file, 'utf8');
  assert.equal(contents.includes('client-secret'), false);
  assert.equal(contents.includes('server-secret'), false);
  const replay = await createCassette({ file, mode: 'replay' });
  const result = await replay.fetch('https://example.test/form', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'name=Pat&token=different-secret',
  });
  assert.equal(await result.text(), 'api_key=%5BREDACTED%5D&result=ok');
});

test('custom JSON redactor removes application-specific personal data', async (t) => {
  const file = await fixture(t);
  const options = {
    file,
    mode: 'record',
    fetch: async () => Response.json({ email: 'person@example.test', ok: true }),
    redactJson: (value) => ({ ...value, email: '[REDACTED]' }),
  };
  await withCassette(options, (fetch) => fetch('https://example.test/profile'));
  const contents = await readFile(file, 'utf8');
  assert.equal(contents.includes('person@example.test'), false);
  const replay = await createCassette({ ...options, mode: 'replay' });
  assert.deepEqual(await (await replay.fetch('https://example.test/profile')).json(), { email: '[REDACTED]', ok: true });
});
