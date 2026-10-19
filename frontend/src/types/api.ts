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
  records: Array<{
    id: string;
    sourceIp: string;
    count: number;
    disposition: string;
    dkim: string;
    spf: string;
    headerFrom: string;
  }>;
}

export interface DashboardStats {
  totalReports: number;
  totalMessages: number;
  avgSpfPassRate: number;
  avgDkimPassRate: number;
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

export interface SessionInfo {
  user: AuthUser;
  domains: string[];
}

export interface SessionPolicy {
  registrationOpen: boolean;
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
  | 'autodiscover';

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
  type: 'TXT' | 'CNAME' | 'A';
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
