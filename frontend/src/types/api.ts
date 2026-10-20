/** Public instance identity, read before login for the sign-in screen. */
export interface Branding {
  name: string;
  accent: string;
}

export interface ReportSummary {
  id: string;
  domain: string;
  orgName: string;
  startDate: string;
  endDate: string;
  totalMessages: number;
  spfPassRate: number;
  dkimPassRate: number;
  policyAction: string;
}

export interface DetailedReport extends ReportSummary {
  /** `policy_published`; every field is null on reports ingested before it was stored. */
  policy: {
    p: string | null;
    sp: string | null;
    pct: number | null;
    adkim: string | null;
    aspf: string | null;
  };
  records: Array<{
    id: string;
    sourceIp: string;
    count: number;
    disposition: string;
    dkim: string;
    spf: string;
    headerFrom: string;
    /** Raw `auth_results` from the receiver: which domain/selector actually produced the verdict. */
    dkimAuth: Array<{ domain: string; result: string }>;
    spfAuth: Array<{ domain: string; result: string }>;
  }>;
}

export interface DashboardStats {
  totalReports: number;
  totalMessages: number;
  avgSpfPassRate: number;
  avgDkimPassRate: number;
  /**
   * Policy-evaluated DMARC pass rate (SPF or DKIM pass) for the requested range. Optional
   * because an older backend answers without it; the card falls back to 0 rather than "NaN%".
   */
  avgDmarcPassRate?: number;
  /** Echoed back when the summary was requested with `?range=`; the UI labels its buckets. */
  range?: StatsRange;
  since?: string | null;
  policyDistribution: {
    none: number;
    quarantine: number;
    reject: number;
  };
  trendsData: Array<{
    date: string;
    messageCount: number;
    failureRate: number;
  }>;
  topSources: Array<{
    orgName: string;
    reportCount: number;
    messageCount: number;
  }>;
  topIPs: Array<{
    sourceIp: string;
    messageCount: number;
    failureRate: number;
  }>;
}

export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    pages: number;
  };
}

export interface ApiError {
  error: {
    code: string;
    message: string;
    details?: any;
  };
  timestamp: string;
  path: string;
}

export interface LoadingState {
  loading: boolean;
  error: string | null;
}

export interface ReportsFilters {
  domain?: string;
  orgName?: string;
  /** Exact match on a record's source IP, so the sources view can link into a report list. */
  sourceIp?: string;
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

export type ProcessingStatus = 'started' | 'success' | 'skipped' | 'error';

export interface ProcessingLogEntry {
  id: string;
  createdAt: string;
  messageUid: number | null;
  attachmentName: string | null;
  status: ProcessingStatus;
  details: string | null;
  reportId: string | null;
  report: {
    id: string;
    domain: string;
    orgName: string;
  } | null;
}

export interface ProcessingLogFilters {
  page?: number;
  limit?: number;
  status?: ProcessingStatus;
  search?: string;
  sortBy?: 'createdAt' | 'status' | 'attachmentName' | 'messageUid';
  sortOrder?: 'asc' | 'desc';
}

// ---------------------------------------------------------------- authentication
export interface AuthUser {
  id: string;
  email: string;
  name: string | null;
  role: 'admin' | 'user';
  mustChangePassword: boolean;
  passkeyCount: number;
  /** Sticky on the server, so the invitation to add a passkey is asked at most once. */
  passkeyPromptDismissed: boolean;
}

export interface OrganizationSummary {
  id: string;
  name: string;
  slug: string;
  role: 'admin' | 'viewer';
  createdAt: string;
}

export interface OrganizationMember {
  userId: string;
  email: string;
  name: string | null;
  role: 'admin' | 'viewer';
  createdAt: string;
}

export interface OrganizationMemberInput {
  email: string;
  role: 'admin' | 'viewer';
  /** Only used when the account does not exist yet; ignored for an existing address. */
  name?: string;
  /** Only used when the account is created; an existing account keeps its password. */
  password?: string;
}

/**
 * An IMAP mailbox owned by an organisation. The password is write-only: the API only ever
 * reports whether one is stored, so the UI must never expect the value back.
 */
export interface OrgMailbox {
  id: string;
  label: string;
  host: string;
  port: number;
  user: string;
  verifyTls: boolean;
  enabled: boolean;
  passwordSet: boolean;
  lastRunAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OrgMailboxInput {
  label: string;
  host: string;
  port: number;
  user: string;
  /** Blank or absent keeps the stored password - the value is never returned to fill a form. */
  password?: string;
  verifyTls?: boolean;
  enabled?: boolean;
}

/**
 * A one-click hosted address: a **plus alias** on a mailbox this instance already ingests.
 *
 *     dmarc@example.com  →  dmarc+<token>@example.com
 *
 * There is no MX or catch-all behind it: the receiving server drops the plus address into the
 * base mailbox and this app routes it by the token in `Delivered-To` / `X-Original-To` / `To`.
 * The token is part of the address the operator publishes, so it is returned as well.
 */
export interface HostedAddress {
  id: string;
  label: string;
  token: string;
  address: string;
  /** Null means the legacy mailbox configuration (the Default organisation's virtual mailbox). */
  baseMailbox: { id: string; label: string } | null;
  enabled: boolean;
  lastReportAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface HostedAddressInput {
  label: string;
  /** Omitted keeps the server's default: the first enabled mailbox, else the legacy mailbox. */
  baseMailboxId?: string | null;
}

/** DNS credentials belong to an organisation, never to a domain. */
export type DnsAccountProvider = 'cloudflare' | 'loopia';

export interface CloudflareCredentials {
  token: string;
}

export interface LoopiaCredentials {
  username: string;
  password: string;
}

export type DnsAccountCredentials = CloudflareCredentials | LoopiaCredentials;

export interface DnsAccount {
  id: string;
  label: string;
  provider: DnsAccountProvider;
  enabled: boolean;
  /** The credentials themselves are never returned, only whether a set is stored. */
  credentialSet: boolean;
  /** How many domains are assigned to this account; absent on a create/update response. */
  domainCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface DnsAccountInput {
  label: string;
  /** Immutable after creation: the credential shape depends on it. */
  provider: DnsAccountProvider;
  enabled?: boolean;
  /** Blank or absent keeps the stored credentials. */
  credentials?: DnsAccountCredentials;
}

/** A refused credential check arrives as `ok: false`, so it is a result rather than an error. */
export interface DnsAccountVerification {
  ok: boolean;
  message?: string;
  /** What the credentials can see at the provider: zone or domain names. */
  visible?: string[];
}

/** Unsaved credentials are checked with the same call shape and answer the same envelope. */
export type DnsAccountTestResult = DnsAccountVerification;

export interface DnsAccountTestInput {
  provider: DnsAccountProvider;
  credentials: DnsAccountCredentials;
}

export interface SessionInfo {
  user: AuthUser;
  domains: string[];
  /** Present on `/auth/me` and password login; absent on older passkey/verify responses. */
  organizations?: OrganizationSummary[];
  activeOrganizationId?: string | null;
  orgRole?: 'admin' | 'viewer' | null;
  isSuperAdmin?: boolean;
}

export interface SessionPolicy {
  registrationOpen: boolean;
  orgSignupOpen: boolean;
  sessionHours: number;
  /** False when the deployment has WebAuthn switched off: no passkey UI anywhere. */
  passkeysEnabled: boolean;
}

/** One registered credential, as the server describes it back to us. */
export interface PasskeySummary {
  id: string;
  label: string | null;
  deviceType: 'singleDevice' | 'multiDevice' | null;
  backedUp: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

// ---------------------------------------------------------------- forensic (RUF)
export interface ForensicReportSummary {
  id: string;
  domain: string;
  reportedDomain: string | null;
  reporter: string | null;
  reporterEmail: string | null;
  sourceIp: string | null;
  arrivalDate: string | null;
  createdAt: string;
  originalMailFrom: string | null;
  originalRcptTo: string | null;
  spfResult: string | null;
  dkimResult: string | null;
  dmarcResult: string | null;
  dkimSelector: string | null;
  identityAlignment: string | null;
  reportedSubject: string | null;
  reportedFrom: string | null;
  reportedMessageId: string | null;
  reportAuthenticated: boolean;
  userAgent: string | null;
}

export interface ForensicReportDetail extends ForensicReportSummary {
  reportingMta: string | null;
  feedbackType: string;
  reportVersion: string | null;
  originalEnvelopeId: string | null;
  incidents: string | null;
  authResults: string | null;
  dkimDomain: string | null;
  dkimIdentity: string | null;
  reportedTo: string | null;
  reportedDate: string | null;
  reportedHeaders: string | null;
  reportedBody: string | null;
  rawFeedback: string | null;
  reportAuthDetail: string | null;
  sourceMessageId: string | null;
  sourceMessageUid: number | null;
  updatedAt: string;
  processingLogs: Array<{
    id: string;
    createdAt: string;
    status: string;
    details: string | null;
    messageUid: number | null;
  }>;
}

export interface ForensicSummary {
  total: number;
  last24h: number;
  last7d: number;
  unverified: number;
  domains: number;
  topSources: Array<{ sourceIp: string; count: number; lastSeen: string | null }>;
  topDomains: Array<{ domain: string; count: number }>;
  topReporters: Array<{ reporter: string; count: number }>;
  trendsData: Array<{ date: string; count: number }>;
}

export interface ForensicFilters {
  domain?: string;
  sourceIp?: string;
  reporter?: string;
  verified?: 'true' | 'false' | '';
  from?: string;
  to?: string;
  search?: string;
  page?: number;
  limit?: number;
  sortBy?: 'arrivalDate' | 'createdAt' | 'domain' | 'sourceIp' | 'reporter';
  sortOrder?: 'asc' | 'desc';
}

// ---------------------------------------------------------------- administration
export interface AppSetting {
  key: string;
  type: 'boolean' | 'number' | 'string';
  default: string;
  value: string;
  label: string;
  description: string;
  category: string;
  min?: number;
  max?: number;
  dangerous?: boolean;
  /** A credential: the API never returns its value, only whether one is stored. */
  secret?: boolean;
  isSet?: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}

/** A failed connection comes back as `ok: false` on a 200, so it is a result, not an error. */
export interface MailboxTestResult {
  ok: boolean;
  message: string;
  greeting?: string;
}

/**
 * The mailbox form's own values, tested before anything is written. `id` makes a blank password
 * fall back to the stored one, so editing does not require retyping it.
 */
export interface MailboxTestInput {
  id?: string;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  verifyTls?: boolean;
}

export interface ManagedUser {
  id: string;
  email: string;
  name: string | null;
  role: 'admin' | 'user';
  isActive: boolean;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  lockedUntil: string | null;
  createdAt: string;
  domains: string[];
  activeSessions: number;
}

export interface AvailableDomain {
  domain: string;
  assignedUsers: number;
}

// ---------------------------------------------------------------- domain status
export type DomainCheckStatus = 'ok' | 'warn' | 'error' | 'info' | 'skipped';

export interface DomainCheckResult {
  /** Stable slug, e.g. 'mx', 'spf', 'dmarc'. DKIM uses 'dkim:<selector>'. */
  id: string;
  label: string;
  status: DomainCheckStatus;
  summary: string;
  /** What the record does and what breaks without it - shown with every result. */
  purpose: string;
  details?: string[];
  fix?: string;
}

/** A single point of the per-domain trend sparkline, oldest first. */
export interface DomainRecentCheck {
  status: DomainCheckStatus;
  runAt: string;
}

export interface DomainSummary {
  id: string;
  name: string;
  monitored: boolean;
  dkimSelectors: string[];
  expectedMx: string[];
  notes: string | null;
  /** Owning organisation; null when the domain was discovered but not yet claimed. */
  organization: { id: string; name: string } | null;
  /** DNS account Apply-to-DNS uses, when assigned. */
  dnsAccount: { id: string; label: string; provider: string } | null;
  createdAt: string;
  updatedAt: string;
  lastCheck: {
    status: DomainCheckStatus;
    runAt: string;
    durationMs: number;
    results: DomainCheckResult[];
  } | null;
  /** Up to 14 of the most recent runs, oldest first. */
  recent: DomainRecentCheck[];
}

export interface DomainCheckReport {
  domain: string;
  checkedAt: string;
  durationMs: number;
  status: DomainCheckStatus;
  results: DomainCheckResult[];
  dkimSelectors: string[];
}

export interface DomainHistoryEntry {
  status: DomainCheckStatus;
  runAt: string;
  durationMs: number;
  results: DomainCheckResult[];
}

export interface DomainDetail {
  domain: DomainSummary;
  history: DomainHistoryEntry[];
}

export type GeneratedRecordId =
  | 'spf'
  | 'dmarc'
  | 'dkim'
  | 'mta-sts'
  | 'tls-rpt'
  | 'caa'
  | 'autodiscover'
  | 'dnssec';

/** `missing`/`outdated` are faults, `needs-input` is a question for the operator, `ok` is done. */
export type GeneratedRecordStatus = 'missing' | 'ok' | 'outdated' | 'needs-input';

/** One selectable SPF include, e.g. Mailjet's `_spf.mailjet.com`. */
export interface SpfProvider {
  id: string;
  label: string;
  include: string;
  docs: string;
}

export interface GeneratedRecord {
  id: GeneratedRecordId;
  label: string;
  /** What this record is for, in the same voice as DomainCheckResult.purpose. */
  purpose: string;
  status: GeneratedRecordStatus;
  /** '@', '_dmarc', 'mailjet._domainkey', ... */
  host: string;
  type: 'TXT' | 'CNAME' | 'A' | 'DS';
  value: string;
  ttl: number;
  /** The gotchas: lookup limits, propagation, provider caveats. */
  notes: string[];
  /** MTA-STS only: the policy document that has to be served at that path. */
  companionFile?: { path: string; content: string };
  /** DKIM only: where this selector's key comes from. */
  providerHint?: string;
}

export interface RecordSuggestions {
  domain: string;
  generatedAt: string;
  providers: SpfProvider[];
  records: GeneratedRecord[];
}

/** Omitted keys mean "whatever the server would generate on its own". */
export interface RecordSuggestionOptions {
  providers?: string[];
  dmarcPolicy?: 'none' | 'quarantine' | 'reject';
  rua?: string;
  ruf?: string;
  mtaStsMode?: 'testing' | 'enforce';
}

export interface DomainHealthSummary {
  total: number;
  ok: number;
  warn: number;
  error: number;
  neverChecked: number;
  needsAttention: Array<{ id: string; name: string; status: DomainCheckStatus; problems: string[] }>;
}

export interface DomainCreateInput {
  name: string;
  dkimSelectors?: string[];
  expectedMx?: string[];
  notes?: string;
  monitored?: boolean;
}

export interface DomainUpdateInput {
  dkimSelectors?: string[];
  expectedMx?: string[];
  notes?: string;
  monitored?: boolean;
  /** Superadmin only: move the domain to another organisation (null = unowned). */
  orgId?: string | null;
  /** Named DNS account; must belong to the domain's organisation. */
  dnsAccountId?: string | null;
}

// ---------------------------------------------------------------- identity providers (OIDC)
/** The login screen's view: enabled providers only, and never a secret. */
export interface AuthProviderSummary {
  id: string;
  name: string;
  type: 'oidc';
}

export interface ProviderConfig {
  id: string;
  name: string;
  type: 'oidc';
  enabled: boolean;
  issuer: string;
  clientId: string;
  /** The secret itself is never returned, only whether one is stored. */
  clientSecretSet: boolean;
  scopes: string;
  allowAutoProvision: boolean;
  trustUnverifiedEmail: boolean;
  defaultDomains: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ProviderInput {
  name: string;
  issuer: string;
  clientId: string;
  /** Omitted or blank on edit means "keep the stored secret". */
  clientSecret?: string;
  scopes?: string;
  enabled?: boolean;
  allowAutoProvision?: boolean;
  trustUnverifiedEmail?: boolean;
  defaultDomains?: string[];
}

/** A refused test arrives as `ok: false` on a 200, so it is a result rather than an error. */
export interface ProviderTestResult {
  ok: boolean;
  message: string;
  endpoints?: {
    issuer: string;
    authorization_endpoint: string;
    token_endpoint: string;
    jwks_uri: string;
  };
}
// ------------------------------------------------------------------ audit trail

export type AuditOutcome = 'success' | 'failure';

/** One row of the audit trail. `detail` is a JSON string, redacted server-side. */
export interface AuditEvent {
  id: string;
  createdAt: string;
  actor: string;
  action: string;
  outcome: AuditOutcome;
  target: string | null;
  ip: string | null;
  userAgent: string | null;
  detail: string | null;
}

export interface AuditFilters {
  actor?: string;
  /** Exact action, or a family when it ends with '.' (e.g. `auth.`). */
  action?: string;
  outcome?: AuditOutcome | '';
  target?: string;
  /** Inclusive, ISO date. */
  from?: string;
  /** Inclusive calendar day; the client sends the end of it. */
  to?: string;
  page?: number;
  limit?: number;
}

export interface AuditActionCount {
  action: string;
  count: number;
}

export interface AuditExport {
  blob: Blob;
  /** SHA-256 of the file body, as reported by the server. Null if the header was stripped. */
  digest: string | null;
  filename: string | null;
  rows: number | null;
}

// ------------------------------------------------------------------ retention

export type RetentionRuleKey = 'reports' | 'forensics' | 'audit';

export interface RetentionRule {
  key: RetentionRuleKey;
  setting: string;
  /** 0 means "keep forever", and `cutoff` is then null. */
  retentionDays: number;
  cutoff: string | null;
  pending: number;
}

export interface RetentionPlan {
  generatedAt: string;
  rules: RetentionRule[];
}

export interface RetentionRunResult {
  plan: RetentionPlan;
  deleted: Record<RetentionRuleKey, number>;
}

// ------------------------------------------------------------------ TLS-RPT (RFC 8460)

export interface TlsRptFailureDetail {
  resultType: string;
  count: number;
  sendingMtaIp?: string;
  receivingMxHostname?: string;
  failureReasonCode?: string;
  additionalInformation?: string;
}

export interface TlsRptReport {
  id: string;
  reportId: string | null;
  orgName: string | null;
  contactInfo: string | null;
  dateBegin: string;
  dateEnd: string;
  policyDomain: string;
  policyType: string;
  mxHost: string;
  successfulCount: number;
  failureCount: number;
  failureDetails: TlsRptFailureDetail[];
  /** The policy the reporter fetched, as published at report time. */
  policyString: string[] | null;
  createdAt: string;
}

export interface TlsRptSummary {
  reports: number;
  successful: number;
  failed: number;
  lastReportAt: string | null;
  byDomain: Array<{ domain: string; successful: number; failed: number }>;
  byResultType: Array<{ resultType: string; count: number }>;
}

export interface TlsRptFilters {
  domain?: string;
  failuresOnly?: boolean;
  from?: string;
  to?: string;
  page?: number;
  limit?: number;
}

// ------------------------------------------------------------------ sources (per-IP analytics)

/** The windows every ranged endpoint accepts. `all` means "no lower bound". */
export type StatsRange = '7d' | '30d' | '90d' | 'all';

export interface SourcesTotals {
  messages: number;
  failures: number;
  dmarcPassRate: number;
  sourceCount: number;
}

/**
 * One sending IP. Pass rates are the policy-evaluated results the reporters applied, so this
 * view never recomputes alignment - it only counts what arrived.
 */
export interface SourceRow {
  sourceIp: string;
  messages: number;
  failures: number;
  dmarcPassRate: number;
  spfPassRate: number;
  dkimPassRate: number;
  /** Record counts per disposition: `{ none, quarantine, reject }`. */
  dispositions: Record<string, number>;
  domains: string[];
  organizations: string[];
  /** First/last sighting over all time, not just the selected range: that is what makes a
   *  source recognisable as new. */
  firstSeen: string | null;
  lastSeen: string | null;
}

export interface SourcesResponse {
  range: StatsRange;
  since: string | null;
  totals: SourcesTotals;
  sources: SourceRow[];
}

// ------------------------------------------------------------------ alerts

export type AlertKind = 'new_source' | 'failure_spike';

/** The server's severity vocabulary; an unknown value falls back to a neutral chip. */
export type AlertSeverity = 'info' | 'warning' | 'critical';

export interface AlertRow {
  id: string;
  createdAt: string;
  kind: AlertKind | string;
  severity: AlertSeverity | string;
  domain: string;
  sourceIp: string | null;
  title: string;
  /** Parsed by the API; a string is still tolerated so a future change cannot break the list. */
  detail: Record<string, unknown> | string | null;
  dedupKey?: string;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  deliveredAt: string | null;
}

export interface AlertsResponse {
  data: AlertRow[];
  total: number;
}

export interface AlertsFilters {
  status?: 'open' | 'acknowledged' | 'all';
  range?: StatsRange;
  limit?: number;
}

// ------------------------------------------------------------------ DNS apply (Cloudflare)

/** `unsupported` rows are never applied: they cannot be expressed as a record this API owns. */
export type DnsAction = 'create' | 'update' | 'unchanged' | 'unsupported';

export interface DnsPlanRecord {
  key: string;
  label?: string;
  type: string;
  name: string;
  value: string;
  /** What DNS currently answers for this name+type; several values can legitimately coexist. */
  current: string[];
  action: DnsAction;
  reason?: string;
}

export interface DnsZone {
  id: string;
  name: string;
}

export interface DnsPlan {
  provider: string;
  /**
   * The organisation DNS account the plan was read with; null for the legacy env/settings
   * credentials. Optional because a backend that predates org accounts does not send it.
   */
  account?: { id: string; label: string; provider: string } | null;
  /** Null when the domain (or any parent) is not a zone in the configured account. */
  zone: DnsZone | null;
  records: DnsPlanRecord[];
  warnings: string[];
}

export interface DnsApplyInput {
  keys: string[];
  overwrite: boolean;
}

export interface DnsApplyApplied {
  key: string;
  action: string;
  recordId?: string | null;
}

export interface DnsApplySkipped {
  key: string;
  reason: string;
  current?: string | string[] | null;
}

export interface DnsApplyResult {
  applied: DnsApplyApplied[];
  skipped: DnsApplySkipped[];
}

export interface DmarcRuaResult {
  value: string;
  previous: string | null;
  recordId: string | null;
}

// ------------------------------------------------------------------ ingest address

export interface IngestInfo {
  rua: string | null;
  ruf: string | null;
  configured: boolean;
  lastReportAt: string | null;
  reports30d: number;
  /** At least one report for this domain inside the last 30 days. */
  verified: boolean;
}
