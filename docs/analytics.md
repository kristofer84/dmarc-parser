# Sources, ranges and DMARC pass rate

The answer to "who sends mail as my domain, how much, and does it authenticate?" — the
question Cloudflare DMARC Management puts first. This page documents what the numbers mean,
where they come from, and what they deliberately do not do.

## What a "source" is

An aggregate (rua) report names a **source IP**, the reporting organisation, a message count,
the receiver's policy-evaluated SPF/DKIM verdicts and the action it took. It does **not** name a
sending service or a hostname reliably, so a source here is the IP, grouped across every report
and domain visible to the caller. `organizations` and `domains` are attached to that IP; they
are not separate grouping keys.

**Limitation, stated once:** a shared IP (a relay, a marketing platform) collapses several
senders into one row; conversely the same provider appears as many IPs. Reverse DNS/ASN
enrichment is not done — reports do not carry it and this app makes no extra lookups.

## DMARC pass, precisely

Per RFC 7489 §6.4.2, the `<dkim>` and `<spf>` elements inside `<policy_evaluated>` are the
receiver's **aligned** verdicts, not raw signature/SPF results. Therefore:

```
DMARC pass (one record)  ⇔  policy_evaluated/spf == "pass" OR policy_evaluated/dkim == "pass"
```

Alignment is **never recomputed** here. Recomputing it from the raw auth results would need the
header From and the signing domain, and would contradict the receiver's own decision — the one
thing that actually determined delivery. SPF and DKIM pass rates are reported separately
alongside it, from the same two fields, so they can sum in a way that looks surprising (a
message can pass SPF and fail DKIM and still pass DMARC).

`failures` counts messages where **both** checks failed — the inverse of the rule above. The
alert scan uses the same definition (`isDmarcPass()` in `services/sources.ts` is the single
implementation).

## Ranges

`7d`, `30d`, `90d`, `all`. A report belongs to a range when its period **ended** at or after the
cutoff (`Report.endDate >= since`), not when it was ingested — a report that arrives a week late
still describes last week. The cutoff is midnight UTC of `now − N days`, so repeated requests
inside a day agree and the daily chart buckets line up.

- Invalid or missing `range` falls back to `30d` (a stale bookmark gets a view, not a 400).
- `all` has `since: null`.
- Dashboard trends are zero-filled across the selected window (empty days still appear).
  `all` buckets the whole data span and is thinned to at most 365 buckets.
- Sorting and `limit` apply to the returned source rows only. **Totals always describe the whole
  window**, so truncating the table does not change the headline numbers.

## API

### `GET /api/sources`

Auth required, domain-scoped (`null` = everything for an admin, `[]` = nothing assigned).
`range` as above, `limit` clamped to 1..500 (default 100), sorted by message count descending.

```json
{
  "range": "30d",
  "since": "2026-09-20T00:00:00.000Z",
  "totals": { "messages": 12000, "failures": 300, "dmarcPassRate": 97, "sourceCount": 42 },
  "sources": [{
    "sourceIp": "203.0.113.5",
    "messages": 1234,
    "failures": 12,
    "dmarcPassRate": 99,
    "spfPassRate": 95,
    "dkimPassRate": 88,
    "dispositions": { "none": 1200, "quarantine": 20, "reject": 14 },
    "domains": ["example.com"],
    "organizations": ["Google LLC"],
    "firstSeen": "2026-07-01T00:00:00.000Z",
    "lastSeen": "2026-10-20T00:00:00.000Z"
  }]
}
```

`firstSeen`/`lastSeen` are computed over **all time** for that IP (still domain-scoped), because
"never seen before" is what makes a sender worth looking at. They are one raw `MIN/MAX` join,
not a load of every historical row; the only dynamic part is the number of `?` placeholders.

### `GET /api/summary`

Now accepts the same `range`; every previous field is still present, plus `avgDmarcPassRate`,
`range` and `since`. `topSources`, `topIPs`, `policyDistribution` and the pass rates are scoped
to the window. `topIPs[].failureRate` and `trendsData[].failureRate` use the DMARC rule above
(they previously counted "either check failed", which disagreed with the headline rate).

### `GET /api/reports?sourceIp=203.0.113.5`

Returns reports with at least one record from that exact IP. This is what the Sources view links
to; it is an exact match, not a search box.

### `GET /api/domains/:name/ingest`

Auth required and domain-scoped; out of scope answers 404.

```json
{
  "rua": "mailto:dmarc@example.org",
  "ruf": "mailto:dmarc@example.org",
  "configured": true,
  "lastReportAt": "2026-10-19T00:00:00.000Z",
  "reports30d": 12,
  "verified": true
}
```

- `rua`/`ruf` are the **IMAP user** from `mailboxConfig` (environment first, then settings) —
  the same mailbox receives both, so they are identical. `null` when no mailbox is configured.
- `verified` means "at least one report for this domain ended in the last 30 days". It is
  evidence that *some* `rua` reaches this instance; it does not prove that this address is the
  only target, nor that a report was addressed here rather than forwarded.
- Reports are matched on the normalized, lower-case domain name.

## What is stored now that was previously dropped

The parser always extracted more than the database kept. Since this change:

| Stored | Column | Source |
|---|---|---|
| Published policy | `Report.policyP`, `policySp`, `policyPct`, `policyAdkim`, `policyAspf` | `policy_published` |
| Raw aligned auth results per record | `Record.dkimAuth`, `Record.spfAuth` (JSON `[{domain,result}]`) | `auth_results/dkim`, `auth_results/spf` |

Absent policy fields are stored as `NULL`, not `''`. **Existing rows cannot be backfilled** —
the raw XML is not retained — so reports ingested before this change show no published policy
and empty auth arrays. New ingestion fills them (`emailProcessor.storeReport`).

They are surfaced in the report detail view (`ReportDetailView.vue`): a *Published policy* row
with only the tags that were actually present (`p`, `sp`, `pct`, `adkim`, `aspf`; legacy rows
say so instead of pretending), and an *Auth domains* column that lists every
`auth_results/dkim` and `auth_results/spf` entry with the receiver's own result vocabulary
(`softfail`, `neutral`, …). `GET /api/reports/:id` returns `policy` and parsed
`records[].dkimAuth` / `spfAuth` arrays.

## Frontend

`/sources` (`SourcesView.vue`, shared `RangeSelector.vue`): range selector, totals, sortable
table, row detail, and a link into `/reports?sourceIp=…`. The dashboard uses the same selector
and shows the new DMARC pass-rate card.

## Tests

`backend/test/sources.test.ts` — ingestion persistence through the parser, aggregation and DMARC
rule, range/limit behaviour, domain scoping, `sourceIp` report filter, ingest endpoint (including
404 for an out-of-scope domain). Run with `npx tsx test/sources.test.ts`.
