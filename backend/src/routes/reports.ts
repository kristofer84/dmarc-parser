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
import {
  getDomainScope,
  requireAuth,
  type AuthenticatedRequest,
} from '../middleware/auth.js';

const router = express.Router();

// Report data is behind authentication; non-admins are limited to their assigned domains.
router.use(requireAuth);

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
  validateSorting(['domain', 'orgName', 'startDate', 'endDate', 'createdAt', 'totalMessages', 'spfPassRate', 'dkimPassRate', 'policyAction']),
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
      const conditions: string[] = [];
      const conditionsWithAlias: string[] = [];
      const queryParams: any[] = [];

      if (domain && orgName) {
        conditions.push('LOWER(domain) LIKE LOWER(?) AND LOWER(orgName) LIKE LOWER(?)');
        conditionsWithAlias.push('LOWER(r.domain) LIKE LOWER(?) AND LOWER(r.orgName) LIKE LOWER(?)');
        queryParams.push(`%${domain}%`, `%${orgName}%`);
      } else if (domain) {
        conditions.push('LOWER(domain) LIKE LOWER(?)');
        conditionsWithAlias.push('LOWER(r.domain) LIKE LOWER(?)');
        queryParams.push(`%${domain}%`);
      } else if (orgName) {
        conditions.push('LOWER(orgName) LIKE LOWER(?)');
        conditionsWithAlias.push('LOWER(r.orgName) LIKE LOWER(?)');
        queryParams.push(`%${orgName}%`);
      }

      // A user scoped to particular domains must never see another domain's reports.
      const scope = await getDomainScope(req as AuthenticatedRequest);
      if (scope !== null) {
        if (scope.length === 0) {
          return res.json({
            data: [],
            pagination: { page, limit, total: 0, pages: 0 },
          });
        }
        const placeholders = scope.map(() => '?').join(', ');
        conditions.push(`LOWER(domain) IN (${placeholders})`);
        conditionsWithAlias.push(`LOWER(r.domain) IN (${placeholders})`);
        queryParams.push(...scope);
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const whereClauseWithAlias =
        conditionsWithAlias.length > 0 ? `WHERE ${conditionsWithAlias.join(' AND ')}` : '';

      // Build ORDER BY clause
      const validSortFields = ['domain', 'orgName', 'startDate', 'endDate', 'createdAt', 'totalMessages', 'spfPassRate', 'dkimPassRate', 'policyAction'];
      const sortField = validSortFields.includes(sortBy) ? sortBy : 'startDate';
      const sortDirection = sortOrder === 'asc' ? 'ASC' : 'DESC';

      const orderClause = (() => {
        switch (sortField) {
          case 'totalMessages':
            return `ORDER BY totalMessages ${sortDirection}`;
          case 'spfPassRate':
            return `ORDER BY CASE WHEN totalMessages = 0 THEN 0 ELSE ROUND((spfPassCount * 100.0) / totalMessages) END ${sortDirection}`;
          case 'dkimPassRate':
            return `ORDER BY CASE WHEN totalMessages = 0 THEN 0 ELSE ROUND((dkimPassCount * 100.0) / totalMessages) END ${sortDirection}`;
          case 'policyAction':
            return `ORDER BY primaryDisposition ${sortDirection}`;
          default:
            return `ORDER BY r.${sortField} ${sortDirection}`;
        }
      })();

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
        totalMessages: number | bigint | null;
        spfPassCount: number | bigint | null;
        dkimPassCount: number | bigint | null;
        primaryDisposition: string | null;
      }

      // Get reports with case-insensitive filtering using raw SQL
      const reportsQuery = `
        SELECT
          r.*, 
          COALESCE((SELECT SUM(count) FROM records WHERE reportId = r.id), 0) AS totalMessages,
          COALESCE((SELECT SUM(count) FROM records WHERE reportId = r.id AND spf = 'pass'), 0) AS spfPassCount,
          COALESCE((SELECT SUM(count) FROM records WHERE reportId = r.id AND dkim = 'pass'), 0) AS dkimPassCount,
          COALESCE((
            SELECT disposition
            FROM records
            WHERE reportId = r.id
            GROUP BY disposition
            ORDER BY SUM(count) DESC, disposition ASC
            LIMIT 1
          ), 'none') AS primaryDisposition
        FROM reports r
        ${whereClauseWithAlias}
        ${orderClause}
        LIMIT ? OFFSET ?
      `;

      const reports = await prisma.$queryRawUnsafe(
        reportsQuery,
        ...queryParams,
        limit,
        offset
      ) as RawReport[];

      // Get total count for pagination
      const countQuery = `SELECT COUNT(*) as count FROM reports ${whereClause}`;
      const totalCountResult = await prisma.$queryRawUnsafe(
        countQuery,
        ...queryParams
      ) as [{ count: bigint }];
      const totalCount = Number(totalCountResult[0].count);

      // Transform to API format
      const reportSummaries: ReportSummary[] = reports.map((report: RawReport) => {
        const totalMessages = Number(report.totalMessages ?? 0);
        const spfPassCount = Number(report.spfPassCount ?? 0);
        const dkimPassCount = Number(report.dkimPassCount ?? 0);

        return {
          id: report.id,
          domain: report.domain,
          orgName: report.orgName,
          startDate: new Date(report.startDate).toISOString(),
          endDate: new Date(report.endDate).toISOString(),
          totalMessages,
          spfPassRate: totalMessages > 0 ? Math.round((spfPassCount / totalMessages) * 100) : 0,
          dkimPassRate: totalMessages > 0 ? Math.round((dkimPassCount / totalMessages) * 100) : 0,
          policyAction: report.primaryDisposition || 'none',
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

      // A scoped user must not read another domain's report by guessing its id; answer
      // 404 rather than 403 so the ids cannot be probed either.
      const detailScope = await getDomainScope(req as AuthenticatedRequest);
      if (detailScope !== null && !detailScope.includes(report.domain.toLowerCase())) {
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