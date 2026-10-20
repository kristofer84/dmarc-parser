# Applying records through a DNS provider API

The record generator (`services/recordSuggestions.ts`) has always produced correct values and
stopped at "copy this". This adds the one thing Cloudflare's DMARC Management does that a
copy-paste flow cannot: writing the record into the zone, with a preview and an audit trail.

Two providers are implemented:

- **Cloudflare** — JSON API, token-authenticated, `PATCH` updates.
- **Loopia** — XML-RPC (`https://api.loopia.se/RPCSERV`), username/password on every call. It
  has **no update method**, so a replacement is `removeZoneRecord` + `addZoneRecord`.

It is deliberately conservative. Read the safety rules before changing anything here.

## Credentials and provider selection

**Primary model: named accounts owned by an organisation.** Create them under *Organisation →
DNS accounts* (or `POST /api/organizations/:orgId/dns-accounts`), then pin one per domain in the
domain panel. The plan resolves: assigned account → all enabled accounts of the domain's org
(Cloudflare first, then label) → the one that holds the zone. `DnsPlan.account` names what will
be used (`null` = the legacy implicit account).

**Legacy/global credentials still work** for the `Default` organisation and for untracked
domains, and are what existing deployments keep using until they create accounts:

| Provider | Environment (wins) | Settings (`Administration → Settings → dns`) |
|---|---|---|
| Cloudflare | `CLOUDFLARE_API_TOKEN` | `dns.cloudflare.token` (secret) |
| Loopia | `LOOPIA_API_USER`, `LOOPIA_API_PASS` | `dns.loopia.username`, `dns.loopia.password` (secret) |
| Both | — | `dns.provider` = `auto` (default), `cloudflare`, or `loopia` |

- Cloudflare token scope: **Zone → DNS → Edit**, limited to the zones this instance may write
  to.
- Loopia: use an **API user** (for example `pi@loopiaapi`), not the customer login. The account
  must hold the domains. The username/password pair is sent in the XML body of **every** call;
  there is no scoped token.
- Named accounts are org-scoped: a second organisation can never borrow another tenant's
  credentials. An assigned-but-disabled account is `409 DNS_ACCOUNT_DISABLED`, not a silent
  fallthrough. A non-`Default` org with no accounts is `409 DNS_NOT_CONFIGURED`.
- In legacy mode, `auto` builds writers only for providers whose credentials exist, then uses
  the first that holds the domain. Cloudflare is tried before Loopia. Pin `dns.provider` when
  both accounts could contain the same name.
- No usable provider ⇒ `409 DNS_NOT_CONFIGURED` (or the provider-specific
  `CLOUDFLARE_NOT_CONFIGURED` / `LOOPIA_NOT_CONFIGURED` when pinned). The copy-paste path is
  unaffected.

Credentials live in the `settings` table like the mailbox password. They are never returned by
the settings API (only `isSet`) and never written to a log or an error body; provider error text
is surfaced instead.

## Plan and apply

``GET /api/domains/:name/dns/plan` — org admin (superadmin, or admin of the domain's
organisation), read-only.

```json
{
  "provider": "cloudflare | loopia",
  "account": { "id": "...", "label": "Production CF", "provider": "cloudflare" },
  "zone": { "id": "...", "name": "example.com" },
  "records": [{
    "key": "spf", "label": "SPF record", "type": "TXT", "name": "example.com",
    "value": "v=spf1 include:...",
    "current": ["v=spf1 ..."],
    "action": "create | update | unchanged | unsupported",
    "reason": "only when action is unsupported"
  }],
  "warnings": ["..."]
}
```

Optional query parameters mirror the generation form: `providers` (comma-separated ids),
`dmarcPolicy` (`none|quarantine|reject`), `mtaStsMode` (`testing|enforce`), `rua`, `ruf`.
`GET` is safe to repeat; it reads the zone and compares.

`POST /api/domains/:name/dns/apply` — org admin, body `{ "keys": ["spf","dmarc"], "overwrite": false }`.

```json
{
  "applied": [{ "key": "spf", "action": "create", "recordId": "..." }],
  "skipped": [{ "key": "dmarc", "reason": "exists|unchanged|unsupported|missing", "current": ["..."] }]
}
```

- `overwrite: false` (default) creates only. An existing value is returned under `skipped`
  with `reason: "exists"` and what is currently published.
- `overwrite: true` replaces the **one** record it can positively identify.
- The plan is **recomputed server-side** on apply. The client sends keys, never values, so a
  stale or hand-edited request cannot publish something the generator did not produce.
- Unknown key ⇒ 400 and no write. The provider chosen for the plan is reused for the write, so a
  domain that exists in two accounts cannot switch provider between the two steps.

### Safety rules the code enforces

1. **Nothing is deleted except the identified record being replaced.** Cloudflare's writer never
   sends `DELETE`. Loopia has no update call: its writer removes exactly the record id it
   matched and adds the new value. No other record at that name is touched. (Unlike the
   operator's `new-domain.py`, this app does not drop stale CAA `iodef` records.)
2. An update only targets a record of the same name/type whose content starts with the same
   `v=` tag (`v=spf1`, `v=DMARC1`, TLS-RPT's `v=TLSRPTv1`). There is no "first TXT record"
   fallback: a same-name TXT it cannot identify is refused, not replaced.
3. Cloudflare `PATCH` sends only `content`, so TTL and proxy settings survive; creates do not
   set `proxied`. Loopia replacement re-adds with the target's TTL (or 300 s) and priority 0.
4. SPF is derived from the **published** record's `include:` entries, so an apply cannot
   degrade a working record to `v=spf1 -all`. If the published record includes a host this app
   does not know, SPF is `unsupported` with a reason instead of being rewritten.
5. Every apply sets `req.audit` (`domain.dns.apply`) before writing, so a failed write is in
   the trail too. Rate limit: 10 requests/minute/route. Cloudflare timeout: 10 s; Loopia: 15 s.
6. Loopia rate-limits per minute (**Fault 429**). The client retries twice (2 s, 6 s), then
   returns `503 LOOPIA_RATE_LIMITED` with a message that says to wait. Repeated bursts can get
   the calling host refused at Loopia's edge, so do not loop applies by hand.

### What is intentionally not applicable

| Record | Why |
|---|---|
| DNSSEC **DS** | Lives at the registrar, not in the zone (true for both providers). The generator still prints it. |
| **MTA-STS** | The TXT record is only half; the policy file must be served at `https://mta-sts.<domain>/.well-known/mta-sts.txt`. |
| **CAA** | The generator's CAA suggestion is typed `TXT` (a known wart). Writing `0 issue ...` as TXT would be inert junk, so it stays copy-paste — even though Loopia's API can create `CAA` records. |
| **Autodiscover** | The generated value is a host name; the real record is a CNAME (or, at Loopia, an SRV at `_autodiscover._tcp`), not an A. |
| DKIM without a selector/value | Nothing to publish. |

These appear as `unsupported` with the reason in the plan; the UI disables them.

## Adding `rua` to the published DMARC record

`POST /api/domains/:name/dmarc/rua` — org admin. The address is the **domain organisation's
first enabled mailbox**; only the `Default` org falls back to the legacy `IMAP_USER` when it has
no mailbox rows. No address ⇒ `409 MAILBOX_NOT_CONFIGURED`.

```json
{ "value": "v=DMARC1; p=none; rua=mailto:dmarc@example.org; ruf=...", "previous": "v=DMARC1; p=none; rua=mailto:reports@example.net", "recordId": "..." }
```

- The address is the org's mailbox user (fallback: the legacy mailbox for `Default`); no body
  is accepted.
- It merges into an existing record: other tags are preserved, an existing `rua` list is
  appended to, and an address already present is not duplicated (RFC 7489: only the first
  `v=DMARC1` record is used, so only that one is touched).
- With no DMARC record it creates `v=DMARC1; p=none; rua=mailto:…`. `p=none` is a starting
  policy, not a recommendation to stay there.
- Replacing the record is provider-appropriate: Cloudflare `PATCH`; Loopia remove-then-add.
- No mailbox configured ⇒ `409 MAILBOX_NOT_CONFIGURED`.
- If the target is a **hosted plus address on a different domain** (e.g.
  `dmarc+token@xcds.net` for `example.com`), RFC 7489 §7.1 also requires
  `example.com._report._dmarc.xcds.net TXT "v=DMARC1"` on the hosted domain. The app does not
  create that delegation automatically; the returned value is the DMARC change only, and the UI
  documents the required record.
- Audit action `domain.dmarc.rua`.

## Provider details

### Cloudflare

Named accounts use the same client; the legacy account is the environment/settings token.
Base URL `https://api.cloudflare.com/client/v4`; `CLOUDFLARE_API_BASE` overrides it (tests point
it at a local stub). Zone lookup is `GET /zones?name=<domain>&status=active`, walking up to the
parent for a subdomain (bounded at five labels). Errors: `502 CLOUDFLARE_ERROR` (first Cloudflare
message), `502 CLOUDFLARE_UNREACHABLE`, `504 CLOUDFLARE_TIMEOUT`, `409 CLOUDFLARE_NOT_CONFIGURED`.

### Loopia

Named accounts use the same XML-RPC client; the legacy account is the environment/settings pair.
XML-RPC at `https://api.loopia.se/RPCSERV`. The client is in `services/loopia.ts`; no dependency
was added — it encodes/decodes the small XML-RPC subset the API uses.

- The zone is a domain in the Loopia account (`getDomains`), matched by longest suffix. Records
  live under a **subdomain**: `@` for the apex, otherwise the labels between the record name and
  the zone (`_dmarc`, `_smtp._tls`, `mailjet._domainkey` — nested labels are valid). A missing
  subdomain is created with `addSubdomain` before the record is added.
- The API has **no update call**. A replacement removes the matched `record_id` and adds the new
  value. The record id changes; the plan/apply result reports the new one.
- A record the API rejects (usually malformed rdata) comes back as `Fault`/`false` and is
  surfaced as `502 LOOPIA_ERROR`; the token/password never appears in the message.
- Rate limit: `Fault 429`; retried twice, then `503 LOOPIA_RATE_LIMITED`.
- Errors: `502 LOOPIA_ERROR`, `502 LOOPIA_UNREACHABLE`, `504 LOOPIA_TIMEOUT`,
  `409 LOOPIA_NOT_CONFIGURED`.

## Frontend

The selected-domain panel in `DomainsView.vue` has a *DNS records* card (org admins) that loads
the plan on demand, shows provider/zone, key/type/name/value/published/action, enables checkboxes
only for `create`/`update`, has an explicit "overwrite existing" toggle, and a separate *Add rua
to DMARC* button. Nothing is fetched or written until the operator asks.

## Tests

- `backend/test/dnsApply.test.ts` — Cloudflare stub; 17 tests (create/update/unchanged/
  unsupported, parent-zone walk, overwrite false/true, no-delete/unidentifiable refusal, DMARC
  `rua`, error surfacing, token never in an error).
- `backend/test/dnsAccounts.test.ts` — org account CRUD, secret redaction, provider
  immutability, cross-org 404, assigned-vs-auto selection, disabled-account error, org mailbox
  `rua`; 22 tests.
- `backend/test/loopiaDns.test.ts` — XML-RPC stub; 13 tests (plan classification, parent zone,
  missing zone as a warning, create via `addSubdomain` + `addZoneRecord`, `overwrite:false`,
  remove-then-add with only the identified id, `rua` merge and creation, 429 retry and 503,
  fault surfacing, missing credentials, auto provider selection).

Neither test touches the network or needs real credentials.
