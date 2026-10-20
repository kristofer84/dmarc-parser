# `docs/` — annotated index

> Same convention as `../borbot/docs/`: each entry says what the document is *for* and what it
> concluded, so the line can be read before the file is opened.

## Reference

- `dictionary.md` — the long-form vocabulary of DMARC, SPF, DKIM, reporting and this app's own
  concepts, with RFC citations and worked examples. The in-app page
  (`frontend/src/views/GlossaryView.vue`, fed by `frontend/src/data/glossary.ts`) is the
  condensed version; **the data file is edited first** and this document follows it. Where a
  check does not exist in this codebase (PTR lookups, public-suffix/organisational-domain logic,
  alignment computation, ARC parsing), the entry says so rather than describing what a receiver
  does as if the app did it.
- `where-things-live.md` — the concern → file map. Read the matching row before changing a
  domain; it carries the gotchas that have already cost time once.
- `nis2.md` — what NIS2 asks of an *organisation*, why this repo is not an in-scope entity but
  its users are, the clause-by-clause mapping of what the code does and does not provide, the
  data inventory (what is stored, where, and the retention knob for it), and the evidence an
  operator can actually hand an auditor. Read the "what this project does not do" section before
  quoting anything from it.
- `tenancy.md` — organisations, memberships (`admin`/`viewer`), the active-organisation header,
  the single `getDomainScope()` invariant, domain claim-once and quarantine-on-collision, per-org
  mailboxes and ingestion, org-owned DNS accounts, organisation/member APIs, the
  Default-organisation migration, and the UI. This is the page to read before touching any
  query that returns report data.
- `cloudflare-parity.md` — the comparison against Cloudflare DMARC Management (beta) that
  motivated the source-analytics, DNS-apply and alerting work, the feature table, and what was
  deliberately **not** copied (hosted mailbox, silent record edits, email alerts). Read the
  date/version note before treating the Cloudflare column as current.
- `analytics.md` — what a "source" is, the exact DMARC-pass rule (`policy_evaluated` SPF or DKIM,
  alignment never recomputed), how ranges are anchored on `Report.endDate`, the `/api/sources`,
  `/api/summary`, `/api/reports?sourceIp=` and `/api/domains/:name/ingest` shapes, and why
  pre-existing reports cannot be backfilled with the newly stored policy/auth fields.
- `dns-apply.md` — writing generated records through a DNS provider API: Cloudflare (token) and
  Loopia (XML-RPC, username/password), provider selection via `dns.provider`, plan/apply
  semantics, the no-unrelated-delete and same-`v=`-tag update rules, Loopia's remove-then-add
  replacement and Fault 429 handling, which records are intentionally unsupported, the DMARC
  `rua` merge, and the audit/error surface. Read the safety rules before touching
  `services/dnsApply.ts` or `services/loopia.ts`.
- `alerts.md` — the two findings (new sender, failure spike), their 24-hour `endDate` window, the
  first-import guard, dedup/cooldown keys, the 15-minute scan, in-app acknowledgement and the
  best-effort webhook. Also lists what it does not do (no retention prune, no email, no
  cross-domain dedup).

## Elsewhere in the repo

- `../SECURITY.md` — how to report a vulnerability, what is in scope, what the code already
  enforces (verified per file), and how to verify a published image and its SBOM.
- `../deploy/README.md` — the deployment runbook, including backup/restore and the restore drill
  (§6–§8) and how retention interacts with backups (§9).
- `../README.md` — what the app is, how to run it, and the environment variables.
- `../dmarc-report-viewer-spec.md` — the original feature spec; useful for intent, not for
  current behaviour.
