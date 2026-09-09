import { assert, expect, test } from 'vitest';

import worker from '../src/index.ts';

const BASE_URL = 'https://bountyscope.test';
const PROGRAMS_KEY = 'programs:list';
const CHANGES_KEY = 'changes:log';

class MemoryKV {
  constructor(seed = {}) {
    this.store = new Map(Object.entries(seed));
    this.puts = [];
    this.deletes = [];
  }

  async get(key) {
    return this.store.has(key) ? this.store.get(key) : null;
  }

  async put(key, value, options) {
    const stringValue = String(value);
    this.store.set(key, stringValue);
    this.puts.push({ key, value: stringValue, options });
  }

  async delete(key) {
    this.store.delete(key);
    this.deletes.push(key);
  }

  async list(options = {}) {
    const prefix = options.prefix ?? '';
    const limit = options.limit ?? 1000;
    const start = options.cursor ? Number(options.cursor) : 0;
    const matches = [...this.store.keys()]
      .filter(key => key.startsWith(prefix))
      .sort();
    const page = matches.slice(start, start + limit);
    const next = start + page.length;

    return {
      keys: page.map(name => ({ name })),
      list_complete: next >= matches.length,
      cursor: next >= matches.length ? undefined : String(next),
    };
  }

  json(key) {
    const value = this.store.get(key);
    return value == null ? null : JSON.parse(value);
  }

  keys(prefix = '') {
    return [...this.store.keys()].filter(key => key.startsWith(prefix));
  }
}

function analysisPayload() {
  return {
    finding_classes: [
      {
        class: 'reentrancy',
        locations: ['withdraw'],
        severity: 'high',
        rationale: 'External call happens before state is reduced.',
      },
    ],
    attack_surface_summary: 'The vault exposes an externally callable withdraw flow.',
    recommended_focus: ['withdraw'],
  };
}


function makeEnv(overrides = {}) {
  const aiCalls = [];
  const assetRequests = [];

  const env = {
    AI: {
      async run(model, input) {
        aiCalls.push({ model, input });
        return { response: `\`\`\`json\n${JSON.stringify(analysisPayload())}\n\`\`\`` };
      },
    },
    ASSETS: {
      async fetch(req) {
        assetRequests.push(req);
        return new Response('asset response', { status: 200, headers: { 'x-asset': 'hit' } });
      },
    },
    BS_PROGRAMS: new MemoryKV(),
    BS_REPORTS: new MemoryKV(),
    USER_AGENT: 'BountyScope test bot',
    STRIPE_SECRET_KEY: 'test_sk_123',
    STRIPE_PRICE_PRO: 'price_bountyscope_pro',
    STRIPE_PRICE_TEAM: 'price_bountyscope_team',
    ...overrides,
  };

  return { env, aiCalls, assetRequests };
}

async function fetchWorker(env, path, init) {
  return worker.fetch(new Request(`${BASE_URL}${path}`, init), env);
}

async function fetchJson(env, path, init) {
  const response = await fetchWorker(env, path, init);
  return { response, body: await response.json() };
}

function jsonRequest(body, init = {}) {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    body: JSON.stringify(body),
    ...init,
  };
}

function changeEvent(index, ageHours) {
  return {
    program_id: `program-${index}`,
    name: `Program ${index}`,
    url: `https://example.test/program-${index}`,
    source: 'immunefi',
    max_bounty_usd: 100_000 + index,
    in_scope_repos: [`https://github.com/example/program-${index}`],
    changed_at: new Date(Date.now() - ageHours * 60 * 60 * 1000).toISOString(),
  };
}

async function runScheduled(env) {
  const waits = [];
  await worker.scheduled({}, env, {
    waitUntil(promise) {
      waits.push(promise);
    },
  });
  await Promise.all(waits);
}

test('GET /api/programs seeds the registry and returns programs sorted by bounty', async () => {
  const { env } = makeEnv();

  const { response, body } = await fetchJson(env, '/api/programs');

  assert.equal(response.status, 200);
  assert.equal(body.count, 10);
  assert.equal(body.programs[0].id, 'imm-uniswap');
  assert.deepEqual(
    body.programs.map(program => program.max_bounty_usd),
    [...body.programs.map(program => program.max_bounty_usd)].sort((a, b) => b - a),
  );

  const stored = env.BS_PROGRAMS.json(PROGRAMS_KEY);
  assert.equal(stored.length, 10);
  assert.ok(stored.every(program => program.last_seen_at));

  const status = await fetchJson(env, '/api/status');
  assert.equal(status.body.name, 'BountyScope');
  assert.equal(status.body.program_count, 10);
  assert.equal(status.body.recent_changes, 0);
});

test('GET /api/changes applies the free delay/cap and unlocks real-time repo detail for paid keys', async () => {
  const { env } = makeEnv();
  const changes = [
    changeEvent(0, 1),
    ...Array.from({ length: 7 }, (_, index) => changeEvent(index + 1, 48 + index)),
  ];
  await env.BS_PROGRAMS.put(CHANGES_KEY, JSON.stringify(changes));
  await env.BS_REPORTS.put('key:pro-key', JSON.stringify({
    tier: 'pro',
    quote_id: 'quote-pro',
    issued_at: '2026-06-19T00:00:00.000Z',
  }));

  const free = await fetchJson(env, '/api/changes');

  assert.equal(free.response.status, 200);
  assert.equal(free.body.tier, 'free');
  assert.equal(free.body.real_time, false);
  assert.equal(free.body.count, 5);
  assert.equal(free.body.total_visible, 7);
  assert.equal(free.body.hidden_by_delay, 1);
  assert.equal(free.body.capped, true);
  assert.equal(free.body.changes[0].program_id, 'program-1');
  assert.equal(free.body.changes[0].in_scope_repos, undefined);

  const paid = await fetchJson(env, '/api/changes', { headers: { 'x-api-key': 'pro-key' } });

  assert.equal(paid.response.status, 200);
  assert.equal(paid.body.tier, 'pro');
  assert.equal(paid.body.real_time, true);
  assert.equal(paid.body.count, 8);
  assert.equal(paid.body.changes[0].program_id, 'program-0');
  assert.deepEqual(paid.body.changes[0].in_scope_repos, ['https://github.com/example/program-0']);
  assert.equal(paid.body.hidden_by_delay, undefined);
});

test('GET /api/status returns coverage without enumerating private usage records', async () => {
  const { env } = makeEnv();
  await env.BS_PROGRAMS.put(PROGRAMS_KEY, JSON.stringify([
    {
      id: 'program-a',
      source: 'immunefi',
      name: 'Program A',
      url: 'https://example.test/a',
      max_bounty_usd: 100_000,
      ecosystem: 'ethereum',
      in_scope_repos: ['https://github.com/example/a'],
      status: 'live',
      last_seen_at: '2026-06-20T10:00:00.000Z',
      last_changed_at: '2026-06-20T11:00:00.000Z',
    },
    {
      id: 'program-b',
      source: 'sherlock',
      name: 'Program B',
      url: 'https://example.test/b',
      max_bounty_usd: 250_000,
      ecosystem: 'solana',
      in_scope_repos: ['https://github.com/example/b'],
      status: 'paused',
      last_seen_at: '2026-06-20T10:30:00.000Z',
    },
  ]));
  await env.BS_PROGRAMS.put(CHANGES_KEY, JSON.stringify([changeEvent(1, 2), changeEvent(2, 200)]));
  await env.BS_REPORTS.put('report:a', '{}');
  await env.BS_REPORTS.put('report:b', '{}');
  await env.BS_REPORTS.put('sub:quote-pro', JSON.stringify({ tier: 'pro' }));
  await env.BS_REPORTS.put('sub:quote-team', JSON.stringify({ tier: 'team' }));
  await env.BS_REPORTS.put('key:pro-key', JSON.stringify({ tier: 'pro' }));
  await env.BS_REPORTS.put('pending:quote-pending', JSON.stringify({ tier: 'pro' }));
  const today = new Date().toISOString().slice(0, 10);
  await env.BS_REPORTS.put(`quota:${today}:ip:203.0.113.1`, '3');
  await env.BS_REPORTS.put(`quota:${today}:ip:203.0.113.2`, '2');
  env.BS_REPORTS.get = env.BS_REPORTS.list = () => { throw new Error('public status must not read account usage'); };
  env.BS_PROGRAMS.list = () => { throw new Error('public status must not enumerate namespaces'); };

  const { response, body } = await fetchJson(env, '/api/status');

  assert.equal(response.status, 200);
  assert.equal(body.name, 'BountyScope');
  assert.equal(body.program_count, 2);
  assert.equal(body.recent_changes, 1);
  assert.equal(body.logged_changes, 2);
  assert.equal(body.last_cron_at, null);
  assert.equal(body.programs.live, 1);
  assert.equal(body.programs.paused, 1);
  assert.equal(body.programs.total_max_bounty_usd, 350_000);
  assert.equal(body.programs.top_program.id, 'program-b');
  assert.deepEqual(body.programs.sources, { immunefi: 1, sherlock: 1 });
  assert.deepEqual(body.programs.ecosystems, { ethereum: 1, solana: 1 });
  assert.equal(body.programs.in_scope_repo_count, 2);
  assert.equal(body.changes.total_logged, 2);
  assert.equal(body.changes.last_24h, 1);
  assert.equal(body.changes.last_7d, 1);
  assert.equal(body.usage.available, false);
  for (const [field, value] of Object.entries(body.usage)) {
    if (field !== 'available') assert.equal(value, null);
  }
});

test('public status is read-only on empty storage and does not fabricate a cron receipt', async () => {
  const { env } = makeEnv();
  const reads = [];
  const get = env.BS_PROGRAMS.get.bind(env.BS_PROGRAMS);
  env.BS_PROGRAMS.get = key => { reads.push(key); return get(key); };
  const { body } = await fetchJson(env, '/api/status');
  assert.equal(body.program_count, 0);
  assert.equal(body.last_cron_at, null);
  assert.deepEqual(reads.sort(), ['changes:log', 'cron:last_completed_at', 'programs:list']);
  assert.deepEqual(env.BS_PROGRAMS.puts, []);
  assert.deepEqual(env.BS_REPORTS.puts, []);
  await fetchJson(env, '/api/programs');
  assert.equal((await fetchJson(env, '/api/status')).body.last_cron_at, null);
});

test('POST /api/analyze validates input, persists reports, and enforces the free daily quota', async () => {
  const { env, aiCalls } = makeEnv();
  const request = {
    ...jsonRequest({
      code: 'contract Vault { function withdraw() external {} }',
      program_id: 'vault',
      repo_url: 'https://github.com/example/vault',
    }),
    headers: {
      'content-type': 'application/json',
      'cf-connecting-ip': '203.0.113.7',
    },
  };

  const invalid = await fetchJson(env, '/api/analyze', jsonRequest({}));
  assert.equal(invalid.response.status, 400);
  assert.equal(invalid.body.error, 'missing code or description');

  const first = await fetchJson(env, '/api/analyze', request);
  assert.equal(first.response.status, 200);
  assert.equal(first.body.program_id, 'vault');
  assert.equal(first.body.repo_url, 'https://github.com/example/vault');
  assert.equal(first.body.finding_classes[0].class, 'reentrancy');
  assert.match(first.body.id, /^[0-9a-f-]{36}$/i);

  const reportKeys = env.BS_REPORTS.keys('report:');
  assert.equal(reportKeys.length, 1);
  assert.deepEqual(env.BS_REPORTS.json(reportKeys[0]).recommended_focus, ['withdraw']);
  assert.equal(aiCalls.length, 1);
  assert.equal(aiCalls[0].model, '@cf/meta/llama-3.3-70b-instruct-fp8-fast');
  assert.match(aiCalls[0].input.messages[1].content, /Program: vault/);

  for (let i = 0; i < 4; i += 1) {
    const next = await fetchJson(env, '/api/analyze', request);
    assert.equal(next.response.status, 200);
  }

  const overQuota = await fetchJson(env, '/api/analyze', request);
  assert.equal(overQuota.response.status, 402);
  assert.equal(overQuota.body.error, 'quota_exceeded');
  assert.equal(overQuota.body.used, 5);
  assert.equal(overQuota.body.limit, 5);
  assert.equal(aiCalls.length, 5);
});

test('paid analyzer calls are authenticated by API key and are not free-quota limited', async () => {
  const { env, aiCalls } = makeEnv();
  await env.BS_REPORTS.put('key:team-key', JSON.stringify({
    tier: 'team',
    quote_id: 'quote-team',
    issued_at: '2026-06-19T00:00:00.000Z',
  }));

  for (let i = 0; i < 6; i += 1) {
    const result = await fetchJson(env, '/api/analyze', jsonRequest(
      { description: `protocol note ${i}` },
      { headers: { authorization: 'Bearer team-key' } },
    ));
    assert.equal(result.response.status, 200);
    assert.equal(result.body.program_id, 'ad-hoc');
  }

  assert.equal(aiCalls.length, 6);
  assert.equal(env.BS_REPORTS.keys('quota:').length, 0);

  const whoami = await fetchJson(env, '/api/whoami', { headers: { authorization: 'Bearer team-key' } });
  assert.equal(whoami.body.tier, 'team');
  assert.equal(whoami.body.authenticated, true);
  assert.equal(whoami.body.analyze_limit, null);
  assert.equal(whoami.body.changes_real_time, true);
});

for (const tier of ['pro', 'team']) {
test(`subscription checkout for ${tier} mints an API key and is idempotent`, async () => {
  const { env } = makeEnv();
  const originalFetch = globalThis.fetch;
  const stripeCalls = [];

  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    stripeCalls.push({ url, method: init?.method, body: init?.body });
    
    if (url.includes('/checkout/sessions') && init?.method === 'POST') {
      return Response.json({
        id: 'cs_test_123',
        url: 'https://checkout.stripe.com/pay/cs_test_123'
      });
    }
    
    if (url.includes('/checkout/sessions/cs_test_123') && init?.method !== 'POST') {
      return Response.json({
        id: 'cs_test_123',
        payment_status: 'paid',
        status: 'complete',
        mode: 'subscription',
        client_reference_id: tier,
        line_items: { has_more: false, data: [{ quantity: 1, price: { id: `price_bountyscope_${tier}` } }] },
        amount_total: 19900
      });
    }

    return new Response('not found', { status: 404 });
  };

  try {
    const subscribe = await fetchJson(env, '/api/subscribe', jsonRequest({ tier }));

    assert.equal(subscribe.response.status, 200);
    assert.equal(subscribe.body.status, 'payment_required');
    assert.equal(subscribe.body.tier, tier);
    assert.equal(subscribe.body.checkout_url, 'https://checkout.stripe.com/pay/cs_test_123');

    const missingFields = await fetchJson(env, '/api/confirm', jsonRequest({}));
    assert.equal(missingFields.response.status, 400);
    assert.equal(missingFields.body.error, 'session_id required');

    const confirm = await fetchJson(env, '/api/confirm', jsonRequest({
      session_id: 'cs_test_123',
    }));

    assert.equal(confirm.response.status, 201);
    assert.equal(confirm.body.ok, true);
    assert.equal(confirm.body.tier, tier);
    const lookup = stripeCalls.find(call => call.method !== 'POST');
    assert.equal(new URL(lookup.url).searchParams.get('expand[]'), 'line_items');
    assert.match(confirm.body.api_key, /^bsk_[0-9a-f]{48}$/);

    const whoami = await fetchJson(env, '/api/whoami', {
      headers: { authorization: `Bearer ${confirm.body.api_key}` },
    });
    assert.equal(whoami.body.tier, tier);
    assert.equal(whoami.body.authenticated, true);
    assert.equal(whoami.body.key_present, true);

    const repeat = await fetchJson(env, '/api/confirm', jsonRequest({
      session_id: 'cs_test_123',
    }));
    assert.equal(repeat.response.status, 200);
    assert.equal(repeat.body.already_active, true);
    assert.equal(repeat.body.api_key, confirm.body.api_key);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
}

for (const [name, invalidFields] of [
  ['another product price', { line_items: { has_more: false, data: [{ quantity: 1, price: { id: 'price_other_product' } }] } }],
  ['a Pro price claiming Team', { line_items: { has_more: false, data: [{ quantity: 1, price: { id: 'price_bountyscope_pro' } }] } }],
  ['a different session ID', { id: 'cs_test_other' }],
  ['a one-time payment', { mode: 'payment' }],
  ['an unknown tier', { client_reference_id: 'other' }],
  ['an absent tier', { client_reference_id: null }],
  ['an unexpanded price', { line_items: { has_more: false, data: [{ quantity: 1, price: 'price_bountyscope_team' }] } }],
  ['an incomplete item page', { line_items: { has_more: true, data: [{ quantity: 1, price: { id: 'price_bountyscope_team' } }] } }],
  ['multiple line items', { line_items: { has_more: false, data: [{ quantity: 1, price: { id: 'price_bountyscope_team' } }, { quantity: 1, price: { id: 'price_other' } }] } }],
  ['a missing line item', { line_items: null }],
  ['a zero quantity', { line_items: { has_more: false, data: [{ quantity: 0, price: { id: 'price_bountyscope_team' } }] } }],
]) {
  test(`confirm refuses ${name} without issuing an API key`, async () => {
    const { env } = makeEnv();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => Response.json({
      id: 'cs_test_123', payment_status: 'paid', status: 'complete', mode: 'subscription',
      client_reference_id: 'team',
      line_items: { has_more: false, data: [{ quantity: 1, price: { id: 'price_bountyscope_team' } }] },
      ...invalidFields,
    });
    try {
      const result = await fetchJson(env, '/api/confirm', jsonRequest({ session_id: 'cs_test_123' }));
      assert.equal(result.response.status, 400);
      assert.equal(result.body.error, 'invalid_checkout_session');
      assert.equal(env.BS_REPORTS.puts.length, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
}

for (const [paymentStatus, status] of [['unpaid', 'complete'], ['paid', 'open'], ['paid', 'expired']]) {
  test(`confirm requires completed payment (${paymentStatus}/${status})`, async () => {
    const { env } = makeEnv();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => Response.json({
      id: 'cs_test_123', payment_status: paymentStatus, status, mode: 'subscription',
      client_reference_id: 'team',
      line_items: { has_more: false, data: [{ quantity: 1, price: { id: 'price_bountyscope_team' } }] },
    });
    try {
      const result = await fetchJson(env, '/api/confirm', jsonRequest({ session_id: 'cs_test_123' }));
      assert.equal(result.response.status, 402);
      assert.equal(env.BS_REPORTS.puts.length, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
}

test('confirm rejects malformed session IDs before a Stripe lookup', async () => {
  const { env } = makeEnv();
  const originalFetch = globalThis.fetch;
  let stripeCalls = 0;
  globalThis.fetch = async () => { stripeCalls += 1; return Response.json({}); };
  try {
    for (const sessionId of [123, {}, 'cs_test_123/line_items', 'cs_test_123?expand[]=customer', 'other']) {
      const result = await fetchJson(env, '/api/confirm', jsonRequest({ session_id: sessionId }));
      assert.equal(result.response.status, 400);
    }
    assert.equal(stripeCalls, 0);
    assert.equal(env.BS_REPORTS.puts.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('subscribe requires an explicit price for the selected tier', async () => {
  const { env } = makeEnv({ STRIPE_PRICE_TEAM: undefined });
  const originalFetch = globalThis.fetch;
  let stripeCalls = 0;
  globalThis.fetch = async () => { stripeCalls += 1; return Response.json({}); };
  try {
    const result = await fetchJson(env, '/api/subscribe', jsonRequest({ tier: 'team' }));
    assert.equal(result.response.status, 500);
    assert.equal(result.body.error, 'Stripe price is not configured for this tier.');
    assert.equal(stripeCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('scheduled cron seeds programs, stores HEAD fingerprints, and logs later changes', async () => {
  const { env } = makeEnv();
  const originalFetch = globalThis.fetch;
  const etags = new Map();
  const calls = [];

  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    calls.push({ url, method: init?.method, userAgent: init?.headers?.['User-Agent'] });
    return new Response(null, {
      status: 200,
      headers: { etag: etags.get(url) ?? '"v1"' },
    });
  };

  try {
    await runScheduled(env);

    const completedAt = env.BS_PROGRAMS.store.get('cron:last_completed_at');
    assert.ok(Number.isFinite(Date.parse(completedAt)));
    assert.equal((await fetchJson(env, '/api/status')).body.last_cron_at, completedAt);

    assert.equal(env.BS_PROGRAMS.json(PROGRAMS_KEY).length, 10);
    assert.equal(env.BS_PROGRAMS.json(CHANGES_KEY), null);
    assert.equal(env.BS_PROGRAMS.store.get('head:imm-aave'), '"v1"');
    assert.equal(calls.length, 10);
    assert.ok(calls.every(call => call.method === 'HEAD'));
    assert.ok(calls.every(call => call.userAgent === 'BountyScope test bot'));

    etags.set('https://immunefi.com/bounty/aave/', '"v2"');
    await runScheduled(env);

    const log = env.BS_PROGRAMS.json(CHANGES_KEY);
    assert.equal(log.length, 1);
    assert.equal(log[0].program_id, 'imm-aave');
    assert.equal(log[0].name, 'Aave Protocol');
    assert.deepEqual(log[0].in_scope_repos, ['https://github.com/aave-dao/aave-v3-origin']);

    const aave = env.BS_PROGRAMS.json(PROGRAMS_KEY).find(program => program.id === 'imm-aave');
    assert.ok(aave.last_changed_at);
    assert.equal(env.BS_PROGRAMS.store.get('head:imm-aave'), '"v2"');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('failed scheduled persistence never creates or advances the completion receipt', async () => {
  for (const previous of [null, '2026-06-20T00:00:00.000Z']) {
    const { env } = makeEnv();
    if (previous) env.BS_PROGRAMS.store.set('cron:last_completed_at', previous);
    env.BS_PROGRAMS.put = () => { throw new Error('storage unavailable'); };
    await expect(runScheduled(env)).rejects.toThrow('storage unavailable');
    assert.equal((await fetchJson(env, '/api/status')).body.last_cron_at, previous);
  }
});

test('unknown routes fall through to the static asset binding', async () => {
  const { env } = makeEnv();

  const response = await fetchWorker(env, '/');

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-asset'), 'hit');
  assert.equal(await response.text(), 'asset response');
});

test('GET /dashboard serves the static dashboard asset', async () => {
  const { env, assetRequests } = makeEnv();

  const response = await fetchWorker(env, '/dashboard');

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-asset'), 'hit');
  assert.equal(new URL(assetRequests[0].url).pathname, '/dashboard.html');
});
