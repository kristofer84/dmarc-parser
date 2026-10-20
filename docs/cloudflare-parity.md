# Cloudflare DMARC Management: what we compare to, and what was built

Cloudflare's **DMARC Management (beta)** is a narrow, zero-ops product: for apex domains on
Cloudflare DNS it appends a Cloudflare-hosted `rua` address to your DMARC record, lets you
create/edit SPF, DKIM and DMARC records in-zone (with an SPF >10-lookup warning), and shows a
30-day volume graph with top senders and per-source SPF/DKIM/DMARC outcomes. Aggregate reports
only. It is free and requires no infrastructure.

This page records the comparison that motivated the parity work, and what was implemented.
It was written against Cloudflare's documentation (`developers.cloudflare.com/dmarc-management`,
last updated 2026-05-05, beta). If their product changes, re-read their docs; do not treat this
page as current for Cloudflare.

## Feature comparison

| Capability | This app | Cloudflare DMARC Mgmt |
|---|---|---|
| Aggregate (rua) ingestion | IMAP mailbox you own | Cloudflare-hosted mailbox |
| Forensic (ruf) | Yes: headers/body/raw, report-mail authentication | No |
| TLS-RPT (RFC 8460) | Yes, mail + HTTPS collector | No |
| DNS checks | MX, SOA, SPF (10-lookup trace), DMARC, DKIM, MTA-STS, TLS-RPT, BIMI, autodiscover, CAA, DNSSEC/DS | SPF lookup count only |
| Applies DNS records | Yes, Cloudflare or Loopia: create/replace with preview, no unrelated deletes | Yes, SPF/DKIM/DMARC in-zone |
| DNS provider | Any; writes to Cloudflare or Loopia | Cloudflare DNS only |
| Domain scope | Any domain, apex or subdomain | Apex domains only |
| Source analytics | Sources view: totals, pass rates, dispositions, drill-down, ranges | Top 10 + all sources, ≤30 days, per-source detail |
| DMARC pass rate | Yes (policy-evaluated rule) | Yes, per source |
| Ingest verification | `rua`/`ruf` + "reports arrived in 30 days" | Implicit (Cloudflare runs the mailbox) |
| Alerts | New sender + failure spike, in-app + webhook | Not documented |
| Multi-user / domain scoping | Yes | Cloudflare account ACLs only |
| Audit trail | Yes, export + SHA-256 digest | No |
| Retention policies | Per dataset, with delete preview | No |
| Ops burden | Container, TLS, mailbox, backups | Zero |
| Cost | Your infrastructure | Free |
| Data location | Your SQLite volume | Cloudflare |

### Where Cloudflare is genuinely better

1. **Setup.** One click creates a working `rua` mailbox and edits the DMARC record. Here you
   configure IMAP and publish `rua` yourself (the ingest card now makes that concrete).
2. **It fixes what it finds** — through Cloudflare's own API. This app now does that too, but
   only for Cloudflare zones, and with more confirmation steps.
3. **Zero operations.** No host, disk, certificate, backup or upgrade.
4. **Source-first navigation.** The new `/sources` view closes most of this gap.

### Where this app is ahead

- RUF and TLS-RPT: Cloudflare can say *that* a source failed; this app can show the failing
  message and whether an MTA-STS policy is safe to enforce.
- It **checks** the DNS rather than assuming it, including DNSSEC/DS verification and
  silent-change detection with per-domain history.
- Multi-user scoping, an append-only audit trail, retention controls, SSO/passkeys and
  processing logs that record what could not be parsed.
- Data ownership: reports never leave the instance.

## What was built (the six gaps)

| # | Gap | Implemented | Reference |
|---|---|---|---|
| 1 | Source-centric analytics + DMARC pass rate | `/api/sources`, `SourcesView`, `Record`-level DMARC rule | [analytics.md](analytics.md) |
| 2 | Time ranges | `7d/30d/90d/all` on `/api/summary` (and sources), zero-filled trends | [analytics.md](analytics.md) |
| 3 | Apply records via DNS API | Cloudflare plan/apply + DMARC `rua` merge, preview, audit, no deletes | [dns-apply.md](dns-apply.md) |
| 4 | Store what the parser already parsed | `Report.policy*`, `Record.dkimAuth/spfAuth` | [analytics.md](analytics.md#what-is-stored-now-that-was-previously-dropped) |
| 5 | rua onboarding helper | `/api/domains/:name/ingest` + card with copy and arrival verification | [analytics.md](analytics.md#get-apidomainsnameingest) |
| 6 | Alerts | New-sender and failure-spike scan, in-app feed, optional webhook | [alerts.md](alerts.md) |

Shared UI: a `RangeSelector` component (7/30/90/all) used by the dashboard and Sources view; new
`/sources` and `/alerts` navigation entries; a DNS/ingest panel on the selected domain.

## Deliberate differences from Cloudflare

- **We do not host a mailbox.** Reports arrive at the operator's existing mailbox; that is the
  point of self-hosting and is why the app never asks for DNS control to receive anything.
- **We do not silently edit SPF/DKIM.** The plan is shown before writing, updates require an
  explicit overwrite, and an SPF record with includes the app does not recognise is refused
  rather than simplified.
- **DS and MTA-STS cannot be applied from the DNS zone.** DS belongs at the registrar and
  MTA-STS needs an HTTPS policy file; the app says so instead of pretending.
- **Alerts have no email channel.** A webhook is the integration point; there is no SMTP
  configuration to hold.

## Not done, and why

- DNS writes for providers other than Cloudflare and Loopia (the service is written around a
  small writer interface; adding one is the natural next step).
- Reverse-DNS/ASN enrichment of sources (extra lookups and a data source; the reports do not
  carry it).
- Per-user alert subscriptions and email delivery (needs SMTP credentials and a preference
  model).
- Backfilling `policy_published`/auth results for reports ingested before this change (the raw
  XML is not retained).
