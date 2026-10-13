import axios, { AxiosInstance, AxiosError } from 'axios';
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/browser';
import type {
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
} from '@/types/api';

class ApiClient {
  private client: AxiosInstance;
  private unauthorizedHandler: (() => void) | null = null;

  /** Registered by the app so an expired session can drop the SPA back to the login view. */
  setUnauthorizedHandler(handler: () => void): void {
    this.unauthorizedHandler = handler;
  }

  constructor() {
    this.client = axios.create({
      baseURL: import.meta.env.VITE_API_BASE_URL || '/api',
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
  async getSummary(): Promise<DashboardStats> {
    const response = await this.client.get<DashboardStats>('/summary');
    return response.data;
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
    return { user: response.data.user, domains: response.data.domains ?? [] };
  }

  async logout(): Promise<void> {
    await this.client.post('/auth/logout');
  }

  async me(): Promise<SessionInfo> {
    const response = await this.client.get<SessionInfo>('/auth/me');
    return { user: response.data.user, domains: response.data.domains ?? [] };
  }

  async changePassword(currentPassword: string, newPassword: string): Promise<void> {
    await this.client.post('/auth/change-password', { currentPassword, newPassword });
  }

  async register(email: string, password: string, name?: string): Promise<SessionInfo> {
    const response = await this.client.post<SessionInfo>('/auth/register', { email, password, name });
    return { user: response.data.user, domains: response.data.domains ?? [] };
  }

  async sessionPolicy(): Promise<SessionPolicy> {
    const response = await this.client.get<SessionPolicy>('/auth/session-policy');
    return response.data;
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
    return { user: response.data.user, domains: response.data.domains ?? [] };
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
  getSummary: () => apiClient.getSummary(),
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
};

export const settingsApi = {
  list: () => apiClient.getSettings(),
  update: (key: string, value: string) => apiClient.updateSetting(key, value),
  testMailbox: (payload: Parameters<typeof apiClient.testMailbox>[0]) => apiClient.testMailbox(payload),
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
