import { assert, test } from 'vitest';
import worker from '../src/index.ts';

const BASE_URL = 'https://bountyscope.test';

class MemoryKV {
  constructor(seed = {}) {
    this.store = new Map(Object.entries(seed));
  }
  async get(key) { return this.store.has(key) ? this.store.get(key) : null; }
  async put(key, value) { this.store.set(key, String(value)); }
  async delete(key) { this.store.delete(key); }
  keys(prefix = '') { return [...this.store.keys()].filter(key => key.startsWith(prefix)); }
}

function makeEnv(overrides = {}) {
  const env = {
    AI: {
      async run() { return { response: `{"finding_classes":[]}` }; }
    },
    BS_PROGRAMS: new MemoryKV(),
    BS_REPORTS: new MemoryKV(),
    ...overrides,
  };
  return env;
}

async function fetchJson(env, path, init) {
  const response = await worker.fetch(new Request(`${BASE_URL}${path}`, init), env);
  return { response, body: await response.json().catch(() => null) };
}

function jsonRequest(body, init = {}) {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    body: JSON.stringify(body),
    ...init,
  };
}

test('resolveAccess handles malformed JSON in API key record', async () => {
  const env = makeEnv();
  await env.BS_REPORTS.put('key:bad-json', '{malformed');
  const { response, body } = await fetchJson(env, '/api/whoami', { headers: { 'x-api-key': 'bad-json' } });
  assert.equal(response.status, 200);
  assert.equal(body.tier, 'free');
});

test('/api/analyze handles AI inference error', async () => {
  const env = makeEnv({
    AI: {
      async run() { throw new Error('inference failed'); }
    }
  });
  const { response, body } = await fetchJson(env, '/api/analyze', jsonRequest({ code: 'test', program_id: '1' }));
  assert.equal(response.status, 500);
  assert.match(body.error, /inference: inference failed/);
});

test('/api/analyze handles malformed AI output', async () => {
  const env = makeEnv({
    AI: {
      async run() { return { response: `{"finding_classes": "not-an-array"}` }; }
    }
  });
  const { response, body } = await fetchJson(env, '/api/analyze', jsonRequest({ code: 'test', program_id: '1' }));
  assert.equal(response.status, 502);
  assert.equal(body.error, 'analysis output malformed');
});

test('/api/subscribe handles stripe error', async () => {
  const env = makeEnv({ STRIPE_SECRET_KEY: 'test_key', STRIPE_PRICE_PRO: 'price_bountyscope_pro' });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('stripe error text', { status: 500 });
  
  try {
    const { response, body } = await fetchJson(env, '/api/subscribe', jsonRequest({ tier: 'pro' }));
    assert.equal(response.status, 502);
    assert.equal(body.error, 'stripe_error');
    assert.equal(body.detail, 'stripe error text');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('/api/confirm handles stripe error', async () => {
  const env = makeEnv({ STRIPE_SECRET_KEY: 'test_key' });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('error', { status: 500 });
  
  try {
    const { response, body } = await fetchJson(env, '/api/confirm', jsonRequest({ session_id: 'cs_test_123' }));
    assert.equal(response.status, 502);
    assert.equal(body.error, 'stripe_error');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
