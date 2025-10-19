import axios, { AxiosInstance, AxiosError } from 'axios';
import type {
  ReportSummary,
  DetailedReport,
  DashboardStats,
  PaginatedResponse,
  ApiError,
  ReportsFilters,
  ProcessingLogEntry,
  ProcessingLogFilters,
  ProcessingStatus,
} from '@/types/api';

class ApiClient {
  private client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      baseURL: import.meta.env.VITE_API_BASE_URL || '/api',
      timeout: 10000,
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
