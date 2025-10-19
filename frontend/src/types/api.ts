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