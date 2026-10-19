import express from 'express';
import { prisma } from '../db/prisma.js';
import { getDomainScope, requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';

/**
 * TLS-RPT reports (RFC 8460): per-domain SMTP TLS outcomes reported by the sending side.
 *
 * Read-only. Ingestion is in `services/emailProcessor.ts`; the data answers "are TLS sessions
 * to my MX actually succeeding", which is the precondition for moving MTA-STS to enforce.
 *
 * Scoped like every other per-domain resource: a non-admin sees only their domains, and a user
 * with no domains gets an empty result rather than an error.
 */
const router = express.Router();

router.use(requireAuth);

router.get('/', async (req: AuthenticatedRequest, res) => {
  const scope = await getDomainScope(req);
  const page = Math.max(1, Number.parseInt(String(req.query.page ?? '1'), 10) || 1);
  const limit = Math.min(200, Math.max(1, Number.parseInt(String(req.query.limit ?? '50'), 10) || 50));

  const where: Record<string, unknown> = {};

  if (scope !== null) {
    where.policyDomain = { in: scope };
  }

  if (typeof req.query.domain === 'string' && req.query.domain.trim()) {
    const domain = req.query.domain.trim().toLowerCase();
    if (scope !== null && !scope.includes(domain)) {
      return res.json({ data: [], pagination: { page, limit, total: 0, pages: 1 } });
    }
    where.policyDomain = domain;
  }

  if (req.query.failuresOnly === 'true') {
    where.failureCount = { gt: 0 };
  }

  const toDate = (value: unknown): Date | null => {
    if (typeof value !== 'string' || !value.trim()) return null;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  };
  const from = toDate(req.query.from);
  const to = toDate(req.query.to);
  if (from || to) {
    where.dateEnd = { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) };
  }

  const [rows, total] = await Promise.all([
    prisma.tlsRptReport.findMany({
      where,
      orderBy: { dateEnd: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.tlsRptReport.count({ where }),
  ]);

  return res.json({
    data: rows.map((row) => ({
      id: row.id,
      reportId: row.reportId,
      orgName: row.orgName,
      contactInfo: row.contactInfo,
      dateBegin: row.dateBegin.toISOString(),
      dateEnd: row.dateEnd.toISOString(),
      policyDomain: row.policyDomain,
      policyType: row.policyType,
      mxHost: row.mxHost,
      successfulCount: row.successfulCount,
      failureCount: row.failureCount,
      failureDetails: JSON.parse(row.failureDetails) as unknown,
      policyString: row.policyString ? (JSON.parse(row.policyString) as string[]) : null,
      createdAt: row.createdAt.toISOString(),
    })),
    pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) },
  });
});

router.get('/summary', async (req: AuthenticatedRequest, res) => {
  const scope = await getDomainScope(req);
  const where = scope !== null ? { policyDomain: { in: scope } } : {};

  const rows = await prisma.tlsRptReport.findMany({
    where,
    select: {
      policyDomain: true,
      mxHost: true,
      successfulCount: true,
      failureCount: true,
      failureDetails: true,
      dateEnd: true,
      policyType: true,
    },
    orderBy: { dateEnd: 'desc' },
    take: 5000,
  });

  const byDomain = new Map<string, { domain: string; successful: number; failed: number }>();
  const byResultType = new Map<string, { resultType: string; count: number }>();
  let successful = 0;
  let failed = 0;
  let lastReportAt: string | null = null;

  for (const row of rows) {
    successful += row.successfulCount;
    failed += row.failureCount;

    const domain = byDomain.get(row.policyDomain) ?? {
      domain: row.policyDomain,
      successful: 0,
      failed: 0,
    };
    domain.successful += row.successfulCount;
    domain.failed += row.failureCount;
    byDomain.set(row.policyDomain, domain);

    if (!lastReportAt || row.dateEnd.toISOString() > lastReportAt) {
      lastReportAt = row.dateEnd.toISOString();
    }

    try {
      const details = JSON.parse(row.failureDetails) as Array<{ resultType?: string; count?: number }>;
      for (const detail of details) {
        if (!detail?.resultType) continue;
        const entry = byResultType.get(detail.resultType) ?? {
          resultType: detail.resultType,
          count: 0,
        };
        entry.count += detail.count ?? 0;
        byResultType.set(detail.resultType, entry);
      }
    } catch {
      // A malformed stored detail must not break the summary; the row's failureCount still counts.
    }
  }

  return res.json({
    reports: rows.length,
    successful,
    failed,
    lastReportAt,
    byDomain: [...byDomain.values()].sort((a, b) => b.failed - a.failed || a.domain.localeCompare(b.domain)),
    byResultType: [...byResultType.values()].sort((a, b) => b.count - a.count),
  });
});

export default router;
