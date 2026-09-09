# BountyScope API

This reference describes the Worker source in this repository. Use your deployed
Worker origin in place of `https://bountyscope.example` below; deployment and live
Stripe configuration are separate from source validation.

## Routes

| Method | Path | Result |
| --- | --- | --- |
| GET | `/api/programs` | Tracked programs, ranked by maximum bounty |
| GET | `/api/changes` | Tiered rolling change feed |
| POST | `/api/analyze` | AI analysis of code or a protocol description |
| GET | `/api/whoami` | Resolved tier, authentication, and analyzer usage |
| POST | `/api/subscribe` | Stripe Checkout URL |
| POST | `/api/confirm` | Confirm a paid subscription and return an API key |
| GET | `/api/status` | Program and change status |

`/api/pay-status`, USDC quotes, `quote_id`, and `tx_hash` are not part of the current
checkout HTTP contract.

## Authentication and limits

Send `Authorization: Bearer bsk_…` or `x-api-key: bsk_…` to gated endpoints.
An absent, unrecognized, or revoked key receives the free tier. Bearer keys and
Checkout session IDs should be kept private: an activated session ID can be used
to recover its existing key.

| Tier | Change feed | Analyzer |
| --- | --- | --- |
| Free | Delayed 24 hours; at most 5 events; no repository detail | 5 calls per UTC day |
| Pro | Real-time; at most 200 retained events; repository detail | No application quota |
| Team | Real-time; at most 200 retained events; repository detail | No application quota |

The Team policy allows 1,000 results, but the shared rolling log retains only
200 events (`CHANGE_LOG_CAP`). No tier can retrieve older evicted events.
The free analyzer quota uses a presented key when available, otherwise client
IP. Provider limits still apply to paid requests.

## Checkout quick start

The backend needs `STRIPE_SECRET_KEY` and the plan-specific `STRIPE_PRICE_PRO` and
`STRIPE_PRICE_TEAM`. Configure each price for the matching BountyScope plan.

```sh
curl -X POST https://bountyscope.example/api/subscribe \
  -H 'Content-Type: application/json' \
  -d '{"tier":"pro"}'
```

HTTP **200**:

```json
{
  "status": "payment_required",
  "tier": "pro",
  "checkout_url": "https://checkout.stripe.com/c/pay/cs_…"
}
```

Open `checkout_url` and complete Stripe Checkout. Stripe redirects to the app
origin with `?session_id=cs_…`. The app submits that ID to `/api/confirm`:

```sh
curl -X POST https://bountyscope.example/api/confirm \
  -H 'Content-Type: application/json' \
  -d '{"session_id":"cs_test_example"}'
```

HTTP **201**:

```json
{
  "ok": true,
  "tier": "pro",
  "api_key": "bsk_…",
  "usage": "Send this key in an Authorization or x-api-key header."
}
```

The `usage` string is explanatory. The API key is a bearer secret. Repeating
confirmation after activation returns HTTP **200**, `already_active: true`, and
the existing key.

### Subscribe

`POST /api/subscribe` accepts `{"tier":"pro"}` or `{"tier":"team"}`. The current
implementation defaults other or omitted tier values to Pro. It creates a
subscription-mode Checkout session with one item at the configured tier price.

| Status | Meaning |
| --- | --- |
| 200 | Checkout URL created; payment is still required |
| 405 | A method other than POST was used |
| 500 | Stripe secret or selected tier price is missing |
| 502 | Stripe rejected session creation (`stripe_error`) |

### Confirm

`POST /api/confirm` accepts a string `session_id` beginning with `cs_` and
containing only ASCII letters, numbers, or underscores after that prefix.
Before issuing a new key, the backend retrieves the session with expanded line
items and checks all of the following:

- Returned ID equals the requested session ID.
- Payment is `paid`, session status is `complete`, and mode is `subscription`.
- `client_reference_id` identifies Pro or Team.
- The complete line-item list contains exactly one item, quantity one, whose
  price ID equals that tier's configured BountyScope price.

A paid session for another product or a Pro price claiming Team cannot activate
access. These checks follow the fields on Stripe's
[Checkout Session object](https://docs.stripe.com/api/checkout/sessions/object)
and its [expanded line-item retrieval](https://docs.stripe.com/checkout/fulfillment).

| Status | Meaning |
| --- | --- |
| 201 | New key issued |
| 200 | Session already activated; existing key returned |
| 400 | Missing/malformed session ID or `invalid_checkout_session` |
| 402 | Payment/session completion is not confirmed (`payment_not_completed`) |
| 405 | A method other than POST was used |
| 500 | Stripe secret is missing |
| 502 | Stripe session retrieval failed (`stripe_error`) |

Existing activated keys are not retroactively revalidated. The source currently
does not enforce subscription renewals, cancellation, or refunds with webhooks.
KV-based confirmation provides sequential retry behavior; it is not a transaction
that guarantees a single issuance across concurrent distributed requests.

## Programs and changes

`GET /api/programs` returns `count`, `programs`, and an explanatory `note`. Programs include
`id`, `name`, `url`, `source`, `max_bounty_usd`, `ecosystem`, `in_scope_repos`, and
status/timestamp fields where available. The endpoint seeds the curated program
list when storage is empty.

```sh
curl https://bountyscope.example/api/changes \
  -H 'Authorization: Bearer bsk_your_key'
```

The change response includes `tier`, `real_time`, `delay_hours`, `count`,
`total_visible`, and `changes`. Free responses also expose `hidden_by_delay`,
`capped`, and an explanatory `note`. A change includes program ID/name/URL,
source, bounty amount where available, and `changed_at`. Paid results can include
`in_scope_repos`.

Scheduled checks compare Last-Modified or ETag headers using HEAD requests.
They do not perform repository diffs. A first observed fingerprint establishes
the baseline; a subsequent different fingerprint creates a change event.

## Analysis

```sh
curl -X POST https://bountyscope.example/api/analyze \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer bsk_your_key' \
  -d '{"code":"contract Example {}", "program_id":"example", "repo_url":"https://example.com/repo"}'
```

Provide `code` or `description`; optional fields are `program_id` (default
`ad-hoc`) and `repo_url`. Input is limited to 60,000 characters. HTTP 200 returns
`id`, `program_id`, optional `repo_url`, `finding_classes`,
`attack_surface_summary`, `recommended_focus`, and `generated_at`. Reports are
stored for 30 days; this API does not expose a report-by-ID route.

Invalid JSON, empty input, or oversized input returns 400. Free quota exhaustion
returns 402 with `quota_exceeded`, `used`, and `limit`. Unsupported methods return
405; inference failure returns 500 and malformed analysis output returns 502.

## Account and status

`GET /api/whoami` returns `tier`, `authenticated`, `key_present`,
`analyze_used_today`, `analyze_limit` (`null` for paid tiers),
`changes_real_time`, and `issued_at`.

`GET /api/status` exposes program/change counts and status metadata. The current
main implementation's `last_cron_at` is derived from program timestamps, including
seeding, so it is not proof that a scheduled run completed. The status/dashboard
repair is tracked in PR #11; API consumers should treat missing or unverified
cron/usage measurements as unknown.
