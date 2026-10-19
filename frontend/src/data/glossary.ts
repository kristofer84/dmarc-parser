/**
 * The project glossary: the vocabulary a sysadmin meets in DMARC reports, in plain terms.
 *
 * The in-app page (GlossaryView.vue) renders this array; docs/dictionary.md is the long-form
 * companion with the same headings. Edit this file first - the doc follows the data, not the
 * other way round, so a term cannot exist in one place and not the other.
 *
 * Two rules keep the entries honest:
 *
 *  - `whyItMatters` may only name things this app actually does. Where a check does not exist
 *    (no PTR lookups, no alignment computation, no PSL) the entry says so rather than implying
 *    it. See backend/src/services/domainStatus.ts for what is really checked.
 *  - `detail` describes the mechanics a receiver applies, not a wish. If a tag is parsed but
 *    never stored (adkim/aspf/sp/pct from the XML), the entry says that too.
 */
export type GlossaryCategory =
  | 'dmarc'
  | 'spf'
  | 'dkim'
  | 'reporting'
  | 'dns'
  | 'delivery'
  | 'operations'
  | 'compliance';

export interface GlossaryTerm {
  /** Kebab slug, used as the DOM id so /glossary#dkim-selector deep-links. */
  id: string;
  term: string;
  /** The expansion, when the term is an acronym. Null for plain phrases. */
  expansion: string | null;
  /** Other spellings an operator may search for. */
  aliases: string[];
  category: GlossaryCategory;
  /** One sentence a non-specialist understands. */
  short: string;
  /** The mechanics that actually matter: 2-4 sentences. */
  detail: string;
  /** What the operator does with it, and where it shows up in this app. */
  whyItMatters: string;
  /** RFC number plus section, a URL, or null when there is no normative source. */
  reference: string | null;
  /** Ids of other entries in this array. */
  related: string[];
}

export const GLOSSARY_CATEGORIES: ReadonlyArray<{
  id: GlossaryCategory;
  label: string;
  description: string;
}> = [
  {
    id: 'dmarc',
    label: 'DMARC',
    description: 'The policy layer: what a receiver does when SPF or DKIM does not line up.',
  },
  {
    id: 'spf',
    label: 'SPF',
    description: 'Which hosts may send as the domain, and the DNS budget that limits it.',
  },
  {
    id: 'dkim',
    label: 'DKIM',
    description: 'The signature, the key it names, and what happens when the key is wrong.',
  },
  {
    id: 'reporting',
    label: 'Reports',
    description: 'What a receiving system sends back, and what it does not tell you.',
  },
  {
    id: 'dns',
    label: 'DNS',
    description: 'The record types the checks read. Nothing here writes to a zone.',
  },
  {
    id: 'delivery',
    label: 'Delivery and display',
    description: 'The addresses a user sees, and how transport and the inbox are hardened.',
  },
  {
    id: 'operations',
    label: 'This app',
    description: 'The console own vocabulary: checks, suggestions, logs and scoping.',
  },
  {
    id: 'compliance',
    label: 'Compliance',
    description: 'The vocabulary an auditor uses, and the limits of what this app can evidence.',
  },
];

export const GLOSSARY: GlossaryTerm[] = [
  // -------------------------------------------------------------------------
  // DMARC
  // -------------------------------------------------------------------------
  {
    id: 'dmarc',
    term: 'DMARC',
    expansion: 'Domain-based Message Authentication, Reporting and Conformance',
    aliases: ['dmarc policy'],
    category: 'dmarc',
    short:
      'A DNS-published policy that tells receivers whether to deliver, quarantine or reject mail that claims to be from your domain but fails authentication.',
    detail:
      'The receiver evaluates SPF and DKIM for the message, then asks whether either authenticated identifier aligns with the domain in the visible From header. If one does, the message passes; if both fail, the receiver applies the published policy and may report the event back to you. DMARC is what turns SPF and DKIM from hints into an instruction: without it, a forged message that fails both checks is still delivered.',
    whyItMatters:
      'This app exists to read the reports DMARC generates. The dashboard shows SPF and DKIM pass rates per report, the Domains page grades the DMARC record you publish, and the record builder writes one for you.',
    reference: 'RFC 7489',
    related: ['dmarc-record', 'disposition', 'identifier-alignment', 'aggregate-report', 'spf', 'dkim'],
  },
  {
    id: 'dmarc-record',
    term: 'DMARC record',
    expansion: null,
    aliases: ['_dmarc', '_dmarc.example.com', 'v=DMARC1'],
    category: 'dmarc',
    short:
      'A TXT record at _dmarc.<your domain> starting with v=DMARC1, which carries the policy and the reporting addresses.',
    detail:
      'Discovery is a DNS lookup: a receiver checks _dmarc.<the From domain>, and if that name has no record it retries at the organisational domain (example.com for mail.example.com). Exactly one record is expected; a second one is a common breakage, because receivers that find conflicting records treat the domain as having no policy. The record is a semicolon-separated tag list, so a stray semicolon or a missing v=DMARC1 silently disables all of it.',
    whyItMatters:
      'The Domains check calls this record directly: it reads p=, sp=, pct= and rua= and warns on the common weaknesses. It looks only at _dmarc.<domain> for the name you entered (no organisational fallback) and only at the first v=DMARC1 record, so it does not flag duplicates.',
    reference: 'RFC 7489 §6.6.3',
    related: ['dmarc', 'policy-p', 'subdomain-policy', 'dmarc-uri', 'dns-txt-record'],
  },
  {
    id: 'policy-p',
    term: 'Policy (p=)',
    expansion: null,
    aliases: ['p=', 'p=none', 'p=quarantine', 'p=reject'],
    category: 'dmarc',
    short:
      'The tag that says what a receiver should do with mail that fails DMARC: none (watch), quarantine (spam folder) or reject (refuse).',
    detail:
      'p=none means monitoring only: reports still arrive, nothing is blocked, and forged mail is delivered. quarantine asks the receiver to treat the message as suspect, which in practice means the spam folder; reject asks it to refuse the message outright. Tightening the policy is only safe once the aggregate reports show that legitimate senders pass, which is why none-then-quarantine-then-reject is the normal progression.',
    whyItMatters:
      'The DMARC check grades p=none as a warning and a missing or invalid p= as an error, because a monitoring-only policy protects nothing. The record builder emits p= together with a matching sp= and strict alignment.',
    reference: 'RFC 7489 §6.4.2',
    related: ['dmarc-record', 'subdomain-policy', 'disposition', 'pct'],
  },
  {
    id: 'subdomain-policy',
    term: 'Subdomain policy (sp=)',
    expansion: null,
    aliases: ['sp='],
    category: 'dmarc',
    short:
      'The policy that applies to subdomains of the domain the record is published for; it defaults to p= when absent.',
    detail:
      'sp= overrides p= for any subdomain, so a domain can stay at p=none while sp=reject, or the reverse. The reverse is the usual accident: p=reject with sp=none means the apex is protected and every unmanaged subdomain is still spoofable. Omitting sp= is not the same as setting it to none - omitting it inherits p=.',
    whyItMatters:
      'The DMARC check compares sp= against p= on a none/quarantine/reject ranking and warns when sp= is weaker. The record builder sets sp= equal to p= on purpose, so subdomains are never a soft spot.',
    reference: 'RFC 7489 §6.4.3',
    related: ['dmarc-record', 'policy-p', 'organizational-domain'],
  },
  {
    id: 'pct',
    term: 'Percentage (pct=)',
    expansion: null,
    aliases: ['pct='],
    category: 'dmarc',
    short:
      'A tag that asks receivers to apply the policy to only that percentage of failing messages, the rest being treated as p=none.',
    detail:
      'pct= is how a policy is rolled out gradually: pct=10 with p=reject subjects a tenth of failing traffic to rejection while the rest is still delivered. The default is 100, and a record that keeps pct below 100 long after rollout gives an attacker a reliable bypass. Note the sampling is the receiver choice and is per message, so your reports mix applied and unapplied rows.',
    whyItMatters:
      'The DMARC check warns whenever pct= parses below 100 and tells you to raise it. The record builder always writes pct=100 for the same reason.',
    reference: 'RFC 7489 §6.4.4',
    related: ['policy-p', 'dmarc-record', 'disposition'],
  },
  {
    id: 'alignment-mode',
    term: 'Alignment mode (adkim=/aspf=)',
    expansion: null,
    aliases: ['adkim', 'aspf', 'adkim=r', 'aspf=s'],
    category: 'dmarc',
    short:
      'Two tags that choose relaxed or strict alignment for DKIM and SPF, independently.',
    detail:
      'Each tag takes r (relaxed, the default) or s (strict). adkim governs the DKIM d= domain, aspf governs the SPF MAIL FROM domain, and both are compared against the From header domain. Setting them per mechanism is deliberate: a provider that signs with a shared parent domain may need relaxed DKIM while SPF can stay strict.',
    whyItMatters:
      'The DMARC check notes when adkim=r or aspf=r, because relaxed alignment lets a subdomain satisfy the check. The record builder emits adkim=s and aspf=s, which is tighter than the RFC default and only correct for a domain with no sending subdomains.',
    reference: 'RFC 7489 §6.4.10, §6.4.11',
    related: ['relaxed-alignment', 'strict-alignment', 'identifier-alignment', 'dmarc-record'],
  },
  {
    id: 'identifier-alignment',
    term: 'Identifier alignment',
    expansion: null,
    aliases: ['aligned', 'alignment'],
    category: 'dmarc',
    short:
      'The rule that the domain SPF or DKIM proved must match the domain in the visible From header, not merely authenticate.',
    detail:
      'SPF authenticates a host for a domain, and DKIM authenticates a domain for a signature; neither of those domains is necessarily the one the recipient sees. Alignment is the comparison: relaxed means the authenticated domain is the From domain or a subdomain of it, strict means they are identical. DMARC passes when SPF or DKIM passes and the mechanism that passed is aligned - a passing SPF for a bounce domain does not count.',
    whyItMatters:
      'This is where most "SPF passes but DMARC fails" reports come from, and it is also the part this app cannot decompose: it stores the reporter evaluated dkim/spf verdict and the header_from, but not the authenticated domains from auth_results, so the alignment decision itself is not visible here.',
    reference: 'RFC 7489 §3.1',
    related: ['relaxed-alignment', 'strict-alignment', 'spf-authentication-vs-alignment', 'dkim-authentication-vs-alignment'],
  },
  {
    id: 'relaxed-alignment',
    term: 'Relaxed alignment',
    expansion: null,
    aliases: ['r', 'adkim=r', 'aspf=r'],
    category: 'dmarc',
    short:
      'The default: an authenticated subdomain still counts as aligned with the From domain.',
    detail:
      'Under relaxed alignment, a message from billing@example.com may be authenticated by a DKIM signature with d=mail.example.com, because mail.example.com is a subdomain of example.com. Alignment is decided against the organisational domain, so the comparison is not a raw string match. Relaxed is what makes shared signing infrastructure work without per-subdomain keys.',
    whyItMatters:
      'Relaxed alignment hides misconfiguration: a sender signing with the wrong subdomain still passes, and the report shows a green row. When you are hunting for an alignment bug, temporarily check with aspf=s/adkim=s or inspect the raw report rather than trusting the pass rate.',
    reference: 'RFC 7489 §3.1, §6.4.10',
    related: ['strict-alignment', 'alignment-mode', 'organizational-domain'],
  },
  {
    id: 'strict-alignment',
    term: 'Strict alignment',
    expansion: null,
    aliases: ['s', 'adkim=s', 'aspf=s'],
    category: 'dmarc',
    short:
      'An authenticated domain must equal the From domain exactly - a subdomain no longer qualifies.',
    detail:
      'Strict alignment compares the authenticated domain to the From header domain literally. It closes the subdomain loophole that relaxed alignment leaves open, but it breaks any sender that signs with a parent or sibling domain, including many mailing lists and ticketing systems. It is safe for a domain whose senders all send from that exact domain.',
    whyItMatters:
      'The record builder writes adkim=s and aspf=s by default. If the aggregate reports still show failures after that record is applied, look for a sender signing with a subdomain - strict alignment is the likely cause, and reverting to relaxed is the fix.',
    reference: 'RFC 7489 §3.1, §6.4.11',
    related: ['relaxed-alignment', 'alignment-mode', 'identifier-alignment'],
  },
  {
    id: 'disposition',
    term: 'Disposition',
    expansion: null,
    aliases: ['policy_evaluated', 'policy action', 'none', 'quarantine', 'reject'],
    category: 'dmarc',
    short:
      'What the receiving system actually did with the message: delivered as normal, quarantined, or rejected.',
    detail:
      'In an aggregate report the disposition sits in each row as policy_evaluated.disposition, and it is the receiver decision for that row - not a copy of your p= tag. It can be weaker than your policy when pct= sampled the message out, when the receiver distrusts its own result, or when a local policy overrides DMARC. Comparing the disposition in the reports with the policy you published is how you find out whether your policy is being applied at all.',
    whyItMatters:
      'Reports list the disposition per row, and the report summary "Policy Action" is the disposition covering the most messages in that report - not the p= from DNS. That distinction matters when a report shows none while the zone says reject.',
    reference: 'RFC 7489 Appendix C',
    related: ['policy-p', 'pct', 'aggregate-report'],
  },
  {
    id: 'organizational-domain',
    term: 'Organisational domain',
    expansion: null,
    aliases: ['org domain', 'public suffix'],
    category: 'dmarc',
    short:
      'The registrable domain behind a subdomain - example.com for mail.example.com - determined with the public suffix list.',
    detail:
      'The public suffix list is what separates example.co.uk (organisational domain) from co.uk (suffix), and DMARC uses that boundary for two things: falling back to a parent DMARC record, and deciding whether a subdomain is "aligned" under relaxed alignment. It is not simply the last two labels, which is why naive string parsing gets co.uk domains wrong.',
    whyItMatters:
      'This app does not implement the public suffix list and does not compute organisational domains. Domains are stored as the exact string a reporter published, so mail.example.com and example.com are separate rows with separate checks; add each one you care about, or use "Discover domains" to add what the reports contain.',
    reference: 'RFC 7489 §3.2',
    related: ['subdomain-policy', 'relaxed-alignment', 'domain-discovery'],
  },
  {
    id: 'fo',
    term: 'Failure reporting options (fo=)',
    expansion: null,
    aliases: ['fo=0', 'fo=1', 'fo=d', 'fo=s'],
    category: 'dmarc',
    short:
      'A DMARC tag requesting which kinds of failure should trigger a forensic report: any failure, or only specific ones.',
    detail:
      'fo=0 requests a report when both SPF and DKIM fail, fo=1 when either fails, and fo=d or fo=s narrow it to DKIM or SPF failures. It is a request, not a guarantee: most large mailbox providers ignore it entirely and send no forensic reports at all. It only matters if you have a ruf= address and a consumer that honours it.',
    whyItMatters:
      'The app neither parses nor generates fo=. The DMARC check only remarks when ruf= is missing; whether a reporter will honour fo= is between you and that reporter.',
    reference: 'RFC 7489 §6.4.7',
    related: ['rf', 'ri', 'forensic-report', 'dmarc-uri'],
  },
  {
    id: 'rf',
    term: 'Report format (rf=)',
    expansion: null,
    aliases: ['rf=afrf', 'rf=iodef'],
    category: 'dmarc',
    short:
      'A DMARC tag naming the format for forensic reports; afrf is the ARF format and the only one in practice.',
    detail:
      'rf=afrf means RFC 5965 Authentication Failure Reports, the format the forensic parser here reads. rf=iodef is nominally allowed and effectively unimplemented. When the tag is absent, afrf is assumed.',
    whyItMatters:
      'The forensic parser assumes ARF: it requires a Feedback-Type field plus two other ARF markers before it treats a mail as a report. Anything in another format lands in the processing log as an error rather than as a report.',
    reference: 'RFC 7489 §6.4.8, RFC 5965',
    related: ['fo', 'ri', 'forensic-report'],
  },
  {
    id: 'ri',
    term: 'Report interval (ri=)',
    expansion: null,
    aliases: ['ri=86400'],
    category: 'dmarc',
    short:
      'A DMARC tag asking how often aggregate reports should be sent, in seconds; the default is 86400.',
    detail:
      'ri= is advisory. Receivers coalesce and batch reports on their own schedule, and several ignore ri= completely, so a value here will not make reports arrive more or less often. The interval that matters is the reporting period inside each report, not this tag.',
    whyItMatters:
      'The app does not read ri= and does not generate it; ingestion is driven by what actually arrives in the mailbox. Report frequency is whatever the reporters decide, which is why the dashboard shows totals per reporting organisation.',
    reference: 'RFC 7489 §6.4.9',
    related: ['fo', 'rf', 'report-period', 'aggregate-report'],
  },
  {
    id: 'arc',
    term: 'ARC',
    expansion: 'Authenticated Received Chain',
    aliases: ['arc-seal', 'arc-message-signature', 'arc-authentication-results'],
    category: 'dmarc',
    short:
      'A set of headers that preserve the authentication results a forwarder saw, so a forwarded message is not treated as a forgery.',
    detail:
      'Forwarding breaks SPF (the forwarder is not in your record) and often DKIM (a footer or subject rewrite changes the signed content). ARC records the result of each hop as a sealed chain so the final receiver can see that the message did authenticate before it was forwarded. ARC does not make DMARC pass; receivers may use the chain as evidence when deciding how much to trust the message.',
    whyItMatters:
      'The app does not parse or evaluate ARC headers, so a forwarded legitimate message appears as a plain failure in the reports. If failures cluster on a mailing list or a helpdesk forwarder, ARC support on that hop is the usual explanation.',
    reference: 'RFC 8617',
    related: ['dkim', 'spf', 'aggregate-report'],
  },

  // -------------------------------------------------------------------------
  // SPF
  // -------------------------------------------------------------------------
  {
    id: 'spf',
    term: 'SPF',
    expansion: 'Sender Policy Framework',
    aliases: ['v=spf1', 'spf record'],
    category: 'spf',
    short:
      'A DNS record listing the hosts allowed to send mail using your domain as the envelope sender.',
    detail:
      'The receiving server checks the connection IP against the mechanisms in the record and returns pass, fail, softfail, neutral, none, temperror or permerror. SPF authenticates the MAIL FROM (return-path) domain, which is the bounce address, not the From header a user sees. Exactly one v=spf1 record may exist at the apex; two records are not merged, they make SPF a permanent error.',
    whyItMatters:
      'The SPF check reads the apex TXT records, errors on duplicates and on a missing or dangerous all, and counts the DNS lookups the record needs. The record builder writes v=spf1 plus one include: per selected provider, ending in -all.',
    reference: 'RFC 7208',
    related: ['spf-mechanism', 'spf-qualifier', 'spf-include', 'spf-lookup-limit', 'envelope-from', 'spf-authentication-vs-alignment'],
  },
  {
    id: 'spf-mechanism',
    term: 'SPF mechanism',
    expansion: null,
    aliases: ['include', 'a', 'mx', 'ptr', 'exists', 'ip4', 'ip6', 'all'],
    category: 'spf',
    short:
      'The terms inside a record that describe a set of senders: all, include, a, mx, ptr, exists, ip4 and ip6.',
    detail:
      'Mechanisms are evaluated left to right and the first match decides the result. ip4/ip6 and a/mx are direct address tests; include: delegates to another domain SPF record; exists: tests whether a name resolves, which makes it powerful and unpredictable; ptr: checks reverse DNS and is deprecated because it is slow and attacker-influenced. all matches everything, so anything after it is dead.',
    whyItMatters:
      'The SPF check parses the mechanisms and counts the ones that cost DNS lookups. It does not follow a/mx targets, only include: and redirect= chains, so the reported lookup count can be a lower bound on what a receiver spends.',
    reference: 'RFC 7208 §5',
    related: ['spf', 'spf-qualifier', 'spf-include', 'spf-lookup-limit'],
  },
  {
    id: 'spf-qualifier',
    term: 'SPF qualifier',
    expansion: null,
    aliases: ['-all', '~all', '?all', '+all', 'softfail'],
    category: 'spf',
    short:
      'The character in front of a mechanism that decides the verdict when it matches: +, -, ~ or ?.',
    detail:
      'Plus means pass and is the implicit default when no qualifier is written; minus means fail; tilde means softfail, which many receivers accept but mark; question mark means neutral, which behaves like no statement at all. The qualifier on all is effectively the policy: -all rejects senders that matched nothing, ~all only flags them.',
    whyItMatters:
      'The SPF check treats -all as healthy, ~all as a warning, and ?all or +all as an error (they claim every host on the internet may send). A record with no all mechanism at all is also an error, because unlisted senders are never explicitly rejected.',
    reference: 'RFC 7208 §4.6.2',
    related: ['spf', 'spf-mechanism', 'spf-include'],
  },
  {
    id: 'spf-include',
    term: 'include:',
    expansion: null,
    aliases: ['include', 'spf include', 'redirect='],
    category: 'spf',
    short:
      'A mechanism that pulls another domain SPF record in, which is how providers publish their sending hosts.',
    detail:
      'include:target evaluates the target record and passes only if the target returns pass; its fail does not fail your record, but it costs one of the ten permitted DNS lookups. Nested includes are where the budget disappears: an include of a provider that itself includes four more hosts consumes five lookups for one line. redirect= is similar but replaces the whole record, and is kept in the lookup count here as well.',
    whyItMatters:
      'The SPF check walks the include: and redirect= chain and reports both the count and the trace. The record builder adds one include: per provider you tick, so a long provider list is visible as a lookup cost before you publish it.',
    reference: 'RFC 7208 §5.2',
    related: ['spf', 'spf-lookup-limit', 'spf-mechanism', 'record-suggestions'],
  },
  {
    id: 'spf-lookup-limit',
    term: 'SPF lookup limit',
    expansion: null,
    aliases: ['10 DNS lookups', 'permerror', 'too many lookups'],
    category: 'spf',
    short:
      'A receiver may perform at most ten DNS lookups while evaluating one SPF record; eleven makes the whole result permerror.',
    detail:
      'The budget covers include, a, mx, ptr, exists and redirect, and it is recursive: every include target spends more of it. Going over does not fail open, it fails as permerror, which most receivers treat as no SPF at all - so the domain looks configured and is silently unprotected. This is the single most common way a working SPF setup breaks after a provider is added.',
    whyItMatters:
      'The SPF check counts lookups against the limit and errors past ten, warning from eight. "Flatten" the chain (publish the provider addresses as ip4/ip6 and re-check monthly) when the count climbs, because it only rises.',
    reference: 'RFC 7208 §4.6.4',
    related: ['spf', 'spf-include', 'spf-mechanism', 'record-suggestions'],
  },
  {
    id: 'spf-authentication-vs-alignment',
    term: 'SPF authentication vs SPF alignment',
    expansion: null,
    aliases: ['spf pass but dmarc fail', 'return-path mismatch'],
    category: 'spf',
    short:
      'SPF can pass for a domain different from the From header, and DMARC only counts it when the two align.',
    detail:
      'SPF proves that the sending IP is authorised for the MAIL FROM domain. A newsletter sender routinely uses its own bounce domain in MAIL FROM, so SPF passes for the provider while the visible From domain has nothing to do with it. DMARC therefore requires the SPF-authenticated domain to align with the From header domain, and a message can legitimately read "spf=pass, dmarc=fail".',
    whyItMatters:
      'Aggregate reports show exactly that split: the row records the SPF verdict and the header_from domain, and a sizeable share of rows with spf=pass and no DMARC pass is the signature of this problem. Fix it at the sender by aligning the return-path domain, not by weakening the DMARC policy.',
    reference: 'RFC 7489 §3.1, §3.1.2',
    related: ['spf', 'identifier-alignment', 'envelope-from', 'header-from', 'dkim-authentication-vs-alignment'],
  },

  // -------------------------------------------------------------------------
  // DKIM
  // -------------------------------------------------------------------------
  {
    id: 'dkim',
    term: 'DKIM',
    expansion: 'DomainKeys Identified Mail',
    aliases: ['dkim signature', 'domainkeys'],
    category: 'dkim',
    short:
      'A cryptographic signature added to a message that lets a receiver verify the signing domain and that the signed content was not altered.',
    detail:
      'The signer hashes selected headers and the body, encrypts that hash with a private key, and puts the result in a DKIM-Signature header naming the domain (d=) and selector (s=). The receiver fetches the public key from DNS using those two values and verifies. DKIM survives forwarding better than SPF because it is not tied to the sending IP, but it only covers the headers listed in h= and whatever the body hash covers.',
    whyItMatters:
      'The DKIM check fetches the published key for each configured selector and inspects its type and size. DKIM is also the mechanism that keeps DMARC passing for forwarded and third-party-sent mail, which is why a broken key shows up as a report-wide failure rather than a single host.',
    reference: 'RFC 6376',
    related: ['dkim-selector', 'domainkey', 'dkim-key-record', 'body-hash-header-hash', 'dkim-authentication-vs-alignment'],
  },
  {
    id: 'dkim-selector',
    term: 'DKIM selector',
    expansion: null,
    aliases: ['s=', 'selector1', 'selector2', 'mailjet', 'google'],
    category: 'dkim',
    short:
      'The name in the signature that says which key was used, and so which DNS name holds the public key.',
    detail:
      'The signature carries s=<selector>, and the public key is published at <selector>._domainkey.<domain>. A selector is just a label: it lets several keys coexist, which is what makes rotation possible without a gap, and lets a provider publish its own key without touching yours. The selector in the signature and the name you configured must match exactly, including case in some resolvers.',
    whyItMatters:
      'This app does not discover selectors - you enter them on the Domains page, and the DKIM check is skipped entirely when the list is empty. Common values are mailjet, selector1/selector2 for Microsoft 365 and google for Workspace; the placeholder shown by the suggestions panel is not evidence of what your sender uses.',
    reference: 'RFC 6376 §3.5',
    related: ['dkim', 'domainkey', 'dkim-tags', 'key-rotation', 'dkim-key-record'],
  },
  {
    id: 'domainkey',
    term: '_domainkey',
    expansion: null,
    aliases: ['_domainkey.example.com', 'domainkey namespace'],
    category: 'dkim',
    short:
      'The DNS namespace reserved for DKIM public keys: <selector>._domainkey.<domain>.',
    detail:
      'It exists so key records cannot collide with ordinary TXT records at the apex, and so a selector alone is enough to locate a key. Some providers publish a CNAME at that name pointing into their own zone instead of a TXT record, which is valid and is why the check resolves TXT at the name rather than assuming a direct record.',
    whyItMatters:
      'The DKIM check queries TXT at exactly <selector>._domainkey.<domain> and nothing else. A key published at the apex, or a selector typo, reads as "no key is published" even though the zone contains one somewhere.',
    reference: 'RFC 6376 §3.6.1',
    related: ['dkim-selector', 'dkim-key-record', 'dns-txt-record', 'cname'],
  },
  {
    id: 'dkim-tags',
    term: 'd= and s= tags',
    expansion: null,
    aliases: ['d=', 's=', 'i=', 'h=', 'a=', 'c='],
    category: 'dkim',
    short:
      'The signature header tags naming the signing domain (d=) and the selector (s=), plus the identity and signed-header list.',
    detail:
      'd= is the domain whose key verifies the signature and the domain DMARC aligns against; s= picks the key. i= is the agent user identifier, a finer-grained identity that is usually the same domain as d=. h= lists the headers that are actually signed - a header not in that list can be added or rewritten without breaking the signature, which is the usual way "DKIM passes but the message was altered" happens. c= chooses header and body canonicalisation, and mismatches there break signatures on the smallest rewrite.',
    whyItMatters:
      'The DMARC alignment question for DKIM is "does d= align with the From domain", so a signature from a shared parent domain passes only under relaxed alignment. The app displays d= only indirectly: aggregate reports keep the per-row verdict, not the signing domain.',
    reference: 'RFC 6376 §3.5',
    related: ['dkim', 'dkim-selector', 'body-hash-header-hash', 'dkim-authentication-vs-alignment'],
  },
  {
    id: 'dkim-key-record',
    term: 'DKIM key record',
    expansion: null,
    aliases: ['k=', 'p=', 'v=DKIM1', 'revoked key'],
    category: 'dkim',
    short:
      'The TXT record holding the public key: v=DKIM1, k=<algorithm> and p=<base64 key>.',
    detail:
      'p= is the base64 public key and k= is rsa (the default) or ed25519. An empty p= is the documented revocation form, which withdraws the key so that signatures with that selector cannot verify. The t= flags carry hints such as "testing" and "strict identity"; h= can restrict which hash algorithms the key may be used with. A key that does not decode, or a record with more than one key, is unusable regardless of how the signature looks.',
    whyItMatters:
      'The DKIM check decodes p= and reports the algorithm and bit size, treats an empty p= as a revoked rather than a broken key, and reports garbage base64 or a wrong Ed25519 length as an error. It accepts both SubjectPublicKeyInfo and the older bare PKCS#1 encoding.',
    reference: 'RFC 6376 §3.6.1',
    related: ['dkim-selector', 'domainkey', 'key-rotation', 'dkim'],
  },
  {
    id: 'key-rotation',
    term: 'Key rotation',
    expansion: null,
    aliases: ['rotate dkim key', '2048-bit key', '1024-bit key'],
    category: 'dkim',
    short:
      'Replacing a DKIM key on a schedule by publishing a new selector and switching the signer to it.',
    detail:
      'Rotation needs an overlap: publish the new selector, configure the sender to sign with it (or with both), wait out the TTL and any in-flight mail, then retire the old selector - ideally by publishing an empty p=. Key size matters as much as age: RFC 8301 sets 1024 bits as the floor and 2048 bits is the practical recommendation, and short RSA keys are factorable. The record TTL also sets how long a bad key keeps causing failures after you fix it.',
    whyItMatters:
      'The DKIM check errors on RSA keys under 1024 bits and warns under 2048, with a fix that says to rotate at the provider and bump the selector. It cannot rotate anything, and a selector that 404s stays in the failure counts until you remove it from the domain configuration.',
    reference: 'RFC 8301 §3.2, RFC 6376 §3.6.1',
    related: ['dkim-key-record', 'dkim-selector', 'domainkey'],
  },
  {
    id: 'body-hash-header-hash',
    term: 'Body hash (bh=) vs header signature (b=)',
    expansion: null,
    aliases: ['bh=', 'b=', 'body hash', 'header hash', 'l='],
    category: 'dkim',
    short:
      'bh= is a hash of the canonicalised body, and b= is the signature over the headers plus that hash.',
    detail:
      'Verification recomputes the body hash and compares it to bh=, then verifies the b= signature over the selected headers including the bh= line. If the body changed, bh= no longer matches and the signature fails; if an unsigned header was added, both still verify. The optional l= tag signs only the first l bytes of the body, which lets a mailing list append a footer without breaking DKIM - and lets an attacker append content, so it is best avoided.',
    whyItMatters:
      'This distinction is what you use when a sender insists "the key is fine". A key that verifies over an unchanged message but produces failures in the reports points at a modification in transit - a footer, a tag rewrite, or a canonicalisation mismatch - not at DNS.',
    reference: 'RFC 6376 §3.5, §3.7',
    related: ['dkim', 'dkim-tags', 'key-rotation'],
  },
  {
    id: 'dkim-authentication-vs-alignment',
    term: 'DKIM authentication vs DKIM alignment',
    expansion: null,
    aliases: ['d= mismatch', 'dkim pass but dmarc fail'],
    category: 'dkim',
    short:
      'A valid signature only satisfies DMARC when its d= domain aligns with the From header domain.',
    detail:
      'A message can carry a perfectly valid signature from an ESP domain while the From header claims yours; the signature verifies, DKIM passes, and DMARC still fails. Under relaxed alignment a signature from a subdomain of the From domain is enough, which is why ESPs often ask you to publish a CNAME so that d= becomes your own subdomain. A second, unrelated signature in the same message can pass and be aligned even when the first one fails.',
    whyItMatters:
      'Reports here keep the evaluated DKIM verdict but not the signing domain, so this distinction is inferred rather than shown. If a report has dkim=fail across the board while the provider says signatures verify, check which d= the provider really uses.',
    reference: 'RFC 7489 §3.1, §3.1.1',
    related: ['identifier-alignment', 'relaxed-alignment', 'dkim-tags', 'spf-authentication-vs-alignment'],
  },

  // -------------------------------------------------------------------------
  // Reporting
  // -------------------------------------------------------------------------
  {
    id: 'aggregate-report',
    term: 'Aggregate report (rua)',
    expansion: null,
    aliases: ['rua', 'rua report', 'DMARC XML', 'feedback report'],
    category: 'reporting',
    short:
      'A periodic XML summary from a receiving organisation listing source IPs, message counts and SPF/DKIM outcomes for your domain.',
    detail:
      'Each report covers one reporting period and one domain, and each row inside it groups messages by source IP, evaluated disposition, SPF result and DKIM result. It is aggregate by design: no subjects, no recipients, no message bodies. The file normally arrives gzipped or zipped and is validated here before it is stored; a report that fails validation is logged as an error instead of partially imported.',
    whyItMatters:
      'This is the main data source of the app. Ingestion unzips the attachment, parses the XML, rejects duplicates by the reporter report_id, and stores one row per record, which is what the dashboard and report views aggregate into pass rates.',
    reference: 'RFC 7489 Appendix C',
    related: ['dmarc-uri', 'message-count', 'reporting-organization', 'report-period', 'dedup-key', 'processing-log'],
  },
  {
    id: 'forensic-report',
    term: 'Forensic report (ruf)',
    expansion: null,
    aliases: ['ruf', 'ruf report', 'ARF', 'auth-failure report'],
    category: 'reporting',
    short:
      'A per-message report about one authentication failure, in the ARF format, sent to the address in ruf=.',
    detail:
      'The report mail contains a message/feedback-report part with Key: value fields - Reported-Domain, Source-IP, Original-Mail-From, Authentication-Results, DKIM-Selector - and may include the failing message itself. Unlike aggregate reports these describe individual messages, so one report is one row, and reporters send far fewer of them; most large providers send none at all. The mailbox accepts mail from anyone, so the contents are a claim by the sender.',
    whyItMatters:
      'The forensic parser accepts three shapes: a conformant multipart/report, the same with the failing message attached, and a bare text body carrying the fields. It requires Feedback-Type plus two other markers before it treats a mail as a report, and it records whether the enclosing mail authenticated.',
    reference: 'RFC 5965, RFC 7489 §7.2',
    related: ['dmarc-uri', 'report-domain', 'source-ip', 'forensic-report-authentication', 'rf', 'fo'],
  },
  {
    id: 'report-domain',
    term: 'Report-Domain / Reported-Domain',
    expansion: null,
    aliases: ['Report-Domain', 'Reported-Domain', 'header_from', 'policy_published.domain'],
    category: 'reporting',
    short:
      'The domain a report is about: policy_published.domain in the XML, Reported-Domain in a forensic report.',
    detail:
      'In an aggregate report the field is fixed and required. In an ARF report Reported-Domain is optional, so consumers have to fall back to something else - typically the envelope or header domain the receiver actually evaluated. Confusing it with the reporting organisation is easy: the domain is yours, the organisation is theirs.',
    whyItMatters:
      'The forensic parser resolves the domain in this order: Reported-Domain, then the domain of Original-Mail-From, then DKIM-Domain, then the Original-Rcpt-To domain, and rejects the report if none exists. Everything else in the app - per-domain scoping, the domain list, the dashboards - keys off this field.',
    reference: 'RFC 7489 Appendix C, RFC 5965 §3.2',
    related: ['aggregate-report', 'forensic-report', 'reporting-organization', 'domain-scoping'],
  },
  {
    id: 'reporting-organization',
    term: 'Reporting organisation',
    expansion: null,
    aliases: ['org_name', 'reporter', 'reporting MTA'],
    category: 'reporting',
    short:
      'The organisation that sent the report, such as a mailbox provider, shown as org_name in the XML.',
    detail:
      'It is an identity declared by the reporter, not authenticated by the report itself, and it is the only way to tell which receiver is seeing what - a spoofer pretending to be you will usually be seen by the big providers first. Forensic reports have no org_name, so the reporter has to be derived from the envelope domain of the report mail or from Reporting-MTA.',
    whyItMatters:
      'Report lists and details show org_name, and the forensic parser derives the reporter from the report mail From domain, falling back to the last segment of Reporting-MTA. It is useful for grouping, not for trust: an unrelated domain can send you a well-formed report.',
    reference: 'RFC 7489 Appendix C',
    related: ['aggregate-report', 'forensic-report', 'forensic-report-authentication', 'report-domain'],
  },
  {
    id: 'report-period',
    term: 'Report period / date range',
    expansion: null,
    aliases: ['date_range', 'begin', 'end', 'report window'],
    category: 'reporting',
    short:
      'The window the report covers, given as begin and end timestamps in the XML.',
    detail:
      'The XML carries begin and end as Unix epoch seconds, and the app converts them to dates for display. Windows are usually a day and rarely align to midnight in your timezone; they also overlap, so summing report totals for a month double-counts unless you account for partial windows. The period is metadata about the report, not a per-message timestamp.',
    whyItMatters:
      'The report list and detail pages show the range, and the parser warns (without rejecting) when dates are more than a year in the past or more than a week in the future - a sign of a broken clock at the reporter. Nothing in the app reports per-message time, because aggregate reports do not carry it.',
    reference: 'RFC 7489 Appendix C',
    related: ['aggregate-report', 'message-count', 'reporting-organization'],
  },
  {
    id: 'dmarc-uri',
    term: 'rua= / ruf= URIs',
    expansion: null,
    aliases: ['rua', 'ruf', 'mailto:dmarc@example.com', '!10m'],
    category: 'reporting',
    short:
      'The addresses in the DMARC record that receive aggregate (rua) and forensic (ruf) reports.',
    detail:
      'Both tags take a comma-separated list of URIs, normally mailto: but nominally https: as well, and an optional !size suffix that asks the reporter to send only the first N bytes - which for a forensic report means the headers rather than the whole message. Without rua= nobody receives aggregate reports, so a stricter policy becomes guesswork. Without ruf= no forensic reports are requested, and many reporters ignore the request anyway.',
    whyItMatters:
      'The DMARC check warns when rua= is missing and notes when ruf= is missing, distinguishing the two. The record builder defaults both to the mailbox this app already reads and appends !10m to ruf= so reporters do not mail back full attacker-controlled messages.',
    reference: 'RFC 7489 §6.4.5, §6.4.6',
    related: ['aggregate-report', 'forensic-report', 'dmarc-record', 'mailbox-concepts'],
  },
  {
    id: 'message-count',
    term: 'Message count',
    expansion: null,
    aliases: ['count', 'volume', 'total messages'],
    category: 'reporting',
    short:
      'The number of messages a report row represents, which is not the number of rows.',
    detail:
      'One row covers every message sharing a source IP, disposition and pair of SPF/DKIM results, so a single row can stand for thousands of messages or for one. Pass rates have to be weighted by count to mean anything; counting rows instead gives every trickle of traffic the same weight as a bulk send. A report total is the sum of the counts in its rows.',
    whyItMatters:
      'The app sums count for report totals, per-report SPF/DKIM pass rates and dashboard figures, and the record table shows the count per row. Rows are grouped per record, so a small row with a failure is still worth reading even when the totals look healthy.',
    reference: 'RFC 7489 Appendix C',
    related: ['aggregate-report', 'disposition', 'report-period'],
  },
  {
    id: 'source-ip',
    term: 'Source IP',
    expansion: null,
    aliases: ['source_ip', 'Source-IP', 'sending IP'],
    category: 'reporting',
    short:
      'The address of the server that connected to the receiver, as recorded in the report.',
    detail:
      'It identifies the sending host, not the sender: a provider relay serves thousands of customers from one address, and a compromised account can send from an address a legitimate bulk sender also uses. Reports give the literal IPv4 or IPv6 address and nothing else - no hostname, no owner, no geography.',
    whyItMatters:
      'The app displays and copies source IPs and filters forensics by them, but it deliberately performs no PTR, whois, ASN or geolocation lookup. To find out who an address is, resolve it outside the app (dig -x, whois) - and remember reverse DNS is controlled by whoever owns the address.',
    reference: null,
    related: ['ptr-rdns', 'aggregate-report', 'forensic-report'],
  },
  {
    id: 'forensic-report-authentication',
    term: 'Report mail authentication',
    expansion: null,
    aliases: ['reportAuthenticated', 'unverified sender', 'unverified report'],
    category: 'reporting',
    short:
      'Whether the mail that carried a forensic report itself authenticated, since anyone can write to the ruf= address.',
    detail:
      'The mailbox is world-writable: a stranger can send a forged ARF mail claiming anything, and the contents will look exactly like a real report. The parser therefore records whether the enclosing mail carried an Authentication-Results header showing dkim=pass or dmarc=pass, and stores that alongside the report. It is evidence, not proof - the header is only as trustworthy as the hop that added it - but a report with no such header deserves no action on its own.',
    whyItMatters:
      'Unverified reports are counted on the forensics page and banner-flagged on the detail page with the header text that was found. The parser never invents a domain or an is-authentic conclusion when the report is malformed; it rejects the report instead.',
    reference: 'RFC 8601 (Authentication-Results)',
    related: ['forensic-report', 'reporting-organization', 'rf'],
  },
  {
    id: 'mailbox-concepts',
    term: 'Report mailbox (IMAP)',
    expansion: null,
    aliases: ['IMAP', 'mailbox', 'rua inbox'],
    category: 'reporting',
    short:
      'The single IMAP mailbox this instance reads to pick up aggregate and forensic reports.',
    detail:
      'One mailbox credential is configured, and every scheduled cycle fetches attachments from it. The mailbox is unauthenticated input: senders of the reports are outside your control, so parsing is defensive and the archive path exists so a bad report can be re-examined without asking the reporter for a copy.',
    whyItMatters:
      'Configured under Administration, settings and secrets included; when it is unset the processing cycle reports "not configured" rather than failing. Forensics can be switched off entirely, and the amount of attacker-controlled content kept is a separate set of toggles.',
    reference: null,
    related: ['aggregate-report', 'forensic-report', 'processing-log', 'dmarc-uri'],
  },

  // -------------------------------------------------------------------------
  // DNS
  // -------------------------------------------------------------------------
  {
    id: 'dns-txt-record',
    term: 'DNS TXT record',
    expansion: null,
    aliases: ['TXT', 'text record'],
    category: 'dns',
    short:
      'The record type that carries SPF, DMARC, DKIM keys, MTA-STS and other policy text.',
    detail:
      'TXT data is a list of character-strings, each at most 255 bytes, which resolvers hand back as separate chunks; a policy longer than that is split and must be joined before it is parsed. Records are matched by exact owner name, so _dmarc.example.com and example.com are different questions. The first string of a policy record is conventionally a version tag (v=spf1, v=DMARC1, v=DKIM1) precisely so that unrelated TXT records at the same name can be ignored.',
    whyItMatters:
      'Every check here reads TXT with chunk joining before matching a version tag, so a split record is not misread. When editing one at a provider, check that it did not become two records - two v=spf1 records break SPF, two v=DMARC1 records break DMARC.',
    reference: 'RFC 1035 §3.3.14',
    related: ['spf', 'dmarc-record', 'dkim-key-record', 'mta-sts', 'tls-rpt'],
  },
  {
    id: 'cname',
    term: 'CNAME',
    expansion: 'Canonical name',
    aliases: ['alias record', 'canonical name'],
    category: 'dns',
    short:
      'An alias record that points one name at another, so the target answer is used instead.',
    detail:
      'A CNAME cannot coexist with other data at the same name, and following one costs another DNS lookup. Aliasing is how providers host DKIM keys and how autodiscovery names point at a mail host. A CNAME chain that ends somewhere without an address is a resolution failure that looks like a missing record.',
    whyItMatters:
      'The MX check flags an MX target that is only a CNAME, because an MX target must be a host name with an address. Elsewhere CNAMEs are accepted: DKIM checks resolve TXT at the selector name, so a provider-hosted CNAME works, and the autodiscovery check counts a CNAME as published.',
    reference: 'RFC 1034 §3.6.2',
    related: ['mx', 'domainkey', 'mail-client-autodiscovery', 'dns-txt-record'],
  },
  {
    id: 'mx',
    term: 'MX record',
    expansion: 'Mail exchanger',
    aliases: ['mail exchanger', 'null MX', 'priority'],
    category: 'dns',
    short:
      'The record that names the servers accepting mail for the domain, with a preference number.',
    detail:
      'Lower priority wins when several are published; equal priorities mean try any. The target must be a host name that resolves to an address, not an alias and not an address literal, and pointing it back at the domain itself is discouraged. A single record of "0 ." is the null MX and means the domain accepts no mail at all.',
    whyItMatters:
      'The MX check resolves every target, flags an apex or CNAME target and a non-resolving host, and diffs the published set against the "Expected MX" list configured per domain so a silent MX change is visible. MTA-STS enforcement is also compared against the real MX set.',
    reference: 'RFC 5321 §5.1, RFC 7505',
    related: ['cname', 'mta-sts-policy', 'domain-check'],
  },
  {
    id: 'ptr-rdns',
    term: 'PTR / reverse DNS',
    expansion: null,
    aliases: ['rDNS', 'PTR record', 'forward-confirmed reverse DNS'],
    category: 'dns',
    short:
      'A DNS record that maps an IP address back to a hostname, the reverse of an A record.',
    detail:
      'Reverse DNS lives in a separate zone delegated to whoever owns the address block, so the name it returns is chosen by that owner and is not evidence of identity. Forward-confirmed reverse DNS checks that the hostname resolves back to the same IP, which raises the bar slightly but still proves nothing about intent. This is why SPF deprecated the ptr mechanism.',
    whyItMatters:
      'This app does not perform PTR lookups anywhere: the resolver used by the domain checks handles MX, TXT, A/AAAA, CNAME and CAA only, and report source IPs are shown as bare addresses. Reverse DNS a report IP yourself, outside the app, and treat the answer as a hint rather than attribution.',
    reference: 'RFC 1035 §3.3.12',
    related: ['source-ip', 'spf-mechanism', 'domain-check'],
  },
  {
    id: 'caa',
    term: 'CAA record',
    expansion: 'Certification Authority Authorization',
    aliases: ['issue', 'issuewild', 'iodef'],
    category: 'dns',
    short:
      'A record naming which certificate authorities may issue certificates for the domain.',
    detail:
      'CAs are required to check CAA before issuing, so an issue or issuewild entry that does not list a CA blocks issuance from it - including renewals. A CAA record that omits the CA you actually use is not a hardening measure, it is an outage waiting for the next renewal. iodef gives CAs a place to report attempted mis-issuance, and the flags byte decides whether an unknown tag is fatal.',
    whyItMatters:
      'The CAA check warns when a published record does not allow letsencrypt.org, because that is how this deployment gets its certificates, and the record builder can emit "0 issue letsencrypt.org". Optional records are checked but reported as info when absent, not as a fault.',
    reference: 'RFC 8659',
    related: ['dns-txt-record', 'domain-check', 'check-status'],
  },
  {
    id: 'mail-client-autodiscovery',
    term: 'Autodiscovery',
    expansion: null,
    aliases: ['autoconfig', 'autodiscover', 'SRV'],
    category: 'dns',
    short:
      'Conventional hostnames that let a mail client find IMAP and SMTP settings from an email address.',
    detail:
      'Clients try well-known names such as autoconfig.example.com and autodiscover.example.com (and provider-specific SRV records) before asking the user for server names. It is pure convenience and unrelated to authentication: publishing it neither helps nor hurts DMARC. Pointing it at the mail host, usually by CNAME, is what stops every new user needing ports dictated over chat.',
    whyItMatters:
      'The autodiscovery check only resolves the two conventional names; it does not fetch or validate any configuration document. Missing names are reported as info, and the record builder suggests them only when the last check found them absent.',
    reference: null,
    related: ['cname', 'mx', 'domain-check'],
  },

  // -------------------------------------------------------------------------
  // Delivery and display
  // -------------------------------------------------------------------------
  {
    id: 'header-from',
    term: 'Header From',
    expansion: null,
    aliases: ['From header', 'RFC5322.From', 'header_from', 'display From'],
    category: 'delivery',
    short:
      'The From address the recipient actually sees, and the domain DMARC aligns everything against.',
    detail:
      'It is part of the message content and can be set to anything by the sender, which is exactly why DMARC exists. DMARC evaluates the domain in this header, and SPF/DKIM only count when their authenticated domains align with it. A single message can only have one From domain for this purpose; a display name that mimics another brand is a separate problem DMARC does not solve.',
    whyItMatters:
      'Aggregate reports record it as header_from and the app stores it per row, so a report can show a From domain different from the domain the report was sent for - the signature of a spoofing attempt. It is the one field in a record that says what the user saw.',
    reference: 'RFC 5322 §3.6.2',
    related: ['envelope-from', 'identifier-alignment', 'dmarc', 'aggregate-report'],
  },
  {
    id: 'envelope-from',
    term: 'Envelope From',
    expansion: null,
    aliases: ['MAIL FROM', 'return-path', 'bounce address', 'Original-Mail-From'],
    category: 'delivery',
    short:
      'The address given in the SMTP conversation, which is where bounces go and what SPF authenticates.',
    detail:
      'It is not shown to the recipient and is often a different domain from the From header - an ESP bounce domain, or a subdomain dedicated to bounces. SPF checks this domain, so a message can pass SPF for a domain that has nothing to do with the visible sender, and DMARC alignment is what reconciles the two. In a forensic report the field is Original-Mail-From.',
    whyItMatters:
      'The forensic parser stores Original-Mail-From and falls back to its domain when Reported-Domain is absent. Aggregate reports do not carry it at all, so for aggregate data this app cannot show you the envelope sender - only the From header and the auth verdicts.',
    reference: 'RFC 5321 §4.1.2',
    related: ['header-from', 'spf', 'spf-authentication-vs-alignment', 'forensic-report'],
  },
  {
    id: 'mta-sts',
    term: 'MTA-STS',
    expansion: 'SMTP MTA Strict Transport Security',
    aliases: ['_mta-sts', 'STSv1', 'STS'],
    category: 'delivery',
    short:
      'A published policy that tells sending servers to require TLS to your mail hosts and to refuse delivery when TLS cannot be negotiated.',
    detail:
      'It is two parts, not one: a TXT record at _mta-sts.<domain> saying a policy exists and carrying an id, and a policy file served over HTTPS at https://mta-sts.<domain>/.well-known/mta-sts.txt. Senders cache the policy against the id, so the id must change whenever the policy does. Because a policy only constrains transport to the listed MX hosts, it is evaluated against your real MX set rather than in isolation.',
    whyItMatters:
      'The MTA-STS check reads both parts, compares the policy mx entries with the published MX records, and warns if enforce would refuse mail to a host the policy omits. Absence is reported as info: the record is optional and its absence is not a fault.',
    reference: 'RFC 8461',
    related: ['mta-sts-policy', 'mx', 'tls-rpt', 'cname'],
  },
  {
    id: 'mta-sts-policy',
    term: 'MTA-STS policy file',
    expansion: null,
    aliases: ['mode=enforce', 'mode=testing', 'max_age', 'mta-sts.txt'],
    category: 'delivery',
    short:
      'The HTTPS document that carries the mode, the max_age and the list of MX hosts the policy covers.',
    detail:
      'Three modes: none does nothing, testing asks senders to report but still deliver, enforce refuses delivery when TLS fails. max_age is how long a sender may cache the policy, so a short value during rollout makes a mistake easy to undo. Each mx line may use a single leading wildcard matching one or more labels. The file must be served with a certificate valid for mta-sts.<domain>, or senders ignore the TXT record entirely.',
    whyItMatters:
      'The check parses the file, warns on testing, none or a missing mode, and warns when enforce does not cover every published MX host. The record builder generates both the TXT record and a companion policy file, and its notes insist the id be bumped on every change.',
    reference: 'RFC 8461 §3.2',
    related: ['mta-sts', 'mx', 'record-suggestions'],
  },
  {
    id: 'tls-rpt',
    term: 'TLS-RPT',
    expansion: 'SMTP TLS Reporting',
    aliases: ['_smtp._tls', 'TLSRPTv1', 'tls-rpt record'],
    category: 'delivery',
    short:
      'A record asking receivers to send JSON reports about TLS negotiation failures and downgrades.',
    detail:
      'The record lives at _smtp._tls.<domain> and must start with v=TLSRPTv1 followed by at least one rua= address. Reports are JSON and describe failed sessions, which is what makes an MTA-STS rollout observable: without them, enforcing TLS and breaking mail look the same from your side. The reports go to a mailbox, not to any part of DMARC.',
    whyItMatters:
      'The TLS-RPT check requires the version tag and a rua=, and reports absence as info. The reports themselves are ingested: TLS reports shows sessions that succeeded, sessions that failed and the reporter reason for each failure (certificate-expired, starttls-not-supported, ...). That page is the evidence for promoting MTA-STS from testing to enforce.',
    reference: 'RFC 8460',
    related: ['mta-sts', 'dmarc-uri', 'dns-txt-record', 'audit-trail'],
  },
  {
    id: 'bimi',
    term: 'BIMI',
    expansion: 'Brand Indicators for Message Identification',
    aliases: ['_bimi', 'BIMI1', 'brand logo', 'default._bimi'],
    category: 'delivery',
    short:
      'A record that lets a mailbox provider display a verified brand logo next to authenticated mail.',
    detail:
      'The record is published at a selector name, conventionally default._bimi.<domain>, with v=BIMI1, l= pointing at an SVG logo over HTTPS and a= pointing at a verified mark certificate. Providers generally require the DMARC policy to be enforcing before they will show a logo, so BIMI is the last step, not the first. The logo must be square SVG/SVG Tiny and publicly fetchable, because the provider fetches it.',
    whyItMatters:
      'The BIMI check requires the version tag, an https l= URL and an a= URL, then fetches the logo and inspects whether it looks like SVG. It does not validate the certificate; it only checks that the record points at one.',
    reference: 'https://bimigroup.org/',
    related: ['vmc', 'dmarc', 'policy-p', 'dns-txt-record'],
  },
  {
    id: 'vmc',
    term: 'VMC',
    expansion: 'Verified Mark Certificate',
    aliases: ['verified mark certificate', 'a=', 'CMC'],
    category: 'delivery',
    short:
      'A certificate from a recognised authority proving the trademark behind a BIMI logo is yours.',
    detail:
      'The issuing CA verifies that the organisation holds a registered trademark for the logo, then issues a certificate the mailbox provider can check. Without one, most providers ignore the BIMI record; the certificate is what stops anyone copying a logo into a record. It has to be renewed, and a lapsed VMC silently removes the logo.',
    whyItMatters:
      'The BIMI check only verifies that the a= tag exists and points somewhere; it does not fetch the certificate or check its validity. A published BIMI record with an a= URL is therefore reported as healthy here even if the certificate has expired.',
    reference: null,
    related: ['bimi', 'dmarc'],
  },

  // -------------------------------------------------------------------------
  // This app
  // -------------------------------------------------------------------------
  {
    id: 'domain-check',
    term: 'Domain check',
    expansion: null,
    aliases: ['domain monitoring', 'DNS check', 'domain status'],
    category: 'operations',
    short:
      'The read-only DNS audit the app runs per domain: MX, SPF, DMARC, DKIM, and optionally MTA-STS, TLS-RPT, BIMI, autodiscovery and CAA.',
    detail:
      'Each check returns a status, a summary, the records it found and a fix, and the domain status is the worst of them. Checks are memoised per run and time-bounded, so one slow resolver cannot stall the whole report. History is kept per domain (30 runs) so a change between checks is visible, and the list carries a small trail for the sparkline.',
    whyItMatters:
      'Run it from the Domains page with "Check now" or "Check all", or on a schedule when the domain is monitored. It only reads DNS and makes a couple of HTTPS fetches (MTA-STS policy, BIMI logo); it never writes to a zone, and a check that throws is still reported rather than dropped.',
    reference: null,
    related: ['check-status', 'record-suggestions', 'mx', 'spf', 'dkim', 'dmarc-record'],
  },
  {
    id: 'check-status',
    term: 'Check status',
    expansion: null,
    aliases: ['ok', 'warn', 'error', 'info', 'skipped'],
    category: 'operations',
    short:
      'The five-word scale every check result uses: ok, warn, error, info and skipped.',
    detail:
      'ok means published and correct; warn means it works but is weaker than recommended; error means broken or missing where required; info means an optional record is simply not published, which is a nudge and not a fault; skipped means a prerequisite is missing, such as no DKIM selectors configured. The domain status is the worst result, with info and skipped ranking below ok so they never drag a healthy domain down.',
    whyItMatters:
      'Most findings on a healthy domain are info, and reading them as failures is the usual mistake. The Domains page spells the scale out next to the check list for exactly that reason.',
    reference: null,
    related: ['domain-check', 'record-suggestions'],
  },
  {
    id: 'record-suggestions',
    term: 'Record suggestions',
    expansion: null,
    aliases: ['records to publish', 'DNS record generator', 'suggestions panel'],
    category: 'operations',
    short:
      'Copy-pasteable DNS records generated from the last check for a domain: what to publish, not what is published.',
    detail:
      'The generator reads the current state through the same DNS resolver as the checks and emits SPF, DMARC, MTA-STS, TLS-RPT, CAA and autodiscovery records with notes and, for MTA-STS, the companion policy file. DKIM is always "needs input", because the private key lives with the sender and an invented public key would either fail every signature or look valid while the real one is elsewhere. The generated DMARC record deliberately mirrors sp= to p=, uses strict alignment and pct=100, and appends !10m to ruf=.',
    whyItMatters:
      'The panel is read-only advice: nothing is ever applied to DNS. Statuses missing/ok/outdated/needs-input track what you still have to do, so a suggestion that already matches the zone does not keep asking.',
    reference: null,
    related: ['domain-check', 'spf-include', 'mta-sts-policy', 'dmarc-record'],
  },
  {
    id: 'processing-log',
    term: 'Processing log',
    expansion: null,
    aliases: ['ingestion log', 'processing status', 'cycle'],
    category: 'operations',
    short:
      'One row per attachment or report the ingestion cycle handled, with the outcome and the reason.',
    detail:
      'Statuses are started, success, skipped and error. Skipped is the interesting one: it is how a duplicate report, a disabled forensic setting or an unconfigured mailbox is recorded, and it is not a failure. Each row links to the report it produced, so a parsing complaint can be traced from the mailbox to the stored records.',
    whyItMatters:
      'When reports stop appearing, the processing log distinguishes "the mailbox is not configured" from "the report was rejected" from "it was already imported". A scheduled cycle that has not completed recently is also surfaced as an unhealthy processing state, because a server that answers HTTP while ingesting nothing is not healthy.',
    reference: null,
    related: ['aggregate-report', 'dedup-key', 'mailbox-concepts'],
  },
  {
    id: 'domain-scoping',
    term: 'Per-domain access scoping',
    expansion: null,
    aliases: ['domain scope', 'UserDomain', 'assigned domains'],
    category: 'operations',
    short:
      'A non-admin user sees only the domains an administrator assigned, and nothing else - not even by guessing an id.',
    detail:
      'Admins have an unrestricted scope, represented as null; a user with no assignments has an empty scope and sees empty results rather than an error. Reports, summaries, forensics and domain detail all apply the scope in their queries, and an out-of-scope resource answers 404 so that ids cannot be probed. A domain that is not in the domain list is not covered by a scope, which is why discovery matters when reports reference subdomains.',
    whyItMatters:
      'This is the boundary that makes a shared instance usable by several teams. If a user reports an empty dashboard, check their assigned domains before checking ingestion - an unassigned domain is invisible, not broken.',
    reference: null,
    related: ['report-domain', 'domain-discovery', 'domain-check'],
  },
  {
    id: 'domain-discovery',
    term: 'Domain discovery',
    expansion: null,
    aliases: ['Discover domains', 'auto-add domains'],
    category: 'operations',
    short:
      'Adds every domain that appears in stored aggregate or forensic reports to the domain list.',
    detail:
      'Reporters publish the domain the report is about, so the reports themselves are the best inventory of what you actually send mail as - including subdomains you forgot. Discovery normalises each name, skips the ones already present, and never removes anything.',
    whyItMatters:
      'Discovered domains arrive unchecked and unmonitored, and for non-admins they are invisible until assigned. Run discovery first, then check all, then assign the results to the people who own them.',
    reference: null,
    related: ['organizational-domain', 'domain-scoping', 'domain-check'],
  },
  {
    id: 'dedup-key',
    term: 'Dedup key',
    expansion: null,
    aliases: ['duplicate report', 'report_id', 'idempotent ingestion'],
    category: 'operations',
    short:
      'The identifier that makes re-reading the same mailbox harmless: a reporter report_id for XML, a message-based key for forensic reports.',
    detail:
      'Aggregate reports are keyed on the report_id from the XML, which the reporter guarantees unique per report, so a report already imported is skipped and logged as such. Forensic reports use the enclosing mail Message-ID when there is one, and otherwise a hash of domain, source IP, arrival date, envelope addresses, selector and reporter. Both keys are unique in the database, so a re-run after an interruption converges instead of duplicating.',
    whyItMatters:
      'This is why "process the mailbox again" is a safe operation and why the same report showing up twice usually means two reporters used the same report_id. A changed forensic report - a corrected resend - is a different key and will be stored separately.',
    reference: null,
    related: ['aggregate-report', 'forensic-report', 'processing-log'],
  },
  {
    id: 'nis2',
    term: 'NIS2',
    expansion: 'Directive (EU) 2022/2555',
    aliases: ['NIS2 directive', '2022/2555', 'cyber risk directive'],
    category: 'compliance',
    short:
      'The EU directive that obliges certain organisations - never software - to manage cyber risk, report incidents and answer for it at board level.',
    detail:
      'Transposition was due by 17 October 2024 and is national, so the registration portal, the authority and the deadlines live in your member state law. The size rule is medium and above (at least 50 staff or more than EUR 10m turnover) across 18 sectors, with some digital providers, DNS and trust services in scope regardless of size. Article 21 lists the risk measures, Article 23 the 24-hour early warning, 72-hour notification and one-month final report.',
    whyItMatters:
      'This app is not an entity under NIS2 and nothing in it certifies compliance. What it gives an operator is evidence for a few clauses: vulnerability handling (SECURITY.md, Dependabot, SBOM), backup and a restore drill, MFA through passkeys, and the audit trail. docs/nis2.md maps every clause and lists what is missing - read the missing list before quoting anything from it to an auditor.',
    reference: 'Directive (EU) 2022/2555',
    related: ['audit-trail', 'evidence-export', 'sbom', 'build-provenance', 'mfa', 'data-retention'],
  },
  {
    id: 'audit-trail',
    term: 'Audit trail',
    expansion: null,
    aliases: ['audit log', 'audit_events', 'who changed what'],
    category: 'compliance',
    short:
      'The append-only record of who did what, from where, and whether it worked.',
    detail:
      'Every state-changing request writes one row to audit_events when the response finishes, so a failed request cannot be recorded as a success. Sign-ins of all three kinds (failures included), lockouts, password and passkey changes, and every user, domain, provider, setting and retention change are covered; a route that changes something without a label falls back to its HTTP verb and path rather than going unrecorded. Passwords, secrets and tokens are redacted at write time, and no code updates a row after it is written.',
    whyItMatters:
      'Read it under More -> Audit log. It answers questions a log on stdout cannot once the container is replaced: who disabled that account, and did anyone shorten the retention window before the evidence expired. Rows are kept for data.auditRetentionDays (365 by default).',
    reference: 'NIS2 Art. 21(2)(b)',
    related: ['evidence-export', 'data-retention', 'tamper-evidence'],
  },
  {
    id: 'evidence-export',
    term: 'Evidence export',
    expansion: null,
    aliases: ['audit export', 'X-Audit-Digest', 'audit csv'],
    category: 'compliance',
    short:
      'The CSV or JSON copy of the audit trail, carrying a digest of exactly the rows it contains.',
    detail:
      'The export endpoint returns CSV or JSON with X-Audit-Digest, a SHA-256 of the body; the JSON form also embeds the digest scoped to its events array. An export above 20,000 rows is refused rather than truncated, because a silently short export looks complete. Exporting is itself recorded as audit.export, including a refused attempt.',
    whyItMatters:
      'This is the artifact you keep, not the database. The digest shows the file was not altered after it left the app - check it with sha256sum against the header before filing it. Store copies off the host: there is no WORM storage here.',
    reference: null,
    related: ['audit-trail', 'tamper-evidence', 'data-retention'],
  },
  {
    id: 'data-retention',
    term: 'Data retention',
    expansion: null,
    aliases: ['retention policy', 'pruning', 'data.auditRetentionDays'],
    category: 'compliance',
    short:
      'The three settings that decide when reports and audit rows are deleted.',
    detail:
      'data.reportRetentionDays anchors on the report period end, data.forensicRetentionDays on arrival (falling back to the time the row was stored), and data.auditRetentionDays on the row timestamp. 0 means keep forever, which is the default for both report kinds. A preview shows how many rows each rule would delete before anything happens; runs happen shortly after start and every six hours.',
    whyItMatters:
      'Deletion is irreversible, and a backup taken earlier still contains the rows - so a retention period is only real if backups expire on the same schedule. Prune forensic reports first if you prune at all: they can contain the reported message itself, which is third-party content.',
    reference: 'NIS2 Art. 21(2)(a)',
    related: ['audit-trail', 'forensic-report', 'evidence-export'],
  },
  {
    id: 'tamper-evidence',
    term: 'Tamper evidence',
    expansion: null,
    aliases: ['hash chain', 'append-only', 'immutable log'],
    category: 'compliance',
    short:
      'Whether a log can be shown not to have been altered - and this app deliberately has no hash chain.',
    detail:
      'The audit table is append-only by application design: nothing updates or deletes a row except the retention prune, and that prune is itself audited. That is not the same as tamper-evident. Anyone holding the database file can rewrite it with sqlite3 and nothing would notice. A hash chain was considered and not built, because retention pruning breaks the chain at the boundary and a verifier that cannot verify is worse than an honest limit.',
    whyItMatters:
      'Say this precisely when it matters: an export digest proves the file you hold was not altered after export; it says nothing about the database. If you need more, ship exports to storage you cannot rewrite, on a schedule.',
    reference: null,
    related: ['audit-trail', 'evidence-export'],
  },
  {
    id: 'mfa',
    term: 'MFA',
    expansion: 'Multi-factor authentication',
    aliases: ['two-factor', '2FA', 'passkey', 'second factor'],
    category: 'compliance',
    short:
      'A second factor at sign-in: a passkey here, or the identity provider own MFA through OIDC.',
    detail:
      'Passkeys are WebAuthn credentials bound to the exact public origin, added alongside the password so a lost device never locks an account out. OIDC delegates the factor to the provider - this app reads identity only and never treats a claim as authority. Neither is enforced: an account can exist with a password alone.',
    whyItMatters:
      'Art 21(2)(j) names MFA explicitly. Available is not the same as enforced, so an operator has to set the policy and keep the recovery path working: password sign-in plus an administrator clearing passkeys from the Users screen.',
    reference: 'NIS2 Art. 21(2)(j)',
    related: ['nis2', 'audit-trail'],
  },
  {
    id: 'sbom',
    term: 'SBOM',
    expansion: 'Software bill of materials',
    aliases: ['bill of materials', 'dependency list', 'CycloneDX'],
    category: 'compliance',
    short: 'The dependency list of a published image, attested alongside it.',
    detail:
      'The publish workflow builds with sbom: true, which attaches an SBOM attestation to the pushed image instead of leaving a file in the repository that describes a commit nobody pulled. Inspect it from the artifact with docker buildx imagetools inspect --format "{{json .SBOM}}" <image>.',
    whyItMatters:
      'It answers what is in this and is any of it known-bad from the thing you actually run. It is one input to supply-chain questions; it is not a vulnerability scan and not an assessment of your other suppliers.',
    reference: 'NIS2 Art. 21(2)(d)',
    related: ['build-provenance', 'supply-chain-security', 'nis2'],
  },
  {
    id: 'build-provenance',
    term: 'Build provenance',
    expansion: null,
    aliases: ['attestation', 'gh attestation verify', 'image digest'],
    category: 'compliance',
    short:
      'A signed statement binding the image digest to the repository, commit and workflow run that produced it.',
    detail:
      'The publish workflow pushes a build-provenance attestation to the registry, so verification needs no trust in the README: gh attestation verify oci://ghcr.io/kristofer84/dmarc-parser:latest --repo kristofer84/dmarc-parser checks the signature against the subject digest and exits non-zero when it does not match.',
    whyItMatters:
      'This is what lets an operator write down that the artifact they run is the one built from a named commit. It also means an image cannot be quietly rebuilt from a different tree without verification failing.',
    reference: null,
    related: ['sbom', 'supply-chain-security', 'nis2'],
  },
  {
    id: 'supply-chain-security',
    term: 'Supply-chain security',
    expansion: null,
    aliases: ['supplier risk', 'dependency policy'],
    category: 'compliance',
    short:
      'The obligation to know and manage what your software depends on.',
    detail:
      'On this repository side that means committed lockfiles, npm ci, CI-gated publishing, Dependabot watching npm in backend and frontend plus the workflow actions and the Dockerfile, and attestations on the published image. It says nothing about your other suppliers, and nothing here assesses them.',
    whyItMatters:
      'When an auditor asks how you know this component is maintained, the answer is a disclosure policy, a dependency bot, a CI gate and an SBOM - and then the honest gaps listed in docs/nis2.md, rather than an implication that more is covered than is.',
    reference: 'NIS2 Art. 21(2)(d)',
    related: ['sbom', 'build-provenance', 'nis2', 'audit-trail'],
  },
  {
    id: 'dnssec',
    term: 'DNSSEC',
    expansion: 'DNS Security Extensions',
    aliases: ['RRSIG', 'signed zone', 'AD bit', 'validating resolver'],
    category: 'dns',
    short:
      'Signatures on DNS answers, so a resolver can prove the answer it got is the one the zone published.',
    detail:
      'The zone signs its records (RRSIG), publishes the public keys (DNSKEY), and the parent zone carries a digest of one of those keys (DS). That DS is the link in the chain: it is published at the registrar, not at the DNS provider. A validating resolver checks the whole path and refuses to answer if it fails - so a broken chain does not degrade, it makes the domain unresolvable. The AD bit on an answer means the resolver performed that validation; this app passes it through rather than claiming to validate locally.',
    whyItMatters:
      'The domain check reports whether the zone is signed, which keys exist, and - computed, not assumed - whether the DS at the registrar matches one of them. A DS that matches no key is the classic DNSSEC outage: the zone still answers to non-validating resolvers, so it looks fine until someone with a validating resolver tries.',
    reference: 'RFC 4033-4035',
    related: ['ds-record', 'key-tag', 'dns-txt-record', 'domain-check'],
  },
  {
    id: 'ds-record',
    term: 'DS record',
    expansion: 'Delegation Signer',
    aliases: ['Delegation Signer', 'DS at the parent', 'registrar DS'],
    category: 'dns',
    short:
      'A digest of one of the zone key-signing keys, published by the registrar in the parent zone.',
    detail:
      'DS lives in the parent (.net for xcds.net), which is why a DNS provider cannot publish it for you. It carries a key tag, an algorithm, a digest type (2 = SHA-256) and the digest itself: SHA-256 over the owner name in wire format plus the DNSKEY record. Two keys with identical material therefore have different DS digests under different domain names.',
    whyItMatters:
      'Enable DNSSEC at the DNS provider, then paste the DS the console prints into the registrar DNSSEC panel. During a key rollover, publish the new DS before removing the old one - a window with a DS that matches nothing is a window where the domain does not resolve for validators.',
    reference: 'RFC 4034 §5',
    related: ['dnssec', 'key-tag'],
  },
  {
    id: 'key-tag',
    term: 'Key tag',
    expansion: null,
    aliases: ['DS key tag', 'DNSKEY tag'],
    category: 'dns',
    short:
      'A 16-bit checksum of a DNSKEY, so a DS can name a key without copying it.',
    detail:
      'Computed over the DNSKEY RDATA (RFC 4034 Appendix B), and stable as long as the key does not change. It is not a fingerprint and carries no security: two keys can collide, which is why the DS also carries the algorithm and the full digest. It exists so a resolver can quickly find which key a DS refers to.',
    whyItMatters:
      'It is the number quoted when comparing what the registrar holds with what the zone publishes - this app prints it next to each key, and the CLI prints the DS lines with the tag first.',
    reference: 'RFC 4034 Appendix B',
    related: ['dnssec', 'ds-record'],
  },
];
