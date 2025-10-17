import { parseString } from 'xml2js';
import { promisify } from 'util';
import * as zlib from 'zlib';

const parseXml = promisify(parseString);

export interface DmarcReport {
  reportMetadata: {
    orgName: string;
    email: string;
    reportId: string;
    dateRange: {
      begin: number;
      end: number;
    };
  };
  policyPublished: {
    domain: string;
    adkim?: string;
    aspf?: string;
    p: string;
    sp?: string;
    pct?: number;
  };
  records: DmarcRecord[];
}

export interface DmarcRecord {
  row: {
    sourceIp: string;
    count: number;
    policyEvaluated: {
      disposition: string;
      dkim: string;
      spf: string;
    };
  };
  identifiers: {
    headerFrom: string;
  };
  authResults: {
    dkim?: Array<{
      domain: string;
      result: string;
    }>;
    spf?: Array<{
      domain: string;
      result: string;
    }>;
  };
}

export class DmarcParser {
  async parseXmlReport(xmlContent: Buffer): Promise<DmarcReport> {
    try {
      // Try to decompress if it's gzipped
      let content = xmlContent;
      
      // Check if content is gzipped (starts with 1f 8b)
      if (xmlContent[0] === 0x1f && xmlContent[1] === 0x8b) {
        console.log('🔄 Decompressing gzipped XML content...');
        content = await this.decompressGzip(xmlContent);
      }
      
      // Check if content is zipped (starts with PK)
      if (xmlContent[0] === 0x50 && xmlContent[1] === 0x4b) {
        throw new Error('ZIP files are not supported yet. Please extract the XML manually.');
      }

      const xmlString = content.toString('utf-8');
      const parsed = await parseXml(xmlString);
      
      return this.transformParsedXml(parsed);
    } catch (error) {
      throw new Error(`Failed to parse DMARC XML: ${error}`);
    }
  }

  private async decompressGzip(content: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      zlib.gunzip(content, (err, result) => {
        if (err) {
          reject(new Error(`Failed to decompress gzip content: ${err.message}`));
          return;
        }
        resolve(result);
      });
    });
  }

  private transformParsedXml(parsed: any): DmarcReport {
    const feedback = parsed.feedback;
    
    if (!feedback) {
      throw new Error('Invalid DMARC XML: missing feedback element');
    }

    // Extract report metadata
    const reportMetadata = this.extractReportMetadata(feedback.report_metadata?.[0]);
    
    // Extract policy published
    const policyPublished = this.extractPolicyPublished(feedback.policy_published?.[0]);
    
    // Extract records
    const records = this.extractRecords(feedback.record || []);

    return {
      reportMetadata,
      policyPublished,
      records,
    };
  }

  private extractReportMetadata(metadata: any): DmarcReport['reportMetadata'] {
    if (!metadata) {
      throw new Error('Invalid DMARC XML: missing report_metadata');
    }

    return {
      orgName: this.getTextValue(metadata.org_name),
      email: this.getTextValue(metadata.email),
      reportId: this.getTextValue(metadata.report_id),
      dateRange: {
        begin: parseInt(this.getTextValue(metadata.date_range?.[0]?.begin), 10),
        end: parseInt(this.getTextValue(metadata.date_range?.[0]?.end), 10),
      },
    };
  }

  private extractPolicyPublished(policy: any): DmarcReport['policyPublished'] {
    if (!policy) {
      throw new Error('Invalid DMARC XML: missing policy_published');
    }

    return {
      domain: this.getTextValue(policy.domain),
      adkim: this.getTextValue(policy.adkim),
      aspf: this.getTextValue(policy.aspf),
      p: this.getTextValue(policy.p),
      sp: this.getTextValue(policy.sp),
      pct: policy.pct ? parseInt(this.getTextValue(policy.pct), 10) : undefined,
    };
  }

  private extractRecords(records: any[]): DmarcRecord[] {
    return records.map(record => {
      const row = record.row?.[0];
      const identifiers = record.identifiers?.[0];
      const authResults = record.auth_results?.[0];

      if (!row || !identifiers) {
        throw new Error('Invalid DMARC record: missing required fields');
      }

      return {
        row: {
          sourceIp: this.getTextValue(row.source_ip),
          count: parseInt(this.getTextValue(row.count), 10),
          policyEvaluated: {
            disposition: this.getTextValue(row.policy_evaluated?.[0]?.disposition),
            dkim: this.getTextValue(row.policy_evaluated?.[0]?.dkim),
            spf: this.getTextValue(row.policy_evaluated?.[0]?.spf),
          },
        },
        identifiers: {
          headerFrom: this.getTextValue(identifiers.header_from),
        },
        authResults: {
          dkim: authResults?.dkim?.map((d: any) => ({
            domain: this.getTextValue(d.domain),
            result: this.getTextValue(d.result),
          })),
          spf: authResults?.spf?.map((s: any) => ({
            domain: this.getTextValue(s.domain),
            result: this.getTextValue(s.result),
          })),
        },
      };
    });
  }

  private getTextValue(element: any): string {
    if (!element) return '';
    if (typeof element === 'string') return element;
    if (Array.isArray(element) && element.length > 0) return element[0];
    return '';
  }

  extractMetadata(report: DmarcReport): {
    domain: string;
    reportId: string;
    orgName: string;
    email: string;
    startDate: Date;
    endDate: Date;
  } {
    return {
      domain: report.policyPublished.domain,
      reportId: report.reportMetadata.reportId,
      orgName: report.reportMetadata.orgName,
      email: report.reportMetadata.email,
      startDate: new Date(report.reportMetadata.dateRange.begin * 1000),
      endDate: new Date(report.reportMetadata.dateRange.end * 1000),
    };
  }

  extractRecords(report: DmarcReport): Array<{
    sourceIp: string;
    count: number;
    disposition: string;
    dkim: string;
    spf: string;
    headerFrom: string;
  }> {
    return report.records.map(record => ({
      sourceIp: record.row.sourceIp,
      count: record.row.count,
      disposition: record.row.policyEvaluated.disposition,
      dkim: record.row.policyEvaluated.dkim,
      spf: record.row.policyEvaluated.spf,
      headerFrom: record.identifiers.headerFrom,
    }));
  }

  validateReport(report: DmarcReport): void {
    // Validate report metadata
    this.validateReportMetadata(report.reportMetadata);
    
    // Validate policy published
    this.validatePolicyPublished(report.policyPublished);
    
    // Validate records
    this.validateRecords(report.records);
  }

  private validateReportMetadata(metadata: DmarcReport['reportMetadata']): void {
    if (!metadata.orgName || metadata.orgName.trim() === '') {
      throw new Error('Invalid report: organization name is required');
    }
    
    if (!metadata.email || !this.isValidEmail(metadata.email)) {
      throw new Error('Invalid report: valid email is required');
    }
    
    if (!metadata.reportId || metadata.reportId.trim() === '') {
      throw new Error('Invalid report: report ID is required');
    }
    
    if (!metadata.dateRange.begin || !metadata.dateRange.end) {
      throw new Error('Invalid report: date range is required');
    }
    
    if (metadata.dateRange.begin >= metadata.dateRange.end) {
      throw new Error('Invalid report: start date must be before end date');
    }
    
    // Check if dates are reasonable (not too far in the past or future)
    const now = Date.now() / 1000;
    const oneYearAgo = now - (365 * 24 * 60 * 60);
    const oneWeekFromNow = now + (7 * 24 * 60 * 60);
    
    if (metadata.dateRange.begin < oneYearAgo || metadata.dateRange.end > oneWeekFromNow) {
      console.warn('⚠️ Report dates seem unusual:', {
        begin: new Date(metadata.dateRange.begin * 1000),
        end: new Date(metadata.dateRange.end * 1000),
      });
    }
  }

  private validatePolicyPublished(policy: DmarcReport['policyPublished']): void {
    if (!policy.domain || policy.domain.trim() === '') {
      throw new Error('Invalid report: domain is required');
    }
    
    if (!this.isValidDomain(policy.domain)) {
      throw new Error(`Invalid report: invalid domain format: ${policy.domain}`);
    }
    
    const validPolicies = ['none', 'quarantine', 'reject'];
    if (!validPolicies.includes(policy.p)) {
      throw new Error(`Invalid report: invalid policy '${policy.p}', must be one of: ${validPolicies.join(', ')}`);
    }
    
    if (policy.sp && !validPolicies.includes(policy.sp)) {
      throw new Error(`Invalid report: invalid subdomain policy '${policy.sp}', must be one of: ${validPolicies.join(', ')}`);
    }
    
    if (policy.pct !== undefined && (policy.pct < 0 || policy.pct > 100)) {
      throw new Error(`Invalid report: percentage must be between 0 and 100, got ${policy.pct}`);
    }
  }

  private validateRecords(records: DmarcRecord[]): void {
    if (!records || records.length === 0) {
      throw new Error('Invalid report: at least one record is required');
    }
    
    records.forEach((record, index) => {
      try {
        this.validateRecord(record);
      } catch (error) {
        throw new Error(`Invalid record at index ${index}: ${error}`);
      }
    });
  }

  private validateRecord(record: DmarcRecord): void {
    // Validate source IP
    if (!record.row.sourceIp || !this.isValidIpAddress(record.row.sourceIp)) {
      throw new Error(`Invalid source IP: ${record.row.sourceIp}`);
    }
    
    // Validate count
    if (!record.row.count || record.row.count < 0) {
      throw new Error(`Invalid count: ${record.row.count}`);
    }
    
    // Validate disposition
    const validDispositions = ['none', 'quarantine', 'reject'];
    if (!validDispositions.includes(record.row.policyEvaluated.disposition)) {
      throw new Error(`Invalid disposition: ${record.row.policyEvaluated.disposition}`);
    }
    
    // Validate DKIM and SPF results
    const validResults = ['pass', 'fail'];
    if (!validResults.includes(record.row.policyEvaluated.dkim)) {
      throw new Error(`Invalid DKIM result: ${record.row.policyEvaluated.dkim}`);
    }
    
    if (!validResults.includes(record.row.policyEvaluated.spf)) {
      throw new Error(`Invalid SPF result: ${record.row.policyEvaluated.spf}`);
    }
    
    // Validate header from domain
    if (!record.identifiers.headerFrom || !this.isValidDomain(record.identifiers.headerFrom)) {
      throw new Error(`Invalid header from domain: ${record.identifiers.headerFrom}`);
    }
  }

  private isValidEmail(email: string): boolean {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  }

  private isValidDomain(domain: string): boolean {
    const domainRegex = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
    return domainRegex.test(domain) && domain.length <= 253;
  }

  private isValidIpAddress(ip: string): boolean {
    // IPv4 regex
    const ipv4Regex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
    
    // IPv6 regex (simplified)
    const ipv6Regex = /^(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$|^::1$|^::$/;
    
    return ipv4Regex.test(ip) || ipv6Regex.test(ip);
  }

  transformToDbFormat(report: DmarcReport): {
    reportData: {
      domain: string;
      reportId: string;
      orgName: string;
      email: string;
      startDate: Date;
      endDate: Date;
    };
    records: Array<{
      sourceIp: string;
      count: number;
      disposition: string;
      dkim: string;
      spf: string;
      headerFrom: string;
    }>;
  } {
    const metadata = this.extractMetadata(report);
    const records = this.extractRecords(report);
    
    return {
      reportData: metadata,
      records,
    };
  }

  async parseAndValidate(xmlContent: Buffer): Promise<{
    reportData: {
      domain: string;
      reportId: string;
      orgName: string;
      email: string;
      startDate: Date;
      endDate: Date;
    };
    records: Array<{
      sourceIp: string;
      count: number;
      disposition: string;
      dkim: string;
      spf: string;
      headerFrom: string;
    }>;
  }> {
    try {
      console.log('🔄 Parsing DMARC XML report...');
      
      // Parse the XML
      const report = await this.parseXmlReport(xmlContent);
      
      // Validate the parsed data
      this.validateReport(report);
      
      // Transform to database format
      const dbData = this.transformToDbFormat(report);
      
      console.log('✅ DMARC report parsed and validated successfully');
      console.log(`📊 Report: ${dbData.reportData.domain} from ${dbData.reportData.orgName}`);
      console.log(`📈 Records: ${dbData.records.length} entries`);
      
      return dbData;
      
    } catch (error) {
      console.error('❌ DMARC parsing failed:', error);
      throw error;
    }
  }
}