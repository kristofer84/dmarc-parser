import express from 'express';
import { Prisma } from '../generated/prisma/client.js';
import { prisma } from '../db/prisma.js';
import {
  rateLimit,
  validatePagination,
  validateSorting,
  createValidationError,
} from '../middleware/validation.js';
import {
  getDomainScope,
  requireAuth,
  type AuthenticatedRequest,
} from '../middleware/auth.js';

const router = express.Router();

router.use(requireAuth);

const VALID_STATUSES = ['started', 'success', 'skipped', 'error', 'quarantined'];
const SORT_FIELD_MAP: Record<string, keyof Prisma.ProcessingLogOrderByWithRelationInput> = {
  createdAt: 'createdAt',
  status: 'status',
  attachmentName: 'attachmentName',
  messageUid: 'messageUid',
};

router.get(
  '/',
  rateLimit(60, 60000),
  validatePagination,
  validateSorting(Object.keys(SORT_FIELD_MAP)),
  async (req, res, next) => {
    try {
      const page = Math.max(parseInt(req.query.page as string) || 1, 1);
      const limit = Math.min(parseInt(req.query.limit as string) || 25, 100);
      const offset = (page - 1) * limit;

      const status = (req.query.status as string)?.toLowerCase();
      const searchTerm = (req.query.search as string)?.trim();
      const sortByQuery = (req.query.sortBy as string) || 'createdAt';
      const sortOrder = (req.query.sortOrder as string) === 'asc' ? 'asc' : 'desc';

      if (status && !VALID_STATUSES.includes(status)) {
        return next(
          createValidationError(
            `Invalid status. Valid statuses: ${VALID_STATUSES.join(', ')}`
          )
        );
      }

      const where: Prisma.ProcessingLogWhereInput = {};

      // The tenant filter comes first: a log is written by the mailbox that fetched the mail,
      // so `orgId` is the authoritative tenant column and does not depend on the report being
      // linked or on the domain still being owned. A quarantined log has no report at all,
      // which is exactly the row the ingesting organisation must be able to see.
      const activeOrgId = (req as AuthenticatedRequest).organizationId;
      if (activeOrgId) {
        where.orgId = activeOrgId;
      }

      // Legacy fallback for a caller with no active organisation: scoped by the domains it may
      // read; logs with no linked report (rare, and only from a failed parse) stay
      // administrator-only. A superadmin with no organisation selected sees everything.
      const scope = activeOrgId ? null : await getDomainScope(req as AuthenticatedRequest);
      if (!activeOrgId && scope !== null) {
        if (scope.length === 0) {
          return res.json({ data: [], pagination: { page, limit, total: 0, pages: 0 } });
        }
        where.AND = [
          {
            OR: [
              { report: { domain: { in: scope } } },
              { forensicReport: { domain: { in: scope } } },
            ],
          },
        ];
      }

      if (status) {
        where.status = status;
      }

      if (searchTerm) {
        const orConditions: Prisma.ProcessingLogWhereInput[] = [
          {
            attachmentName: {
              contains: searchTerm,
            },
          },
          {
            details: {
              contains: searchTerm,
            },
          },
          {
            reportId: {
              contains: searchTerm,
            },
          },
        ];

        const numericSearch = Number(searchTerm);
        if (!Number.isNaN(numericSearch)) {
          orConditions.push({ messageUid: numericSearch });
        }

        where.OR = orConditions;
      }

      const sortField = SORT_FIELD_MAP[sortByQuery] ?? 'createdAt';

      const [logs, total] = await prisma.$transaction([
        prisma.processingLog.findMany({
          where,
          orderBy: {
            [sortField]: sortOrder,
          },
          skip: offset,
          take: limit,
          include: {
            report: {
              select: {
                id: true,
                domain: true,
                orgName: true,
              },
            },
            forensicReport: {
              select: {
                id: true,
                domain: true,
                sourceIp: true,
              },
            },
          },
        }),
        prisma.processingLog.count({ where }),
      ]);

      return res.json({
        data: logs.map(log => ({
          id: log.id,
          createdAt: log.createdAt.toISOString(),
          messageUid: log.messageUid,
          attachmentName: log.attachmentName,
          status: log.status,
          details: log.details,
          reportId: log.reportId,
          report: log.report
            ? {
                id: log.report.id,
                domain: log.report.domain,
                orgName: log.report.orgName,
              }
            : null,
          forensicReportId: log.forensicReportId,
          forensicReport: log.forensicReport
            ? {
                id: log.forensicReport.id,
                domain: log.forensicReport.domain,
                sourceIp: log.forensicReport.sourceIp,
              }
            : null,
        })),
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit) || 1,
        },
      });
    } catch (error) {
      return next(error);
    }
  }
);

export default router;
