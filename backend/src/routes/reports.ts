import express from 'express';
import { prisma } from '../db/prisma.js';
import { ErrorResponse } from '../app.js';
import {
  validatePagination,
  validateSorting,
  validateUUID,
  validateQueryString,
  rateLimit
} from '../middleware/validation.js';

const router = express.Router();

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

// GET /reports - List all reports with optional filtering and pagination
router.get('/',
  rateLimit(50, 60000), // 50 requests per minute
  validatePagination,
  validateSorting(['domain', 'orgName', 'startDate', 'endDate', 'createdAt']),
  validateQueryString,
  async (req, res, next) => {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = Math.min(parseInt(req.query.limit as string) || 50, 100); // Max 100 per page
      const offset = (page - 1) * limit;

      const domain = req.query.domain as string;
      const orgName = req.query.orgName as string;
      const sortBy = req.query.sortBy as string || 'startDate';
      const sortOrder = req.query.sortOrder as string || 'desc';

      // Build WHERE conditions for case-insensitive search
      let whereClause = '';
      const queryParams: any[] = [];

      if (domain && orgName) {
        whereClause = 'WHERE LOWER(domain) LIKE LOWER(?) AND LOWER(orgName) LIKE LOWER(?)';
        queryParams.push(`%${domain}%`, `%${orgName}%`);
      } else if (domain) {
        whereClause = 'WHERE LOWER(domain) LIKE LOWER(?)';
        queryParams.push(`%${domain}%`);
      } else if (orgName) {
        whereClause = 'WHERE LOWER(orgName) LIKE LOWER(?)';
        queryParams.push(`%${orgName}%`);
      }

      // Build ORDER BY clause
      const validSortFields = ['domain', 'orgName', 'startDate', 'endDate', 'createdAt'];
      const sortField = validSortFields.includes(sortBy) ? sortBy : 'startDate';
      const sortDirection = sortOrder === 'asc' ? 'ASC' : 'DESC';

      // Define types for raw query results
      interface RawReport {
        id: string;
        domain: string;
        reportId: string;
        orgName: string;
        email: string;
        startDate: string;
        endDate: string;
        createdAt: string;
        updatedAt: string;
      }

      interface ReportRecord {
        id: string;
        reportId: string;
        sourceIp: string;
        count: number;
        disposition: string;
        dkim: string;
        spf: string;
        headerFrom: string;
      }

      interface ReportWithRecords extends RawReport {
        records: ReportRecord[];
      }

      // Get reports with case-insensitive filtering using raw SQL
      const reportsQuery = `
      SELECT * FROM reports 
      ${whereClause}
      ORDER BY ${sortField} ${sortDirection}
      LIMIT ? OFFSET ?
    `;

      const reports = await prisma.$queryRawUnsafe(
        reportsQuery,
        ...queryParams,
        limit,
        offset
      ) as RawReport[];

      // Get records for each report
      const reportsWithRecords: ReportWithRecords[] = await Promise.all(
        reports.map(async (report) => {
          const records = await prisma.record.findMany({
            where: { reportId: report.id },
          });
          return { ...report, records };
        })
      );

      // Get total count for pagination
      const countQuery = `SELECT COUNT(*) as count FROM reports ${whereClause}`;
      const totalCountResult = await prisma.$queryRawUnsafe(
        countQuery,
        ...queryParams
      ) as [{ count: number }];
      const totalCount = totalCountResult[0].count;

      // Transform to API format
      const reportSummaries: ReportSummary[] = reportsWithRecords.map((report: ReportWithRecords) => {
        const totalMessages = report.records.reduce((sum: number, record: ReportRecord) => sum + record.count, 0);
        const spfPassCount = report.records
          .filter((record: ReportRecord) => record.spf === 'pass')
          .reduce((sum: number, record: ReportRecord) => sum + record.count, 0);
        const dkimPassCount = report.records
          .filter((record: ReportRecord) => record.dkim === 'pass')
          .reduce((sum: number, record: ReportRecord) => sum + record.count, 0);

        // Determine primary policy action (most common disposition)
        const dispositionCounts = report.records.reduce((acc: Record<string, number>, record: ReportRecord) => {
          acc[record.disposition] = (acc[record.disposition] || 0) + record.count;
          return acc;
        }, {} as Record<string, number>);

        const primaryDisposition = Object.entries(dispositionCounts)
          .sort(([, a], [, b]) => (b as number) - (a as number))[0]?.[0] || 'none';

        return {
          id: report.id,
          domain: report.domain,
          orgName: report.orgName,
          startDate: new Date(report.startDate).toISOString(),
          endDate: new Date(report.endDate).toISOString(),
          totalMessages,
          spfPassRate: totalMessages > 0 ? Math.round((spfPassCount / totalMessages) * 100) : 0,
          dkimPassRate: totalMessages > 0 ? Math.round((dkimPassCount / totalMessages) * 100) : 0,
          policyAction: primaryDisposition,
        };
      });

      return res.json({
        data: reportSummaries,
        pagination: {
          page,
          limit,
          total: totalCount,
          pages: Math.ceil(totalCount / limit),
        },
      });

    } catch (error) {
      return next(error);
    }
  });

// GET /reports/:id - Get detailed report by ID
router.get('/:id',
  rateLimit(100, 60000), // 100 requests per minute
  validateUUID('id'),
  async (req, res, next) => {
    try {
      const { id } = req.params;

      const report = await prisma.report.findUnique({
        where: { id },
        include: {
          records: {
            orderBy: {
              count: 'desc', // Show highest volume records first
            },
          },
        },
      });

      if (!report) {
        const error: ErrorResponse = {
          error: {
            code: 'REPORT_NOT_FOUND',
            message: `Report with ID ${id} not found`,
          },
          timestamp: new Date().toISOString(),
          path: req.originalUrl,
        };

        return res.status(404).json(error);
      }

      // Calculate aggregated data
      const totalMessages = report.records.reduce((sum, record) => sum + record.count, 0);
      const spfPassCount = report.records
        .filter(record => record.spf === 'pass')
        .reduce((sum, record) => sum + record.count, 0);
      const dkimPassCount = report.records
        .filter(record => record.dkim === 'pass')
        .reduce((sum, record) => sum + record.count, 0);

      // Determine primary policy action
      const dispositionCounts = report.records.reduce((acc, record) => {
        acc[record.disposition] = (acc[record.disposition] || 0) + record.count;
        return acc;
      }, {} as Record<string, number>);

      const primaryDisposition = Object.entries(dispositionCounts)
        .sort(([, a], [, b]) => b - a)[0]?.[0] || 'none';

      const detailedReport: DetailedReport = {
        id: report.id,
        domain: report.domain,
        orgName: report.orgName,
        startDate: report.startDate.toISOString(),
        endDate: report.endDate.toISOString(),
        totalMessages,
        spfPassRate: totalMessages > 0 ? Math.round((spfPassCount / totalMessages) * 100) : 0,
        dkimPassRate: totalMessages > 0 ? Math.round((dkimPassCount / totalMessages) * 100) : 0,
        policyAction: primaryDisposition,
        records: report.records.map(record => ({
          id: record.id,
          sourceIp: record.sourceIp,
          count: record.count,
          disposition: record.disposition,
          dkim: record.dkim,
          spf: record.spf,
          headerFrom: record.headerFrom,
        })),
      };

      return res.json(detailedReport);

    } catch (error) {
      return next(error);
    }
  });

export default router;