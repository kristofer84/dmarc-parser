# DMARC dictionary

The long-form reference for the vocabulary this project deals in. The in-app page is
`frontend/src/views/GlossaryView.vue`, fed by `frontend/src/data/glossary.ts`; this document is
its long-form companion, not a second source of truth.

**Edit the data file first.** A term belongs in `frontend/src/data/glossary.ts` (id, term,
expansion, aliases, category, short, detail, whyItMatters, reference, related). This document
then gets the same `###` heading, with the mechanics, failure modes and worked examples that do
not fit in a UI card. If the two disagree, the data file is what the app shows and wins.

Terms are grouped the same way as in the app: DMARC, SPF, DKIM, reports, DNS, delivery and
display, and this app's own vocabulary. Every section says what the code actually does; where a
check does not exist, it says that too.

---

## DMARC

### DMARC

Domain-based Message Authentication, Reporting and Conformance (RFC 7489).

The receiver evaluates SPF and DKIM, asks whether either authenticated identifier aligns with the
domain in the visible `From` header, and then applies the published policy. DMARC is the layer
that turns SPF and DKIM into an instruction; without it a forged message that fails both is still
delivered.

Worked example - the smallest useful record, published as one TXT record at
`_dmarc.example.com`:

```
v=DMARC1; p=quarantine; rua=mailto:dmarc@example.com
```

A production record with everything this project's generator would emit:

```
v=DMARC1; p=reject; rua=mailto:dmarc@example.com; ruf=mailto:dmarc@example.com!10m; sp=reject; adkim=s; aspf=s; pct=100
```

### DMARC record

A TXT record at `_dmarc.<domain>` starting with `v=DMARC1`. Discovery is two lookups: the
`_dmarc.` name of the `From` domain, then the organisational domain if the first has no record
(RFC 7489 §6.6.3).

Failure modes that bite:

- **Two records.** Providers helpfully "add" a record at a name that already has one. Receivers
  that find conflicting DMARC records treat the domain as having no policy. `domainStatus.ts`
  reads the first `v=DMARC1` record and does not flag duplicates, so check the zone yourself.
- **Missing `v=DMARC1`.** A record at the right name without the version tag is ignored.
- **Record at the apex.** `example.com`'s TXT records are for SPF; DMARC lives at
  `_dmarc.example.com`.
- **The checker stops at the name you entered.** `checkDomain` queries `_dmarc.<domain>` for
  exactly that string - there is no organisational-domain fallback in the app.

### Policy (`p=`)

`none` (monitor only), `quarantine` (spam folder), `reject` (refuse). RFC 7489 §6.4.2.

`p=none` is a valid stage, not a valid end state: reports arrive, nothing is blocked, forged mail
is delivered. The DMARC check grades `p=none` as `warn`, a missing or invalid `p=` as `error`.

### Subdomain policy (`sp=`)

Overrides `p=` for subdomains; absent means "inherit `p=`" (RFC 7489 §6.4.3).

The classic accident is `p=reject; sp=none`: the apex is protected, every unmanaged subdomain is
not. The check compares `sp=` against `p=` on a none < quarantine < reject ranking and warns when
`sp=` is weaker. The record builder sets `sp=` equal to `p=` on purpose.

### Percentage (`pct=`)

Asks receivers to apply the policy to that share of failing messages; the rest is treated as
`p=none`. Default 100 (RFC 7489 §6.4.4).

Leave it below 100 after rollout and an attacker has a reliable bypass. The check warns whenever
`pct=` parses below 100.

### Alignment mode (`adkim=`, `aspf=`)

Each takes `r` (relaxed, default) or `s` (strict), independently per mechanism
(RFC 7489 §6.4.10, §6.4.11). The check notes when either is `r`, because relaxed alignment lets a
subdomain satisfy DMARC. The record builder emits `adkim=s; aspf=s`, which is stricter than the
RFC default and only correct when nothing sends from a subdomain.

### Identifier alignment

The authenticated domain must match the domain in the visible `From` header: relaxed means
"same or subdomain", strict means "identical" (RFC 7489 §3.1). DMARC passes when SPF or DKIM
passes **and** the mechanism that passed is aligned.

This app cannot decompose the decision. `dmarcParser.ts` reads `auth_results.dkim[].domain` and
`auth_results.spf[].domain` out of the XML, but `extractRecordsForDb` stores only the evaluated
`dkim`/`spf` verdicts, the disposition, the source IP and `header_from`. The `Record` model has
no column for the authenticated domains, so a "SPF passed but DMARC failed" row is only
interpretable from the raw report, not from the app.

### Relaxed alignment

An authenticated subdomain still aligns. Convenient for shared signing infrastructure;
dangerous because it hides a wrong `d=`/return-path domain behind a green row. When hunting an
alignment bug, read the raw report rather than the pass rate.

### Strict alignment

The authenticated domain must equal the `From` domain exactly. It closes the subdomain loophole
and breaks any sender that signs with a parent or sibling domain (mailing lists, ticketing
systems). If failures appear right after applying the generated record with `adkim=s; aspf=s`,
this is the cause.

### Disposition

What the receiver actually did, per report row: `policy_evaluated.disposition` in the XML. It is
*not* a copy of `p=` - `pct=` sampling, receiver-local policy and distrust of its own result can
all weaken it. Comparing the reported disposition to the published policy is how you detect that
your policy is not being applied.

In this app, "Policy Action" on the report views is the disposition covering the most messages in
that report (`routes/reports.ts` sorts by `SUM(count)`), not the published `p=`.

### Organisational domain

The registrable domain behind a subdomain, determined with the public suffix list
(RFC 7489 §3.2). It is the boundary for parent-record fallback and for relaxed alignment, and it
is not "the last two labels" - `example.co.uk` vs `co.uk` is the reason.

This app has no public suffix list and no organisational-domain logic (grep for
`organizational`/`publicsuffix` in `backend/src`: nothing). Domains are stored as the exact
string the reporter published. `mail.example.com` and `example.com` are separate rows with
separate checks; add both, or use *Discover domains*.

### Failure reporting options (`fo=`)

`0` = report when both SPF and DKIM fail, `1` = when either fails, `d`/`s` = narrow to DKIM/SPF
(RFC 7489 §6.4.7). A request only: most large providers ignore it. The app neither parses nor
generates it.

### Report format (`rf=`)

`afrf` (RFC 5965 ARF, the only format in practice) or the nominally allowed, effectively
unimplemented `iodef`. Absent means `afrf`. `rufParser.ts` assumes ARF: it requires a
`Feedback-Type` field plus two other ARF markers before treating a mail as a report.

### Report interval (`ri=`)

Advisory seconds between aggregate reports, default 86400 (RFC 7489 §6.4.9). Receivers batch on
their own schedule and several ignore it; ingestion here is driven entirely by what arrives in
the mailbox. Not parsed by the app.

### ARC

Authenticated Received Chain (RFC 8617). Forwarding breaks SPF and often DKIM; ARC preserves the
authentication results each hop saw in a sealed chain so the final receiver can tell a forwarded
legitimate message from a forgery.

ARC does **not** make DMARC pass. This app does not parse ARC headers, so a forwarded legitimate
message appears as a plain failure in the reports - the usual explanation when failures cluster
on one mailing list or helpdesk forwarder.

---

## SPF

### SPF

Sender Policy Framework (RFC 7208): one TXT record at the apex listing hosts allowed to send with
that domain as the envelope sender. Results are pass/fail/softfail/neutral/none/temperror/
permerror. SPF authenticates the `MAIL FROM` domain, not the `From` header.

Worked example:

```
v=spf1 include:spf.mailjet.com include:_spf.google.com ip4:203.0.113.10 -all
```

Exactly one `v=spf1` record may exist. Two records are not merged - RFC 7208 §3.2 makes the
result a permanent error. `checkSpf` reports that as an `error` with both records in the details.

### SPF mechanism

`all`, `include`, `a`, `mx`, `ptr`, `exists`, `ip4`, `ip6`, evaluated left to right, first match
wins (RFC 7208 §5). `include:` delegates, `a`/`mx` are address tests against the sender's IP,
`exists:` tests whether a name resolves, `ptr:` is deprecated (slow, attacker-controlled reverse
DNS), and anything after `all` is dead.

The check counts `include`/`a`/`mx`/`ptr`/`exists`/`redirect=` but only follows `include:` and
`redirect=` chains - so its lookup count is a lower bound on what a receiver spends.

### SPF qualifier

`+` pass (implicit default), `-` fail, `~` softfail, `?` neutral (RFC 7208 §4.6.2). The qualifier
on `all` is effectively the policy.

`checkSpf` treats: `-all` → ok, `~all` → warn, `?all`/`+all` → error, no `all` at all → error.

### include:

Pulls another domain's SPF record in; passes only if the target passes, and costs one of the ten
lookups. Nested includes are where the budget disappears - an include of a provider that itself
includes four hosts costs five lookups for one line. An `include:` of a host with no SPF record
costs a query and adds nothing.

### SPF lookup limit

Ten DNS lookups per evaluation, counting `include`, `a`, `mx`, `ptr`, `exists` and `redirect`,
recursively (RFC 7208 §4.6.4). The eleventh makes the whole result `permerror`, which most
receivers treat as *no SPF at all* - the domain looks configured and is silently unprotected.

`countSpfLookups` walks the `include:`/`redirect=` chain, errors past ten and warns from eight.
The record builder applies the same limit before you publish. Mitigation is flattening: publish
the provider addresses as `ip4`/`ip6` and re-check monthly.

### SPF authentication vs SPF alignment

SPF proves the sending IP is authorised for the `MAIL FROM` domain. A newsletter sender uses its
own bounce domain there, so SPF passes for a domain that has nothing to do with the visible
`From`. DMARC therefore requires the SPF-authenticated domain to align with the `From` domain
(RFC 7489 §3.1), and `spf=pass` with `dmarc=fail` is a legitimate, common pair.

Fix it at the sender (align the return-path domain), not by weakening the DMARC policy.

---

## DKIM

### DKIM

DomainKeys Identified Mail (RFC 6376). The signer hashes selected headers and the body, signs
that with a private key, and publishes the public half in DNS. Verification is independent of the
sending IP, which is why DKIM survives forwarding better than SPF - but only the headers in `h=`
and whatever the body hash covers are protected.

### DKIM selector

The `s=` tag naming the key, so the public key is at `<selector>._domainkey.<domain>`. A label,
not a secret: several can coexist (rotation), and a provider can publish its own without touching
yours.

**This app does not discover selectors.** They are configured per domain (`dkimSelectors`); an
empty list makes the DKIM check `skipped`. Common values: `mailjet`, `selector1`/`selector2`
(Microsoft 365), `google` (Workspace), `default`. The DKIM check queries TXT at exactly
`<selector>._domainkey.<domain>` and nothing else.

Worked example - a 2048-bit RSA key:

```
selector1._domainkey.example.com. 3600 IN TXT "v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA..."
```

`inspectDkimKey` decodes `p=`, accepts SPKI and bare PKCS#1, reports the algorithm and bit size.

### `_domainkey`

The DNS namespace reserved for DKIM keys (RFC 6376 §3.6.1). Keys cannot collide with apex TXT
records, and a selector alone locates a key. Providers may publish a CNAME there into their own
zone, which is valid; the check resolves TXT at the name, so a CNAME works.

### `d=` and `s=` tags

`d=` is the signing domain (the one DMARC aligns against) and `s=` the selector, both in the
`DKIM-Signature` header (RFC 6376 §3.5). `i=` is the finer-grained agent identity, `h=` lists the
headers actually signed, `c=` selects canonicalisation. A header not in `h=` can be added or
rewritten without breaking the signature - the usual mechanism behind "DKIM passes but the
message was altered".

### DKIM key record

`v=DKIM1; k=rsa|ed25519; p=<base64>` (RFC 6376 §3.6.1). `k=` defaults to `rsa`. An **empty `p=`**
is the documented revocation form, not a broken key: the selector can no longer verify anything.
`t=` carries hints (`y` testing, `s` strict identity), `h=` restricts hash algorithms.

`inspectDkimKey` distinguishes: revoked (empty `p=`), garbage base64, wrong Ed25519 length
(must be 32 raw bytes), undecodable RSA → all `error`.

### Key rotation

Publish the new selector, switch the signer (or sign with both), wait out the TTL and in-flight
mail, then retire the old selector - ideally by publishing an empty `p=`. RFC 8301 §3.2 sets
1024 bits as the floor; 2048 is the practical recommendation.

The check errors on RSA keys under 1024 bits and warns under 2048. A retired selector left in the
domain configuration keeps producing "no key is published" errors until it is removed there.

### Body hash (`bh=`) vs header signature (`b=`)

`bh=` is a hash of the canonicalised body; `b=` is the signature over the selected headers plus
that hash (RFC 6376 §3.5). If the body changed, `bh=` no longer matches. If an unsigned header
was added, both still verify. The optional `l=` tag signs only the first `l` bytes of the body -
which lets a mailing list append a footer, and lets an attacker append content.

Diagnostic use: a key that verifies on an unchanged message but fails in reports points at
in-transit modification (footer, tag rewrite, canonicalisation), not at DNS.

### DKIM authentication vs DKIM alignment

A valid signature from an ESP domain while `From:` claims yours verifies, passes DKIM, and still
fails DMARC. Under relaxed alignment a signature from a subdomain of the `From` domain is enough,
which is why ESPs ask you to CNAME `selector._domainkey` into their zone so `d=` becomes your own
subdomain. A second signature in the same message can be the aligned one.

Aggregate reports here store only the evaluated `dkim` verdict, not `d=`, so this distinction is
inferred rather than displayed.

---

## Reports

### Aggregate report (rua)

Periodic XML summary per domain per reporting organisation: source IP, count, evaluated
disposition, SPF/DKIM results (schema: RFC 7489 Appendix C). No subjects, no recipients, no
bodies.

A sample row (abridged), which is exactly what `dmarcParser.ts` reads:

```xml
<record>
  <row>
    <source_ip>203.0.113.25</source_ip>
    <count>142</count>
    <policy_evaluated>
      <disposition>quarantine</disposition>
      <dkim>fail</dkim>
      <spf>pass</spf>
    </policy_evaluated>
  </row>
  <identifiers>
    <header_from>example.com</header_from>
  </identifiers>
  <auth_results>
    <spf><domain>bounce.example.net</domain><result>pass</result></spf>
    <dkim><domain>esp.example.net</domain><result>fail</result></dkim>
  </auth_results>
</record>
```

This row is the "SPF passes, DMARC fails" shape: SPF passed for `bounce.example.net`, which does
not align with `example.com`. The app keeps the count, disposition, `dkim=fail`, `spf=pass` and
`header_from`; the `auth_results` domains are parsed and then dropped.

Ingestion (`dmarcParser.ts`) accepts gzip, zip or plain XML, then validates hard: `org_name`,
a valid `email`, `report_id`, a sane `date_range`, `p`/`sp` in {none,quarantine,reject},
`pct` 0-100, at least one record, a valid source IP, `count > 0`, a valid disposition, and
`dkim`/`spf` limited to `pass`/`fail`. A report from a reporter that emits `temperror` in those
fields is rejected wholesale and logged as an error rather than partially imported.

### Forensic report (ruf)

Per-message failure report in ARF (RFC 5965) with DMARC fields (RFC 7489 §7.2). The mail carries a
`message/feedback-report` part with `Key: value` lines and may attach the failing message. Far
rarer than aggregate reports; many large providers send none.

`rufParser.ts` handles three shapes: conformant `multipart/report`, the same plus the failing
message as `message/rfc822`, and a non-conformant text body with the fields inline. It requires
`Feedback-Type` plus two other ARF markers, so a mail that merely *quotes* a report does not
match. Field values are unfolded (reporters do wrap `Authentication-Results`).

Extraction notes: `spf=`, `dkim=`, `dmarc=` are summarised out of `Authentication-Results` with
"a single failure dominates" (`dkim=fail ... dkim=pass` reads as `fail`); `dkim-selector` and
`identity-alignment` are stored verbatim when present; raw feedback, full headers and the
reported body are each gated by a setting (`forensics.storeRawFeedback`, `storeFullHeaders`,
`storeReportedMessage`), and the body is truncated at 64 KiB.

### Report-Domain / Reported-Domain

The domain the report is about. Aggregate: `policy_published.domain`, required. Forensic:
`Reported-Domain`, optional, so `rufParser.ts` resolves in this order -
`Reported-Domain` → domain of `Original-Mail-From` → `DKIM-Domain` → domain of
`Original-Rcpt-To` - and throws if none exists.

It is *your* domain. The reporting organisation is theirs. Everything in this app keys off this
field: the domain list, per-domain scoping, dashboard grouping.

### Reporting organisation

`org_name` in the XML plus `email`. Declared by the reporter, not authenticated by the report. For
forensic reports there is no `org_name`, so `rufParser.ts` derives `reporter` from the report
mail's `From` domain, falling back to the last segment of `Reporting-MTA`.

### Report period / date range

`date_range` `begin`/`end` as Unix epoch **seconds**; `dmarcParser.ts` multiplies by 1000. Windows
are usually a day, rarely aligned to your midnight, and they overlap, so summing a month
double-counts. The parser warns (does not reject) when `begin` is more than a year old or `end`
more than a week in the future.

### `rua=` / `ruf=` URIs

Comma-separated URI lists in the DMARC record (RFC 7489 §6.4.5, §6.4.6), normally `mailto:` with
an optional `!size` suffix asking the reporter to send only the first N bytes. No `rua=` means no
aggregate reports, so tightening the policy is guesswork; no `ruf=` means no forensic reports are
requested (and many reporters ignore the request anyway).

`checkDmarc` warns on each case separately. The record builder defaults both to the mailbox this
app already reads and appends `!10m` to `ruf=` so reporters do not mail back full
attacker-controlled messages.

### Message count

`count` is messages, not rows. One row can stand for thousands of messages or one, so pass rates
must be weighted by count. This app: report totals and SPF/DKIM pass rates sum `count`
(`routes/reports.ts`); the dashboard aggregates those; the record table shows `count` per row.

### Source IP

The sending host's literal IPv4/IPv6 address - no hostname, no owner, no geography. It identifies
a relay, not a sender: one provider address serves thousands of customers.

This app shows and copies source IPs and filters forensics by them, and performs **no** PTR,
whois, ASN or geolocation lookup (the resolver in `domainStatus.ts` exposes MX, TXT, A/AAAA, CNAME
and CAA only). Resolve addresses outside the app with `dig -x`/`whois`, and remember reverse DNS
is controlled by the address owner.

### Report mail authentication (`reportAuthenticated`)

The `ruf=` mailbox is world-writable. Anyone can send an ARF-shaped mail claiming anything, and it
will look exactly like a real report. `rufParser.assessReportAuthenticity` reads the enclosing
mail's `Authentication-Results` header and records `true` only when it contains `dkim=pass` or
`dmarc=pass`; `reportAuthDetail` keeps (up to 500 chars of) the verdict.

The Prisma comment in `schema.prisma` says "DKIM per mailparser"; the implementation is the
header check above. Unverified reports are counted on the forensics page and banner-flagged on the
detail page. Treat it as evidence, not proof: the header is only as trustworthy as the hop that
added it.

### Report mailbox (IMAP)

One configured mailbox, read by the scheduled cycle; every message in it is untrusted input.
When it is unset the cycle records "not configured" rather than failing.

---

## DNS

### DNS TXT record

Policy text lives in TXT (RFC 1035 §3.3.14): `v=spf1`, `v=DMARC1`, `v=DKIM1`, `v=STSv1`,
`v=TLSRPTv1`, `v=BIMI1`. Data comes back as character-strings of at most 255 bytes, which
resolvers return as separate chunks; `domainStatus.ts` joins them before matching a version tag.
Records are matched by exact owner name, and the `v=` tag exists so unrelated TXT records at the
same name can be ignored.

Failure modes: two `v=spf1` records (permerror), two `v=DMARC1` records (treated as none), a long
record split at the wrong byte, and editing a record into a duplicate at the provider.

### CNAME

An alias (RFC 1034 §3.6.2). Cannot coexist with other data at the name, and following one costs a
lookup. `checkMx` flags an MX target that is only a CNAME (an MX target must be a host name with an
address). Elsewhere CNAMEs are fine: provider-hosted DKIM keys and autodiscovery names are
routinely CNAMEs, and `resolveHost` falls back to CNAME specifically to report "only a CNAME"
rather than "does not resolve".

### MX record

Names the mail exchangers, lower priority preferred (RFC 5321 §5.1). Targets must be host names
that resolve, not aliases or address literals; pointing at the domain itself is discouraged. A
single `0 .` record is the null MX (RFC 7505) meaning "this domain accepts no mail".

`checkMx` resolves every target, flags apex/CNAME/address-literal/non-resolving targets, diffs
against the per-domain *Expected MX* list, and reports a null MX as `info`.

### PTR / reverse DNS

Maps an address back to a name, in a zone delegated to the address owner (RFC 1035 §3.3.12).
Forward-confirmed reverse DNS raises the bar slightly and proves nothing about intent - which is
why `ptr:` is deprecated in SPF.

**This app does not perform PTR lookups anywhere.** Report source IPs are shown as bare
addresses. If you need attribution, do it outside the app.

### CAA record

Names the CAs allowed to issue for the domain (RFC 8659); CAs must check it before issuance, so an
entry that omits your CA blocks renewals. `issue`, `issuewild`, `iodef`.

`checkCaa` warns when a published record does not allow `letsencrypt.org`, because that is how this
deployment gets certificates. Absence is `info`, not a fault. The record builder can emit
`0 issue "letsencrypt.org"`.

### Autodiscovery

`autoconfig.<domain>` and `autodiscover.<domain>`, used by mail clients to find IMAP/SMTP
settings. Pure convenience, unrelated to authentication. The check only resolves the two names; it
does not fetch or validate any configuration document. Suggestions appear only when the last
check found a name absent.

---

## Delivery and display

### Header From

The visible `From` (RFC 5322 §3.6.2), settable to anything by the sender - which is why DMARC
exists. DMARC evaluates this domain; SPF/DKIM count only when aligned with it. Aggregate reports
record it as `header_from` and the app stores it per row, so a row whose `header_from` differs
from the report's domain is the signature of a spoofing attempt.

### Envelope From

The SMTP `MAIL FROM` (RFC 5321 §4.1.2): bounce address, not shown to the recipient, what SPF
authenticates. Normally a different domain from the `From` header (an ESP bounce domain or a
dedicated subdomain). ARF calls it `Original-Mail-From`, which `rufParser.ts` stores and uses as a
domain fallback. Aggregate reports do not carry it at all.

### MTA-STS

SMTP MTA Strict Transport Security (RFC 8461): two parts, a TXT record at `_mta-sts.<domain>` with
`v=STSv1; id=<value>`, and a policy file at `https://mta-sts.<domain>/.well-known/mta-sts.txt`.
Senders cache the policy against the id, so the id must change whenever the policy does.

`checkMtaSts` reads both, warns when the TXT record is not `v=STSv1`, when the policy cannot be
fetched, and when `mode=enforce` does not cover every published MX host. Absence is `info`.

### MTA-STS policy file

`version: STSv1`, `mode:` (none/testing/enforce), `max_age:`, and one `mx:` line per host
(RFC 8461 §3.2). `testing` reports without blocking, `enforce` refuses delivery when TLS fails,
`none` reserves the name and does nothing. One leading wildcard per `mx:` is allowed. The file must
be served over HTTPS with a certificate valid for `mta-sts.<domain>` or senders ignore the TXT
record.

The check warns on `testing`, `none` and a missing mode. The record builder emits both the TXT
record and the companion policy file, defaulting to `testing`.

### TLS-RPT

SMTP TLS Reporting (RFC 8460): TXT at `_smtp._tls.<domain>` with `v=TLSRPTv1` and at least one
`rua=`. Receivers send JSON reports about failed and downgraded sessions - what makes an MTA-STS
rollout observable, since without it "enforcing TLS" and "breaking mail" look identical.

The check requires the version tag and `rua=`. This app does **not** ingest TLS-RPT reports: there
is no parser for them, only the record check.

### BIMI

Brand Indicators for Message Identification: a record at a selector name (conventionally
`default._bimi.<domain>`) with `v=BIMI1`, `l=` (HTTPS SVG logo) and `a=` (verified mark
certificate). Providers generally require an enforcing DMARC policy before showing a logo.

The check requires the version tag, an https `l=`, and an `a=`, then fetches the logo and inspects
whether it looks like SVG. It does not validate the certificate.

### VMC

Verified Mark Certificate: a CA-issued certificate proving the organisation holds a registered
trademark for the logo. Without one most providers ignore BIMI; a lapsed one silently removes the
logo. The check only verifies that `a=` exists and points somewhere - an expired VMC still reads as
healthy here.

---

## This app's own pipeline vocabulary

### Domain check

`backend/src/services/domainStatus.ts` (the checker), `backend/src/services/domainMonitor.ts`
(persistence and scheduling), `backend/src/routes/domains.ts` (HTTP).

Per-domain checks: MX, SPF, DMARC, DKIM keys, and optionally MTA-STS, TLS-RPT, BIMI,
autodiscovery, CAA. Each result has `status`, `summary`, `purpose`, `details`, `fix`; the domain
status is the worst of them (`worse()`). Lookups are memoised per run and time-bounded
(`withTimeout`, default 5 s), and a check that throws is still reported. History keeps the last 30
runs (`HISTORY_LIMIT`); the list carries the latest 14 for the sparkline. Scheduled runs cover
`monitored` domains only, with concurrency 2. Nothing writes to DNS; the only outbound HTTP is the
MTA-STS policy fetch and the BIMI logo fetch, both size-capped.

### Check status

`ok`, `warn`, `error`, `info`, `skipped`. Worst-wins ranking puts `info` and `skipped` below `ok`
so an optional record that is simply not published never drags a healthy domain down. The Domains
page spells the scale out next to the results, because that misreading is common.

### Record suggestions

`backend/src/services/recordSuggestions.ts`, surfaced by
`frontend/src/components/RecordSuggestionsPanel.vue` via `POST /api/domains/:id/records`.

Generates SPF, DMARC, DKIM, MTA-STS (TXT plus policy file), TLS-RPT, CAA and autodiscovery records
with notes, status `missing`/`ok`/`outdated`/`needs-input`. It reads the current state through the
same `DnsResolver` interface and never writes. DKIM is always `needs-input`: the private key lives
with the sender, and an invented public key would either fail every signature or look valid while
the real key is elsewhere. The DMARC record it builds is opinionated: `sp=` mirrors `p=`,
`adkim=s`, `aspf=s`, `pct=100`, `ruf=...!10m`. A builder that throws degrades to a single
`needs-input` record so the operator does not lose the others.

Note: `generateCaa` returns `type: 'TXT'` while its own note says "This is a CAA record, not a TXT
record". Pick the CAA type at the provider; the returned type is wrong.

### Processing log

`backend/src/services/emailProcessor.ts` writes the rows, `processingStatus.ts` keeps the
in-process health snapshot, `backend/src/routes/processingLogs.ts` serves them,
`backend/src/views` → `frontend/src/views/ProcessingLogsView.vue` displays them.

Statuses: `started`, `success`, `skipped`, `error`. `skipped` covers a duplicate report, a disabled
forensic setting and an unconfigured mailbox - none of which is a failure. Each row links to the
report it produced. The health endpoint distinguishes "HTTP is up" from "reports are actually
being ingested", because a server that answers 200 while every cycle fails is not healthy.

### Dedup key

`Report.reportId` is unique (the reporter's `report_id`); forensic reports use
`ForensicReport.dedupKey`, which is `msgid:<Message-ID>` when present, otherwise
`hash:<sha256(domain|sourceIp|arrivalDate|mailFrom|rcptTo|selector|reporter)[0..32]>`
(`RufParser.buildDedupKey`). Both make re-processing the mailbox idempotent. A corrected forensic
resend is a different key and is stored separately.

### Per-domain scoping

`backend/src/middleware/auth.ts` → `getDomainScope` (`null` = admin, `[]` = nothing assigned) and
`isDomainAllowed`; applied in `routes/reports.ts`, `routes/summary.ts`, `routes/forensics.ts`,
`routes/domains.ts`. Out-of-scope resources answer **404**, not 403, so ids cannot be probed. A
domain that is not in the domain list is not covered by any scope.

### Domain discovery

`domainMonitor.discoverDomains`, exposed as `POST /api/domains/discover`. Adds every domain seen in
`Report.domain` and `ForensicReport.domain` that is not already tracked; adds only, never removes.
Discovered domains arrive unchecked and unmonitored, and are invisible to non-admins until
assigned.

---

## Compliance vocabulary

Terms an auditor uses, plus the mechanisms this app offers as evidence. The clause-by-clause
mapping, the data inventory and — more importantly — the honest gaps are in [nis2.md](nis2.md).
This section is only the vocabulary.

### NIS2

Directive (EU) 2022/2555. It obliges **organisations**, never software: risk management (Art. 21),
incident reporting (Art. 23: 24 h early warning, 72 h notification, one month final report), and
management accountability (Art. 20). Transposition was due 2024-10-17 and is national, so the
registration portal, the authority and the deadlines are in your member state's law. Scope is
medium and above (≥50 staff or >€10 m turnover) across 18 sectors, with some digital, DNS and
trust-service providers in scope regardless of size. Fines reach €10 m or 2 % for essential
entities, €7 m or 1.4 % for important ones (Art. 34).

`dmarc-parser` is not an in-scope entity. Its *users* usually are, and the project's contribution
is evidence, not compliance: `SECURITY.md` and Dependabot for Art. 21(2)(e), `deploy/README.md`
§6–§8 for (c), passkeys for (j), and the audit trail below.

### Audit trail

`backend/src/services/audit.ts`, `backend/src/middleware/audit.ts`, `backend/src/routes/audit.ts`,
model `AuditEvent` → table `audit_events`. Routes set `req.audit`; the middleware writes one row on
`finish`, taking the outcome from the status code, so a failure cannot be recorded as a success.
Sign-ins (password, passkey, OIDC — failures included), lockouts, password/passkey changes, and
every user, domain, provider, setting and retention change are covered; an unlabelled mutation
falls back to `http.<verb> <route>`. Credential-shaped detail keys are redacted at write time and
no code updates a row. Read at *More → Audit log*; prune via `data.auditRetentionDays`.

### Evidence export

`GET /api/audit/export?format=csv|json`. Returns the filtered rows plus `X-Audit-Digest`, a
SHA-256 of the body (JSON also embeds it, scoped to the `events` array). Refused above 20,000 rows
rather than truncated. The export itself is audited (`audit.export`, refusals too). The digest
proves **the file** was not altered after export; it says nothing about the database.

### Data retention

`backend/src/services/retention.ts` and the `data.*` settings. Aggregate reports are anchored on
the report period `endDate`; forensic reports on `arrivalDate`, falling back to `createdAt`; audit
rows on `createdAt`. `0` = keep forever (the default for both report kinds). A preview endpoint
counts what a run would delete; runs fire 90 s after start and every 6 h, serialised with the
manual run. Records cascade with their report; processing logs keep their rows with a null
`reportId`. Irreversible — and a backup taken earlier still contains the rows.

### Tamper evidence

The audit table is append-only *by application design*, not cryptographically. No code updates or
deletes a row except the retention prune (itself audited), but anyone with the database file can
edit it with `sqlite3` and nothing would notice. A hash chain was considered and deliberately not
built: pruning breaks the chain at the boundary, and a verifier that cannot verify is worse than a
stated limit. Periodic exports to storage you cannot rewrite are the substitute.

### MFA

Art. 21(2)(j). Passkeys (`services/webauthn.ts`) are origin-bound and additive to the password;
OIDC delegates the factor to the provider and is identity-only. Neither is enforced — an account
can exist with a password alone — so "available" must not be reported as "enforced".

### SBOM

`.github/workflows/publish.yml` builds with `sbom: true`, attaching a bill-of-materials attestation
to the pushed image rather than leaving a file in the repo. Inspect an image with
`docker buildx imagetools inspect --format "{{json .SBOM}}" <image>`. One input to Art. 21(2)(d);
not a vulnerability scan.

### Build provenance

`actions/attest-build-provenance` in the same workflow. Verify with
`gh attestation verify oci://ghcr.io/kristofer84/dmarc-parser:latest --repo kristofer84/dmarc-parser`;
it exits non-zero when the signature or subject digest does not match, which is what makes it
usable as a check rather than a formality.

### Supply-chain security

Art. 21(2)(d). On this side: committed lockfiles, `npm ci`, CI-gated publishing, Dependabot for npm
(backend and frontend), GitHub Actions and the Dockerfile, plus the two attestations above. It says
nothing about your other suppliers.

---

## Keeping this document honest

- If a term describes app behaviour, it names the file that implements it. If you change the
  behaviour, change the entry in the same commit.
- If a check does not exist, say so (PTR lookups, organisational domains, TLS-RPT ingestion, ARC
  parsing) rather than describing what a receiver does as if the app did it.
- The data file is `frontend/src/data/glossary.ts`; this document follows it.
