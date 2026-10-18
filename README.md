# fetch-cassette-kit

Record real `fetch` responses once; replay them offline in tests. Zero runtime dependencies, Node.js 20+, TypeScript types included.

```sh
npm install --save-dev fetch-cassette-kit
```

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withCassette } from 'fetch-cassette-kit';

test('GitHub API integration', async () => {
  const result = await withCassette(
    { file: './test/fixtures/github-user.json' },
    async (fetch) => {
      const response = await fetch('https://api.github.com/users/octocat');
      return response.json();
    },
  );
  assert.equal(result.login, 'octocat');
});
```

The first run records to the JSON file. Later runs replay from disk and never call the network. Commit the reviewed cassette so CI can run offline. `auto` is the default mode; specify `record` to refresh a cassette or `replay` to require one.

## Why use it?

- One wrapper around `fetch`; no global interception or test runner integration.
- Missing recordings throw a clear error instead of silently reaching the network.
- JSON bodies, form bodies, URL query parameters, and response headers receive basic secret-key redaction before writing.
- Requests match by method, normalized URL, content type, and redacted body. Repeated matching calls replay in recorded order.
- Human-readable, versioned JSON fixtures are easy to review in pull requests.

## Explicit lifecycle

`withCassette` saves after its callback succeeds. For multiple calls, or when you want access to the selected mode, use `createCassette`:

```js
import { createCassette } from 'fetch-cassette-kit';

const cassette = await createCassette({
  file: './test/fixtures/example.json',
  mode: process.env.UPDATE_FIXTURES ? 'record' : 'auto',
});

const first = await cassette.fetch('https://example.com/api/first');
const second = await cassette.fetch('https://example.com/api/second');
await cassette.save();
```

Pass `fetch: customFetch` to inject a client compatible with the Fetch API. `maxBodyBytes` defaults to 1,000,000 bytes per request or response. Body size and unsupported content types fail with `CassetteError`.

## Fixture privacy

Review every cassette before committing it. Built-in redaction recognizes common secret names such as `authorization`, `cookie`, `password`, `token`, `api_key`, `secret`, and `session` in JSON keys, form keys, and URL query keys. Request headers are never stored. Sensitive response headers and body-length headers are omitted.

Plain text responses are rejected by default because their contents cannot be reliably redacted. To store them verbatim, set `allowTextResponses: true`. Binary bodies and untyped nonempty bodies are unsupported. Arbitrary personal data under ordinary field names (for example `email` or `address`) is **not** removed, so use test accounts and inspect fixtures.

For application-specific JSON fields, add `redactJson`. It runs after built-in redaction on both requests and responses, before matching or writing:

```js
const options = {
  file: './test/fixtures/profile.json',
  redactJson(value, side) {
    if (side === 'response' && value && typeof value === 'object') {
      return { ...value, email: '[REDACTED]' };
    }
    return value;
  },
};
```

This is deliberately a small `fetch` wrapper for test fixtures. It does not intercept `axios`, `http.request`, browser requests, or streaming responses. Record mode sends real network requests.

## Contributing

Run `npm test` and `npm run pack:check`. Issues and pull requests for focused improvements are welcome. The package is MIT licensed.
