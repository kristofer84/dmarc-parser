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
}

export interface SessionInfo {
  user: AuthUser;
  domains: string[];
}

export interface SessionPolicy {
  registrationOpen: boolean;
  sessionHours: number;
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
  updatedAt: string | null;
  updatedBy: string | null;
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