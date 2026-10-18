export type CassetteMode = 'auto' | 'record' | 'replay';

export interface CassetteOptions {
  /** Path to the JSON cassette. Parent directories are created on save. */
  file: string;
  /** auto records when absent and replays when present. Default: auto. */
  mode?: CassetteMode;
  /** Inject a fetch implementation. Default: globalThis.fetch. */
  fetch?: typeof globalThis.fetch;
  /** Maximum request or response body size in bytes. Default: 1,000,000. */
  maxBodyBytes?: number;
  /** Store text/* response bodies verbatim. Default: false. */
  allowTextResponses?: boolean;
  /** Further redact JSON data before it is used for matching or stored. */
  redactJson?: (value: unknown, side: 'request' | 'response') => unknown;
}

export interface Cassette {
  fetch: typeof globalThis.fetch;
  save(): Promise<void>;
  mode: 'record' | 'replay';
}

export class CassetteError extends Error {}
export function createCassette(options: CassetteOptions): Promise<Cassette>;
export function withCassette<T>(options: CassetteOptions, callback: (fetch: typeof globalThis.fetch) => Promise<T>): Promise<T>;
