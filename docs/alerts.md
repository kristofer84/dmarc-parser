# Alerts: new senders and failure spikes

An alert is a **finding worth a look**, not a real-time event. A recurring scan reads the reports
already stored and records two kinds of finding; nothing is evaluated per arriving message.

## The two findings

Both look back over the same **24-hour window**, measured on the report period (`Report.endDate`),
not ingestion time — a report can arrive days after the period it describes.

### `new_source`

A source IP that has never sent mail for that domain before, and whose first report falls inside
the lookback.

**First-import guard:** only domains with at least one report *older than* the lookback are
scanned. Without it, importing a domain's history would produce one alert per historical sender
at once — the noise that makes an operator stop reading alerts.

`dedupKey = new_source:<domain>:<sourceIp>` — a sender is announced once, ever.

Severity: `info`.

### `failure_spike`

For each domain, over the lookback:

```
messages >= alerts.minMessages
AND 100 * failures / messages >= alerts.failureSpikePercent     (default 50 / 20%)
```

`failures` = messages where **both** policy-evaluated checks failed (`spf !== 'pass' &&
dkim !== 'pass'`), the same rule as `/api/sources` and the dashboard (`isDmarcPass`).

`dedupKey = failure_spike:<domain>:<floor(now / cooldownMs)>` — re-running inside the cooldown
is a database no-op (unique index), and the finding can reappear after it. The cooldown comes
from `alerts.cooldownHours` (default 12 h).

Severity: `critical` at ≥ 50% failure, otherwise `warning`.

## Scan and delivery

The scan (`evaluateAlerts()` in `services/alerts.ts`) runs:

- 60 seconds after start (after the first mail cycle),
- then every 15 minutes,
- only when `alerts.enabled` is true (read every tick, so it can be switched off without a
  restart).

It returns `{ created, delivered, errors }` and is logged as one line. It never throws out: a
broken domain or a dead webhook increments a counter and the rest of the scan continues.

### In-app

Every finding is a row in the `alerts` table. `/alerts` shows open/all, severity, domain, kind,
source IP, detail and time; an administrator can acknowledge. Acknowledging is idempotent — a
second click or a retry keeps the first timestamp and actor. Nothing else mutates a row; there is
no delete and no edit, so the finding stays as evidence.

### Webhook (optional)

If `alerts.webhookUrl` is set (https only, validated by the settings layer), each **new** alert is
POSTed once:

```json
{
  "kind": "new_source | failure_spike",
  "severity": "info | warning | critical",
  "domain": "example.com",
  "sourceIp": "203.0.113.5",
  "title": "New sender 203.0.113.5 for example.com",
  "detail": { "...": "numbers behind the finding" },
  "createdAt": "2026-10-20T10:00:00.000Z"
}
```

5-second timeout. A non-2xx response or a network failure is logged and **not retried**; the
in-app alert is the record, the webhook is a convenience. `deliveredAt` is set only on a 2xx.

There is deliberately **no email delivery**: this app has no SMTP configuration, and adding one
would mean another credential to hold. A webhook covers Slack/ntfy/automation without that.

**Trust note:** the webhook URL is administrator-configured and the app will POST to it from
inside the container. Point it at an endpoint you control; `https` is enforced but the host is
not restricted, so an administrator can deliberately (or accidentally) reach an internal HTTPS
service. That is the same trust level as the Cloudflare API token, which is why both are
admin-only.

## API

`GET /api/alerts?status=open|acknowledged|all&range=7d|30d|90d|all&limit=100`

- Auth required; domain-scoped (`null` = all, `[]` = nothing assigned).
- Filters unknown values fall back to defaults (`open`, `all`) rather than erroring.
- `detail` is parsed from its stored JSON to an object; unreadable text becomes `null`.
- Newest first; `total` counts everything the filters match, not only the returned page.
- `limit` clamped to 1..500 (default 100).

`POST /api/alerts/:id/ack` — administrator only, 404 for an unknown or out-of-scope id (never
403, so ids cannot be probed). Audit action `alert.acknowledge`, with
`detail.alreadyAcknowledged` when it was a no-op.

## Settings

| Key | Default | Meaning |
|---|---|---|
| `alerts.enabled` | `true` | Run the scan at all |
| `alerts.failureSpikePercent` | `20` | Failure share that counts as a spike |
| `alerts.minMessages` | `50` | Volume floor, so a tiny domain cannot alarm on one message |
| `alerts.cooldownHours` | `12` | How long before the same spike can be recorded again |
| `alerts.webhookUrl` | empty | Optional HTTPS POST target |

## What this does not do

- **No retention/pruning.** Alerts are small rows with no third-party content and are kept until
  acknowledged or deleted from the database. The report data behind them is pruned by the normal
  `data.*` retention rules, so an old alert may reference reports that no longer exist.
- **No per-user subscriptions or email.** One feed for the instance.
- **No alert on missing reports** (silence is covered by the health endpoint instead).
- **No cross-domain dedup**: the same sender appearing for two domains produces one alert per
  domain, which is intentional — the operator acts per domain.

## Tests

`backend/test/alerts.test.ts` — temp database, seeded reports/records, two scans (idempotence),
both kinds, the first-import guard, webhook success/failure via a local stub, HTTP filtering,
scoping, acknowledgement idempotence and audit, and `alerts.enabled=false`. 13 tests.
