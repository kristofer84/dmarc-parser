import axios, { AxiosInstance, AxiosError } from 'axios';
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/browser';
import type {
  OrganizationSummary,
  OrganizationMember,
  ReportSummary,
  DetailedReport,
  DashboardStats,
  Branding,
  PaginatedResponse,
  ApiError,
  ReportsFilters,
  ProcessingLogEntry,
  ProcessingLogFilters,
  ProcessingStatus,
  SessionInfo,
  SessionPolicy,
  PasskeySummary,
  ForensicReportSummary,
  ForensicReportDetail,
  ForensicSummary,
  ForensicFilters,
  AppSetting,
  MailboxTestResult,
  AuthProviderSummary,
  ProviderConfig,
  ProviderInput,
  ProviderTestResult,
  ManagedUser,
  AvailableDomain,
  DomainSummary,
  DomainDetail,
  DomainCheckReport,
  DomainHealthSummary,
  DomainCreateInput,
  DomainUpdateInput,
  RecordSuggestions,
  RecordSuggestionOptions,
  AuditEvent,
  AuditFilters,
  AuditActionCount,
  AuditExport,
  RetentionPlan,
  RetentionRunResult,
  TlsRptReport,
  TlsRptSummary,
  TlsRptFilters,
  StatsRange,
  SourcesResponse,
  AlertsResponse,
  AlertsFilters,
  AlertRow,
  DnsPlan,
  DnsApplyInput,
  DnsApplyResult,
  DmarcRuaResult,
  IngestInfo,
  OrgMailbox,
  OrgMailboxInput,
  DnsAccount,
  DnsAccountInput,
  DnsAccountVerification,
  OrganizationMemberInput,
} from '@/types/api';

/**
 * The API root, shared with the OIDC sign-in flow. That flow is a full page navigation rather
 * than a request - the browser has to be pointed at the server that answers with a 302 and sets
 * the session cookie - and in the dev setup that server is a different origin from the SPA, so
 * the path cannot be hardcoded as `/api/...` here.
 */
export const apiBaseUrl = import.meta.env.VITE_API_BASE_URL || '/api';

/**
 * The org sub-resource endpoints answer either `{ data: [...] }` or a bare array. One shape is
 * documented; reading both keeps a mismatch from blanking a page.
 */
function unwrapList<T>(body: unknown): T[] {
  if (Array.isArray(body)) {
    return body as T[];
  }
  const wrapped = (body as { data?: unknown } | null)?.data;
  return Array.isArray(wrapped) ? (wrapped as T[]) : [];
}

/** `{ <key>: row }` or the row itself - the create/update responses differ by resource. */
function unwrapOne<T>(body: unknown, key: string): T {
  const record = body as Record<string, unknown> | null;
  const wrapped = record?.[key];
  if (wrapped !== undefined) {
    return wrapped as T;
  }
  // Some routes answer `{ data: row }` instead of `{ <key>: row }`; accept both rather than
  // making the caller care which envelope a given endpoint chose.
  if (record?.data && typeof record.data === 'object' && !Array.isArray(record.data)) {
    return record.data as T;
  }
  return body as T;
}

class ApiClient {
  private client: AxiosInstance;
  private unauthorizedHandler: (() => void) | null = null;

  /** Registered by the app so an expired session can drop the SPA back to the login view. */
  setUnauthorizedHandler(handler: () => void): void {
    this.unauthorizedHandler = handler;
  }

  constructor() {
    this.client = axios.create({
      baseURL: apiBaseUrl,
      timeout: 10000,
      // The session cookie is the credential. Same-origin requests carry it anyway, but
      // the dev setup points VITE_API_BASE_URL at the host directly, which is cross-origin
      // - without this the login response's Set-Cookie is silently dropped.
      withCredentials: true,
      headers: {
        'Content-Type': 'application/json',
      },
    });

    // Request interceptor
    this.client.interceptors.request.use(
      (config) => {
        if (typeof localStorage !== 'undefined') {
          const orgId = localStorage.getItem('dmarc.activeOrgId');
          if (orgId) {
            config.headers = config.headers ?? {};
            config.headers['X-Org-Id'] = orgId;
          }
        }
        console.log(`🔄 API Request: ${config.method?.toUpperCase()} ${config.url}`);
        return config;
      },
      (error) => {
        console.error('❌ API Request Error:', error);
        return Promise.reject(error);
      }
    );

    // Response interceptor
    this.client.interceptors.response.use(
      (response) => {
        console.log(`✅ API Response: ${response.status} ${response.config.url}`);
        return response;
      },
      (error: AxiosError<ApiError>) => {
        console.error('❌ API Response Error:', error.response?.data || error.message);

        // A 401 on anything other than the auth endpoints means the session is gone.
        const url = error.config?.url ?? '';
        if (error.response?.status === 401 && !url.startsWith('/auth/')) {
          this.unauthorizedHandler?.();
        }
        // A stored organisation the account no longer belongs to must not wedge every page.
        if (
          error.response?.status === 403 &&
          error.response.data?.error?.code === 'ORG_FORBIDDEN' &&
          typeof localStorage !== 'undefined'
        ) {
          localStorage.removeItem('dmarc.activeOrgId');
        }

        return Promise.reject(this.handleError(error));
      }
    );
  }

  private handleError(error: AxiosError<ApiError>): Error {
    if (error.response?.data?.error) {
      const apiError = error.response.data.error;
      return new Error(`${apiError.code}: ${apiError.message}`);
    }
    
    if (error.code === 'ECONNABORTED') {
      return new Error('Request timeout - please try again');
    }
    
    if (error.code === 'ERR_NETWORK') {
      return new Error('Network error - please check your connection');
    }
    
    return new Error(error.message || 'An unexpected error occurred');
  }

  // Reports API
  async getReports(filters: ReportsFilters = {}): Promise<PaginatedResponse<ReportSummary>> {
    const params = new URLSearchParams();
    
    if (filters.domain) params.append('domain', filters.domain);
    if (filters.orgName) params.append('orgName', filters.orgName);
    if (filters.sourceIp) params.append('sourceIp', filters.sourceIp);
    if (filters.page) params.append('page', filters.page.toString());
    if (filters.limit) params.append('limit', filters.limit.toString());
    if (filters.sortBy) params.append('sortBy', filters.sortBy);
    if (filters.sortOrder) params.append('sortOrder', filters.sortOrder);

    const response = await this.client.get<PaginatedResponse<ReportSummary>>('/reports', {
      params: Object.fromEntries(params),
    });
    
    return response.data;
  }

  async getReportById(id: string): Promise<DetailedReport> {
    const response = await this.client.get<DetailedReport>(`/reports/${id}`);
    return response.data;
  }

  // Summary API
  /**
   * `range` scopes every figure and rebuckets the trend. Omitting it keeps the server's own
   * default, so a backend that predates the parameter still answers.
   */
  // ------------------------------------------------------------------ organisations
  async getOrganizations(): Promise<{ data: Array<OrganizationSummary & { counts?: Record<string, number> }> }> {
    const response = await this.client.get('/organizations');
    return response.data;
  }

  async createOrganization(name: string): Promise<{ organization: OrganizationSummary }> {
    const response = await this.client.post('/organizations', { name });
    return response.data;
  }

  async getOrganizationMembers(orgId: string): Promise<{ data: OrganizationMember[] }> {
    const response = await this.client.get(`/organizations/${encodeURIComponent(orgId)}/members`);
    return response.data;
  }

  async addOrganizationMember(
    orgId: string,
    input: { email: string; role: 'admin' | 'viewer'; name?: string; password?: string }
  ): Promise<{ member: OrganizationMember }> {
    const response = await this.client.post(`/organizations/${encodeURIComponent(orgId)}/members`, input);
    return response.data;
  }

  async updateOrganizationMemberRole(
    orgId: string,
    userId: string,
    role: 'admin' | 'viewer'
  ): Promise<{ member: OrganizationMember }> {
    const response = await this.client.patch(
      `/organizations/${encodeURIComponent(orgId)}/members/${encodeURIComponent(userId)}`,
      { role }
    );
    return response.data;
  }

  async removeOrganizationMember(orgId: string, userId: string): Promise<void> {
    await this.client.delete(
      `/organizations/${encodeURIComponent(orgId)}/members/${encodeURIComponent(userId)}`
    );
  }

  async signupOrganization(input: {
    organizationName: string;
    name: string;
    email: string;
    password: string;
  }): Promise<SessionInfo> {
    const response = await this.client.post<SessionInfo>('/auth/signup-org', input);
    return response.data;
  }

  // ------------------------------------------------------------------ org mailboxes
  async getOrgMailboxes(orgId: string): Promise<OrgMailbox[]> {
    const response = await this.client.get(
      `/organizations/${encodeURIComponent(orgId)}/mailboxes`
    );
    return unwrapList<OrgMailbox>(response.data);
  }

  async createOrgMailbox(orgId: string, input: OrgMailboxInput): Promise<OrgMailbox> {
    const response = await this.client.post(
      `/organizations/${encodeURIComponent(orgId)}/mailboxes`,
      input
    );
    return unwrapOne<OrgMailbox>(response.data, 'mailbox');
  }

  async updateOrgMailbox(
    orgId: string,
    id: string,
    input: Partial<OrgMailboxInput>
  ): Promise<OrgMailbox> {
    const response = await this.client.patch(
      `/organizations/${encodeURIComponent(orgId)}/mailboxes/${encodeURIComponent(id)}`,
      input
    );
    return unwrapOne<OrgMailbox>(response.data, 'mailbox');
  }

  async deleteOrgMailbox(orgId: string, id: string): Promise<void> {
    await this.client.delete(
      `/organizations/${encodeURIComponent(orgId)}/mailboxes/${encodeURIComponent(id)}`
    );
  }

  /** A refused connection is `ok: false` on a 200, so the body is the result either way. */
  async testOrgMailbox(orgId: string, id: string): Promise<MailboxTestResult> {
    const response = await this.client.post<MailboxTestResult>(
      `/organizations/${encodeURIComponent(orgId)}/mailboxes/${encodeURIComponent(id)}/test`,
      undefined,
      // A cold IMAP + TLS handshake routinely outlives the client's 10s default.
      { timeout: 30000 }
    );
    return response.data;
  }

  // ------------------------------------------------------------------ org DNS accounts
  async getDnsAccounts(orgId: string): Promise<DnsAccount[]> {
    const response = await this.client.get(
      `/organizations/${encodeURIComponent(orgId)}/dns-accounts`
    );
    return unwrapList<DnsAccount>(response.data);
  }

  async createDnsAccount(orgId: string, input: DnsAccountInput): Promise<DnsAccount> {
    const response = await this.client.post(
      `/organizations/${encodeURIComponent(orgId)}/dns-accounts`,
      input
    );
    return unwrapOne<DnsAccount>(response.data, 'dnsAccount');
  }

  async updateDnsAccount(
    orgId: string,
    id: string,
    input: Partial<Omit<DnsAccountInput, 'provider'>>
  ): Promise<DnsAccount> {
    const response = await this.client.patch(
      `/organizations/${encodeURIComponent(orgId)}/dns-accounts/${encodeURIComponent(id)}`,
      input
    );
    return unwrapOne<DnsAccount>(response.data, 'dnsAccount');
  }

  async deleteDnsAccount(orgId: string, id: string): Promise<void> {
    await this.client.delete(
      `/organizations/${encodeURIComponent(orgId)}/dns-accounts/${encodeURIComponent(id)}`
    );
  }

  /** One read-only list call upstream; a rejected credential set comes back as `ok: false`. */
  async verifyDnsAccount(orgId: string, id: string): Promise<DnsAccountVerification> {
    const response = await this.client.post<DnsAccountVerification>(
      `/organizations/${encodeURIComponent(orgId)}/dns-accounts/${encodeURIComponent(id)}/verify`,
      undefined,
      { timeout: 30000 }
    );
    return response.data;
  }

  async getSummary(range?: StatsRange): Promise<DashboardStats> {
    const response = await this.client.get<DashboardStats>('/summary', {
      params: range ? { range } : undefined,
    });
    return response.data;
  }

  // ------------------------------------------------------------------ sources
  async getSources(range: StatsRange = '30d', limit?: number): Promise<SourcesResponse> {
    const params: Record<string, string> = { range };
    if (limit) params.limit = String(limit);

    const response = await this.client.get<SourcesResponse>('/sources', { params });
    return response.data;
  }

  // ------------------------------------------------------------------ alerts
  async getAlerts(filters: AlertsFilters = {}): Promise<AlertsResponse> {
    const params: Record<string, string> = {};
    for (const [key, value] of Object.entries(filters)) {
      if (value !== undefined && value !== null && value !== '') {
        params[key] = String(value);
      }
    }

    const response = await this.client.get<AlertsResponse>('/alerts', { params });
    const data = response.data?.data ?? [];
    // `total` is the count before the limit; fall back to the page size if a proxy stripped it.
    return { data, total: response.data?.total ?? data.length };
  }

  /** The contract pins the action, not the envelope: accept the row or `{ alert }`. */
  async acknowledgeAlert(id: string): Promise<AlertRow | null> {
    const response = await this.client.post<AlertRow | { alert: AlertRow }>(
      `/alerts/${encodeURIComponent(id)}/ack`
    );
    const body = response.data as { alert?: AlertRow };
    return body?.alert ?? (response.data as AlertRow);
  }

  async getProcessingLogs(
    filters: ProcessingLogFilters = {}
  ): Promise<PaginatedResponse<ProcessingLogEntry>> {
    const params = new URLSearchParams();

    const validStatuses: ProcessingStatus[] = ['started', 'success', 'skipped', 'error'];

    if (filters.page) params.append('page', filters.page.toString());
    if (filters.limit) params.append('limit', filters.limit.toString());
    if (filters.sortBy) params.append('sortBy', filters.sortBy);
    if (filters.sortOrder) params.append('sortOrder', filters.sortOrder);
    if (filters.search) params.append('search', filters.search);
    if (filters.status) {
      if (!validStatuses.includes(filters.status)) {
        throw new Error('Invalid processing log status filter');
      }
      params.append('status', filters.status);
    }

    const response = await this.client.get<PaginatedResponse<ProcessingLogEntry>>(
      '/processing-logs',
      {
        params: Object.fromEntries(params),
      }
    );

    return {
      data: response.data.data.map(log => ({
        ...log,
        status: log.status as ProcessingStatus,
      })),
      pagination: response.data.pagination,
    };
  }

  // ------------------------------------------------------------------ authentication
  async login(email: string, password: string): Promise<SessionInfo> {
    const response = await this.client.post<SessionInfo>('/auth/login', { email, password });
    return { ...response.data, domains: response.data.domains ?? [] };
  }

  async logout(): Promise<void> {
    await this.client.post('/auth/logout');
  }

  async me(): Promise<SessionInfo> {
    const response = await this.client.get<SessionInfo>('/auth/me');
    return { ...response.data, domains: response.data.domains ?? [] };
  }

  async changePassword(currentPassword: string, newPassword: string): Promise<void> {
    await this.client.post('/auth/change-password', { currentPassword, newPassword });
  }

  async register(email: string, password: string, name?: string): Promise<SessionInfo> {
    const response = await this.client.post<SessionInfo>('/auth/register', { email, password, name });
    return { ...response.data, domains: response.data.domains ?? [] };
  }

  async sessionPolicy(): Promise<SessionPolicy> {
    const response = await this.client.get<SessionPolicy>('/auth/session-policy');
    return response.data;
  }

  /** Public: the login screen renders one button per enabled provider. */
  async listAuthProviders(): Promise<AuthProviderSummary[]> {
    const response = await this.client.get<{ providers: AuthProviderSummary[] }>(
      '/auth/providers'
    );
    return response.data.providers ?? [];
  }

  // ------------------------------------------------------------------ passkeys (WebAuthn)
  /**
   * The options endpoints hand back @simplewebauthn/browser's own JSON wire format, and the
   * verify endpoints take the response that library produced. Nothing here reshapes either
   * side: the challenge, base64url encoding and the server's session binding all depend on the
   * bytes being passed through as-is.
   */
  async passkeyRegisterOptions(): Promise<PublicKeyCredentialCreationOptionsJSON> {
    const response = await this.client.post<PublicKeyCredentialCreationOptionsJSON>(
      '/auth/webauthn/register/options'
    );
    return response.data;
  }

  async passkeyRegisterVerify(payload: RegistrationResponseJSON): Promise<PasskeySummary[]> {
    const response = await this.client.post<{ credentials: PasskeySummary[] }>(
      '/auth/webauthn/register/verify',
      payload
    );
    return response.data.credentials;
  }

  async passkeyLoginOptions(): Promise<PublicKeyCredentialRequestOptionsJSON> {
    const response = await this.client.post<PublicKeyCredentialRequestOptionsJSON>(
      '/auth/webauthn/login/options'
    );
    return response.data;
  }

  /** Sets the session cookie exactly like a password login, so it returns the same shape. */
  async passkeyLoginVerify(payload: AuthenticationResponseJSON): Promise<SessionInfo> {
    const response = await this.client.post<SessionInfo>('/auth/webauthn/login/verify', payload);
    return { ...response.data, domains: response.data.domains ?? [] };
  }

  async listPasskeys(): Promise<PasskeySummary[]> {
    const response = await this.client.get<{ credentials: PasskeySummary[] }>(
      '/auth/webauthn/credentials'
    );
    return response.data.credentials;
  }

  async removePasskey(id: string): Promise<void> {
    await this.client.delete(`/auth/webauthn/credentials/${id}`);
  }

  async dismissPasskeyPrompt(): Promise<void> {
    await this.client.post('/auth/webauthn/prompt-dismissed');
  }

  // ------------------------------------------------------------------ forensic reports
  async getForensics(filters: ForensicFilters = {}): Promise<PaginatedResponse<ForensicReportSummary>> {
    const params: Record<string, string> = {};
    for (const [key, value] of Object.entries(filters)) {
      if (value !== undefined && value !== null && value !== '') {
        params[key] = String(value);
      }
    }

    const response = await this.client.get<PaginatedResponse<ForensicReportSummary>>('/forensics', { params });
    return response.data;
  }

  async getForensicById(id: string): Promise<ForensicReportDetail> {
    const response = await this.client.get<ForensicReportDetail>(`/forensics/${id}`);
    return response.data;
  }

  async getForensicSummary(): Promise<ForensicSummary> {
    const response = await this.client.get<ForensicSummary>('/forensics/summary');
    return response.data;
  }

  // ------------------------------------------------------------------ domain status
  async getDomains(): Promise<DomainSummary[]> {
    const response = await this.client.get<{ data: DomainSummary[] }>('/domains');
    return response.data.data;
  }

  async getDomainSummary(): Promise<DomainHealthSummary> {
    const response = await this.client.get<DomainHealthSummary>('/domains/summary');
    return response.data;
  }

  async getDomainById(id: string): Promise<DomainDetail> {
    const response = await this.client.get<DomainDetail>(`/domains/${id}`);
    return response.data;
  }

  async checkDomain(id: string): Promise<DomainCheckReport> {
    const response = await this.client.post<DomainCheckReport>(`/domains/${id}/check`);
    return response.data;
  }

  async discoverDomains(): Promise<{ added: string[]; existing: number }> {
    const response = await this.client.post<{ added: string[]; existing: number }>('/domains/discover');
    return response.data;
  }

  async checkAllDomains(): Promise<{ checked: number; failed: number }> {
    const response = await this.client.post<{ checked: number; failed: number }>('/domains/check-all');
    return response.data;
  }

  async createDomain(payload: DomainCreateInput): Promise<DomainSummary> {
    const response = await this.client.post<{ domain: DomainSummary }>('/domains', payload);
    return response.data.domain;
  }

  async updateDomain(id: string, payload: DomainUpdateInput): Promise<DomainSummary> {
    const response = await this.client.patch<{ domain: DomainSummary }>(`/domains/${id}`, payload);
    return response.data.domain;
  }

  async deleteDomain(id: string): Promise<void> {
    await this.client.delete(`/domains/${id}`);
  }

  /**
   * Read-only advice: the endpoint never writes DNS. An omitted option makes the server fall
   * back to the configuration it would use on its own, which is what the builder shows first.
   */
  async suggestDomainRecords(
    id: string,
    options: RecordSuggestionOptions = {}
  ): Promise<RecordSuggestions> {
    const response = await this.client.post<RecordSuggestions>(`/domains/${id}/records`, options);
    return response.data;
  }

  /**
   * Reads the zone from the provider, so it is several upstream round-trips: the client default
   * of 10s is shorter than the server's own budget for them.
   */
  async getDnsPlan(name: string): Promise<DnsPlan> {
    const response = await this.client.get<DnsPlan>(
      `/domains/${encodeURIComponent(name)}/dns/plan`,
      { timeout: 30000 }
    );
    return response.data;
  }

  /** The server recomputes the plan before writing: `keys` names records, it never carries values. */
  async applyDnsPlan(name: string, payload: DnsApplyInput): Promise<DnsApplyResult> {
    const response = await this.client.post<DnsApplyResult>(
      `/domains/${encodeURIComponent(name)}/dns/apply`,
      payload,
      { timeout: 30000 }
    );
    return response.data;
  }

  async addDmarcRua(name: string): Promise<DmarcRuaResult> {
    const response = await this.client.post<DmarcRuaResult>(
      `/domains/${encodeURIComponent(name)}/dmarc/rua`,
      undefined,
      { timeout: 30000 }
    );
    return response.data;
  }

  /** Where this domain's reports are addressed, plus whether any have actually arrived. */
  async getDomainIngest(name: string): Promise<IngestInfo> {
    const response = await this.client.get<IngestInfo>(
      `/domains/${encodeURIComponent(name)}/ingest`
    );
    return response.data;
  }

  // ------------------------------------------------------------------ administration
  async getSettings(): Promise<{ data: AppSetting[]; categories: string[] }> {
    const response = await this.client.get<{ data: AppSetting[]; categories: string[] }>('/settings');
    return response.data;
  }

  async updateSetting(key: string, value: string): Promise<AppSetting> {
    const response = await this.client.patch<{ setting: AppSetting }>(`/settings/${key}`, { value });
    return response.data.setting;
  }

  /**
   * A mailbox that cannot be reached is reported as `ok: false` on a 200, so the body is the
   * result in both cases - only a broken endpoint or a transport failure rejects.
   */
  async testMailbox(payload: {
    host?: string;
    port?: number;
    user?: string;
    password?: string;
  }): Promise<MailboxTestResult> {
    const response = await this.client.post<MailboxTestResult>('/settings/mailbox/test', payload, {
      // A cold IMAP + TLS handshake routinely outlives the client's 10s default.
      timeout: 30000,
    });
    return response.data;
  }

  // ------------------------------------------------------------------ identity providers (OIDC)
  async getProviders(): Promise<ProviderConfig[]> {
    const response = await this.client.get<{ data: ProviderConfig[] }>('/providers');
    return response.data.data;
  }

  async createProvider(payload: ProviderInput): Promise<ProviderConfig> {
    const response = await this.client.post<{ provider: ProviderConfig }>('/providers', payload);
    return response.data.provider;
  }

  async updateProvider(id: string, payload: Partial<ProviderInput>): Promise<ProviderConfig> {
    const response = await this.client.patch<{ provider: ProviderConfig }>(
      `/providers/${id}`,
      payload
    );
    return response.data.provider;
  }

  async deleteProvider(id: string): Promise<void> {
    await this.client.delete(`/providers/${id}`);
  }

  /**
   * A provider that refuses to answer is reported as `ok: false` on a 200, so the body is the
   * result in both cases - only a broken endpoint or a transport failure rejects. Discovery plus
   * a JWKS fetch routinely outlives the client's 10s default.
   */
  async testProvider(id: string): Promise<ProviderTestResult> {
    const response = await this.client.post<ProviderTestResult>(
      `/providers/${id}/test`,
      undefined,
      { timeout: 30000 }
    );
    return response.data;
  }

  async getUsers(): Promise<ManagedUser[]> {
    const response = await this.client.get<{ data: ManagedUser[] }>('/users');
    return response.data.data;
  }

  async getAvailableDomains(): Promise<AvailableDomain[]> {
    const response = await this.client.get<{ data: AvailableDomain[] }>('/users/available-domains');
    return response.data.data;
  }

  async createUser(payload: {
    email: string;
    password: string;
    name?: string;
    role?: 'admin' | 'user';
    domains?: string[];
  }): Promise<ManagedUser> {
    const response = await this.client.post<{ user: ManagedUser }>('/users', payload);
    return response.data.user;
  }

  async updateUser(
    id: string,
    payload: { name?: string; role?: 'admin' | 'user'; isActive?: boolean; mustChangePassword?: boolean }
  ): Promise<ManagedUser> {
    const response = await this.client.patch<{ user: ManagedUser }>(`/users/${id}`, payload);
    return response.data.user;
  }

  async setUserDomains(id: string, domains: string[]): Promise<string[]> {
    const response = await this.client.put<{ domains: string[] }>(`/users/${id}/domains`, { domains });
    return response.data.domains;
  }

  async resetUserPassword(id: string, newPassword: string): Promise<void> {
    await this.client.post(`/users/${id}/password`, { newPassword });
  }

  async deleteUser(id: string): Promise<void> {
    await this.client.delete(`/users/${id}`);
  }

  /** The recovery path when a user loses their device: every credential, in one call. */
  async removeUserPasskeys(id: string): Promise<void> {
    await this.client.delete(`/users/${id}/passkeys`);
  }

  // ------------------------------------------------------------------ branding
  /** Public on the backend: the login screen needs it before a session exists. */
  async getBranding(): Promise<Branding> {
    const response = await this.client.get<Branding>('/branding');
    return response.data;
  }

  // ------------------------------------------------------------------ audit trail
  async getAuditEvents(
    filters: AuditFilters = {}
  ): Promise<PaginatedResponse<AuditEvent>> {
    const params: Record<string, string> = {};
    for (const [key, value] of Object.entries(filters)) {
      if (value !== undefined && value !== null && value !== '') {
        params[key] = String(value);
      }
    }

    const response = await this.client.get<PaginatedResponse<AuditEvent>>('/audit', { params });
    return response.data;
  }

  async getAuditActions(): Promise<AuditActionCount[]> {
    const response = await this.client.get<{ data: AuditActionCount[] }>('/audit/actions');
    return response.data.data;
  }

  /**
   * Downloads are blobs, not JSON, so the digest header has to be read here: axios cannot
   * expose a response header to the caller after returning only the body.
   */
  async exportAudit(filters: AuditFilters, format: 'csv' | 'json'): Promise<AuditExport> {
    const params: Record<string, string> = { format };
    for (const [key, value] of Object.entries(filters)) {
      if (key === 'page' || key === 'limit') continue;
      if (value !== undefined && value !== null && value !== '') {
        params[key] = String(value);
      }
    }

    const response = await this.client.get<Blob>('/audit/export', {
      params,
      responseType: 'blob',
      // An export of a large window can outlive the client's 10s default.
      timeout: 60000,
    });

    const disposition = String(response.headers['content-disposition'] ?? '');
    const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? null;
    const digest = response.headers['x-audit-digest'];
    const rows = response.headers['x-audit-rows'];

    return {
      blob: response.data,
      digest: typeof digest === 'string' ? digest : null,
      filename,
      rows: typeof rows === 'string' ? Number(rows) : null,
    };
  }

  // ------------------------------------------------------------------ TLS-RPT
  async getTlsRptReports(
    filters: TlsRptFilters = {}
  ): Promise<PaginatedResponse<TlsRptReport>> {
    const params: Record<string, string> = {};
    for (const [key, value] of Object.entries(filters)) {
      if (value !== undefined && value !== null && value !== '') {
        params[key] = String(value);
      }
    }
    const response = await this.client.get<PaginatedResponse<TlsRptReport>>('/tlsrpt', { params });
    return response.data;
  }

  async getTlsRptSummary(): Promise<TlsRptSummary> {
    const response = await this.client.get<TlsRptSummary>('/tlsrpt/summary');
    return response.data;
  }

  // ------------------------------------------------------------------ retention
  async getRetention(): Promise<RetentionPlan> {
    const response = await this.client.get<RetentionPlan>('/settings/retention');
    return response.data;
  }

  async runRetention(): Promise<RetentionRunResult> {
    const response = await this.client.post<RetentionRunResult>('/settings/retention/run');
    return response.data;
  }

  // Health check
  async healthCheck(): Promise<{ status: string; timestamp: string; uptime: number }> {
    // Use absolute URL to bypass the /api base URL
    const response = await axios.get('/health', {
      timeout: 5000,
      headers: {
        'Content-Type': 'application/json',
      },
    });
    return response.data;
  }
}

// Create singleton instance
export const apiClient = new ApiClient();

// Export individual methods for convenience
export const reportsApi = {
  getReports: (filters?: ReportsFilters) => apiClient.getReports(filters),
  getReportById: (id: string) => apiClient.getReportById(id),
};

export const summaryApi = {
  getSummary: (range?: StatsRange) => apiClient.getSummary(range),
};

export const organizationsApi = {
  list: () => apiClient.getOrganizations(),
  create: (name: string) => apiClient.createOrganization(name),
  members: (orgId: string) => apiClient.getOrganizationMembers(orgId),
  addMember: (orgId: string, input: OrganizationMemberInput) =>
    apiClient.addOrganizationMember(orgId, input),
  setRole: (orgId: string, userId: string, role: 'admin' | 'viewer') =>
    apiClient.updateOrganizationMemberRole(orgId, userId, role),
  removeMember: (orgId: string, userId: string) => apiClient.removeOrganizationMember(orgId, userId),
};

/** The mailboxes an organisation ingests from, and their write-only passwords. */
export const mailboxesApi = {
  list: (orgId: string) => apiClient.getOrgMailboxes(orgId),
  create: (orgId: string, input: OrgMailboxInput) => apiClient.createOrgMailbox(orgId, input),
  update: (orgId: string, id: string, input: Partial<OrgMailboxInput>) =>
    apiClient.updateOrgMailbox(orgId, id, input),
  remove: (orgId: string, id: string) => apiClient.deleteOrgMailbox(orgId, id),
  test: (orgId: string, id: string) => apiClient.testOrgMailbox(orgId, id),
};

/** DNS provider credentials owned by the organisation, shared by its domains. */
export const dnsAccountsApi = {
  list: (orgId: string) => apiClient.getDnsAccounts(orgId),
  create: (orgId: string, input: DnsAccountInput) => apiClient.createDnsAccount(orgId, input),
  update: (orgId: string, id: string, input: Partial<Omit<DnsAccountInput, 'provider'>>) =>
    apiClient.updateDnsAccount(orgId, id, input),
  remove: (orgId: string, id: string) => apiClient.deleteDnsAccount(orgId, id),
  verify: (orgId: string, id: string) => apiClient.verifyDnsAccount(orgId, id),
};

export const signupApi = {
  organization: (input: { organizationName: string; name: string; email: string; password: string }) =>
    apiClient.signupOrganization(input),
};

export const sourcesApi = {
  list: (range: StatsRange = '30d') => apiClient.getSources(range),
};

export const alertsApi = {
  list: (params?: AlertsFilters) => apiClient.getAlerts(params),
  ack: (id: string) => apiClient.acknowledgeAlert(id),
};

export const processingLogsApi = {
  getProcessingLogs: (filters?: ProcessingLogFilters) => apiClient.getProcessingLogs(filters),
};

export const healthApi = {
  check: () => apiClient.healthCheck(),
};

export const authApi = {
  login: (email: string, password: string) => apiClient.login(email, password),
  logout: () => apiClient.logout(),
  me: () => apiClient.me(),
  changePassword: (currentPassword: string, newPassword: string) =>
    apiClient.changePassword(currentPassword, newPassword),
  register: (email: string, password: string, name?: string) => apiClient.register(email, password, name),
  sessionPolicy: () => apiClient.sessionPolicy(),
  passkeyRegisterOptions: () => apiClient.passkeyRegisterOptions(),
  passkeyRegisterVerify: (payload: RegistrationResponseJSON) =>
    apiClient.passkeyRegisterVerify(payload),
  passkeyLoginOptions: () => apiClient.passkeyLoginOptions(),
  passkeyLoginVerify: (payload: AuthenticationResponseJSON) =>
    apiClient.passkeyLoginVerify(payload),
  listPasskeys: () => apiClient.listPasskeys(),
  removePasskey: (id: string) => apiClient.removePasskey(id),
  dismissPasskeyPrompt: () => apiClient.dismissPasskeyPrompt(),
  listProviders: () => apiClient.listAuthProviders(),
};

export const providersApi = {
  list: () => apiClient.getProviders(),
  create: (payload: ProviderInput) => apiClient.createProvider(payload),
  update: (id: string, payload: Partial<ProviderInput>) => apiClient.updateProvider(id, payload),
  remove: (id: string) => apiClient.deleteProvider(id),
  testProvider: (id: string) => apiClient.testProvider(id),
};

export const tlsRptApi = {
  list: (filters?: TlsRptFilters) => apiClient.getTlsRptReports(filters),
  summary: () => apiClient.getTlsRptSummary(),
};

export const forensicsApi = {
  list: (filters?: ForensicFilters) => apiClient.getForensics(filters),
  getById: (id: string) => apiClient.getForensicById(id),
  summary: () => apiClient.getForensicSummary(),
};

export const domainsApi = {
  list: () => apiClient.getDomains(),
  summary: () => apiClient.getDomainSummary(),
  getById: (id: string) => apiClient.getDomainById(id),
  check: (id: string) => apiClient.checkDomain(id),
  discover: () => apiClient.discoverDomains(),
  checkAll: () => apiClient.checkAllDomains(),
  create: (payload: DomainCreateInput) => apiClient.createDomain(payload),
  update: (id: string, payload: DomainUpdateInput) => apiClient.updateDomain(id, payload),
  remove: (id: string) => apiClient.deleteDomain(id),
  suggestRecords: (id: string, options?: RecordSuggestionOptions) =>
    apiClient.suggestDomainRecords(id, options),
  dnsPlan: (name: string) => apiClient.getDnsPlan(name),
  dnsApply: (name: string, payload: DnsApplyInput) => apiClient.applyDnsPlan(name, payload),
  dmarcRua: (name: string) => apiClient.addDmarcRua(name),
  ingest: (name: string) => apiClient.getDomainIngest(name),
};

export const settingsApi = {
  list: () => apiClient.getSettings(),
  update: (key: string, value: string) => apiClient.updateSetting(key, value),
  testMailbox: (payload: Parameters<typeof apiClient.testMailbox>[0]) => apiClient.testMailbox(payload),
  retention: () => apiClient.getRetention(),
  runRetention: () => apiClient.runRetention(),
};

export const auditApi = {
  list: (filters?: AuditFilters) => apiClient.getAuditEvents(filters),
  actions: () => apiClient.getAuditActions(),
  export: (filters: AuditFilters, format: 'csv' | 'json') => apiClient.exportAudit(filters, format),
};

export const brandingApi = {
  get: () => apiClient.getBranding(),
};

export const usersApi = {
  list: () => apiClient.getUsers(),
  availableDomains: () => apiClient.getAvailableDomains(),
  create: (payload: Parameters<typeof apiClient.createUser>[0]) => apiClient.createUser(payload),
  update: (id: string, payload: Parameters<typeof apiClient.updateUser>[1]) => apiClient.updateUser(id, payload),
  setDomains: (id: string, domains: string[]) => apiClient.setUserDomains(id, domains),
  resetPassword: (id: string, newPassword: string) => apiClient.resetUserPassword(id, newPassword),
  remove: (id: string) => apiClient.deleteUser(id),
  removePasskeys: (id: string) => apiClient.removeUserPasskeys(id),
};
