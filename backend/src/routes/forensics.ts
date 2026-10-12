import express from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { rateLimit, validatePagination } from '../middleware/validation.js';
import {
  getDomainScope,
  requireAuth,
  sendError,
  type AuthenticatedRequest,
} from '../middleware/auth.js';

const router = express.Router();

const SORT_FIELDS = ['arrivalDate', 'createdAt', 'domain', 'sourceIp', 'reporter'] as const;

const LIST_SELECT = {
  id: true,
  domain: true,
  reportedDomain: true,
  reporter: true,
  reporterEmail: true,
  sourceIp: true,
  arrivalDate: true,
  createdAt: true,
  originalMailFrom: true,
  originalRcptTo: true,
  spfResult: true,
  dkimResult: true,
  dmarcResult: true,
  dkimSelector: true,
  identityAlignment: true,
  reportedSubject: true,
  reportedFrom: true,
  reportedMessageId: true,
  reportAuthenticated: true,
  userAgent: true,
} satisfies Prisma.ForensicReportSelect;

router.use(requireAuth);

function buildWhere(req: AuthenticatedRequest, scope: string[] | null): Prisma.ForensicReportWhereInput {
  const where: Prisma.ForensicReportWhereInput = {};

  if (scope !== null) {
    where.domain = { in: scope };
  }

  const domain = (req.query.domain as string | undefined)?.trim();
  if (domain && scope === null) {
    where.domain = { contains: domain };
  } else if (domain && scope !== null) {
    // An explicit filter can only narrow the assigned set.
    where.domain = { in: scope.filter((d) => d.includes(domain.toLowerCase())) };
  }

  const sourceIp = (req.query.sourceIp as string | undefined)?.trim();
  if (sourceIp) {
    where.sourceIp = { contains: sourceIp };
  }

  const reporter = (req.query.reporter as string | undefined)?.trim();
  if (reporter) {
    where.OR = [{ reporter: { contains: reporter } }, { reporterEmail: { contains: reporter } }];
  }

  const verified = (req.query.verified as string | undefined)?.trim().toLowerCase();
  if (verified === 'true' || verified === 'false') {
    where.reportAuthenticated = verified === 'true';
  }

  const from = (req.query.from as string | undefined)?.trim();
  const to = (req.query.to as string | undefined)?.trim();
  if (from || to) {
    const arrivalFilter: Prisma.DateTimeNullableFilter = {};
    if (from) {
      arrivalFilter.gte = new Date(from);
    }
    if (to) {
      // A bare date means "that whole day", which is what a date input implies.
      const toDate = /^\d{4}-\d{2}-\d{2}$/.test(to)
        ? new Date(`${to}T23:59:59.999Z`)
        : new Date(to);
      arrivalFilter.lte = toDate;
    }
    where.arrivalDate = arrivalFilter;
  }

  const search = (req.query.search as string | undefined)?.trim();
  if (search) {
    const searchConditions: Prisma.ForensicReportWhereInput[] = [
      { originalMailFrom: { contains: search } },
      { originalRcptTo: { contains: search } },
      { reportedSubject: { contains: search } },
      { reportedMessageId: { contains: search } },
      { authResults: { contains: search } },
      { userAgent: { contains: search } },
      { dkimDomain: { contains: search } },
    ];
    where.AND = [{ OR: searchConditions }];
  }

  return where;
}

// GET /forensics/summary - card + trend data for the dashboard and the view header
router.get('/summary', rateLimit(30, 60000), async (req: AuthenticatedRequest, res) => {
  const scope = await getDomainScope(req);

  if (scope !== null && scope.length === 0) {
    return res.json({
      total: 0,
      last24h: 0,
      last7d: 0,
      unverified: 0,
      domains: 0,
      topSources: [],
      topDomains: [],
      topReporters: [],
      trendsData: [],
    });
  }

  const where: Prisma.ForensicReportWhereInput = scope === null ? {} : { domain: { in: scope } };
  const since = new Date(Date.now() - 14 * 24 * 3600_000);

  const [total, last24h, last7d, unverified, rows] = await Promise.all([
    prisma.forensicReport.count({ where }),
    prisma.forensicReport.count({ where: { ...where, createdAt: { gte: new Date(Date.now() - 24 * 3600_000) } } }),
    prisma.forensicReport.count({ where: { ...where, createdAt: { gte: new Date(Date.now() - 7 * 24 * 3600_000) } } }),
    prisma.forensicReport.count({ where: { ...where, reportAuthenticated: false } }),
    prisma.forensicReport.findMany({
      where: { ...where, createdAt: { gte: since } },
      select: { domain: true, sourceIp: true, reporter: true, arrivalDate: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    }),
  ]);

  const domains = new Set<string>();
  const sourceCounts = new Map<string, { count: number; lastSeen: Date | null }>();
  const domainCounts = new Map<string, number>();
  const reporterCounts = new Map<string, number>();
  const byDay = new Map<string, number>();

  for (const row of rows) {
    domains.add(row.domain);
    domainCounts.set(row.domain, (domainCounts.get(row.domain) ?? 0) + 1);

    const ip = row.sourceIp ?? 'unknown';
    const source = sourceCounts.get(ip) ?? { count: 0, lastSeen: null };
    source.count += 1;
    const seen = row.arrivalDate ?? row.createdAt;
    if (!source.lastSeen || seen > source.lastSeen) {
      source.lastSeen = seen;
    }
    sourceCounts.set(ip, source);

    const reporter = row.reporter ?? 'unknown';
    reporterCounts.set(reporter, (reporterCounts.get(reporter) ?? 0) + 1);

    const day = (row.arrivalDate ?? row.createdAt).toISOString().slice(0, 10);
    byDay.set(day, (byDay.get(day) ?? 0) + 1);
  }

  // Fill the trend so the chart has a point per day rather than only days with reports.
  const trendsData: Array<{ date: string; count: number }> = [];
  for (let i = 13; i >= 0; i--) {
    const date = new Date(Date.now() - i * 24 * 3600_000).toISOString().slice(0, 10);
    trendsData.push({ date, count: byDay.get(date) ?? 0 });
  }

  return res.json({
    total,
    last24h,
    last7d,
    unverified,
    domains: domains.size,
    topSources: [...sourceCounts.entries()]
      .map(([sourceIp, value]) => ({
        sourceIp,
        count: value.count,
        lastSeen: value.lastSeen?.toISOString() ?? null,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8),
    topDomains: [...domainCounts.entries()]
      .map(([domain, count]) => ({ domain, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8),
    topReporters: [...reporterCounts.entries()]
      .map(([reporter, count]) => ({ reporter, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8),
    trendsData,
  });
});

// GET /forensics - paginated list
router.get('/', rateLimit(60, 60000), validatePagination, async (req: AuthenticatedRequest, res) => {
  const page = Math.max(parseInt(req.query.page as string) || 1, 1);
  const limit = Math.min(parseInt(req.query.limit as string) || 25, 100);
  const offset = (page - 1) * limit;

  const scope = await getDomainScope(req);

  if (scope !== null && scope.length === 0) {
    return res.json({ data: [], pagination: { page, limit, total: 0, pages: 0 } });
  }

  const where = buildWhere(req, scope);

  const sortByQuery = (req.query.sortBy as string) || 'arrivalDate';
  const sortBy = (SORT_FIELDS as readonly string[]).includes(sortByQuery) ? sortByQuery : 'arrivalDate';
  const sortOrder = (req.query.sortOrder as string) === 'asc' ? 'asc' : 'desc';

  const [total, rows] = await Promise.all([
    prisma.forensicReport.count({ where }),
    prisma.forensicReport.findMany({
      where,
      select: LIST_SELECT,
      orderBy: [{ [sortBy]: sortOrder }, { createdAt: 'desc' }],
      skip: offset,
      take: limit,
    }),
  ]);

  return res.json({
    data: rows.map((row) => ({
      ...row,
      arrivalDate: row.arrivalDate?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    })),
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  });
});

// GET /forensics/:id
router.get('/:id', async (req: AuthenticatedRequest, res) => {
  const scope = await getDomainScope(req);
  const report = await prisma.forensicReport.findUnique({ where: { id: req.params.id } });

  // Out-of-scope ids answer 404 rather than 403, so the endpoint cannot be used to
  // discover which domains exist on the instance.
  if (!report || (scope !== null && !scope.includes(report.domain.toLowerCase()))) {
    return sendError(res, 404, 'NOT_FOUND', 'Forensic report not found');
  }

  const logs = await prisma.processingLog.findMany({
    where: { forensicReportId: report.id },
    orderBy: { createdAt: 'asc' },
    select: { id: true, createdAt: true, status: true, details: true, messageUid: true },
  });

  return res.json({
    ...report,
    arrivalDate: report.arrivalDate?.toISOString() ?? null,
    reportedDate: report.reportedDate?.toISOString() ?? null,
    createdAt: report.createdAt.toISOString(),
    updatedAt: report.updatedAt.toISOString(),
    processingLogs: logs.map((log) => ({ ...log, createdAt: log.createdAt.toISOString() })),
  });
});

export default router;
