import express from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import {
  rateLimit,
  validatePagination,
  validateSorting,
  createValidationError,
} from '../middleware/validation.js';

const router = express.Router();

const VALID_STATUSES = ['started', 'success', 'skipped', 'error'];
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
