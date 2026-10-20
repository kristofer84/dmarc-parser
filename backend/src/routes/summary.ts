import express from 'express';
import { prisma } from '../db/prisma.js';
import { rateLimit } from '../middleware/validation.js';
import {
  getDomainScope,
  requireAuth,
  type AuthenticatedRequest,
} from '../middleware/auth.js';
import {
  DAY_MS,
  isDmarcPass,
  parseRange,
  rangeDays,
  rangeSince,
  startOfUtcDay,
  type RangeKey,
} from '../services/sources.js';
import { queryParam } from '../utils/requestParams.js';

const router = express.Router();

router.use(requireAuth);

export interface DashboardStats {
  totalReports: number;
  totalMessages: number;
  avgSpfPassRate: number;
  avgDkimPassRate: number;
  /** Messages where either SPF or DKIM passed; the headline "is DMARC working" number. */
  avgDmarcPassRate: number;
  /** Echo of the selected window, so the UI can label it without guessing. */
  range: RangeKey;
  since: string | null;
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

/** The trend chart stays readable: beyond a year of days it is thinned into multi-day buckets. */
const MAX_TREND_BUCKETS = 365;

// GET /summary - Get aggregated dashboard statistics
router.get('/',
  rateLimit(20, 60000), // 20 requests per minute (expensive operation)
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const range = parseRange(queryParam(req, 'range'));
      const since = rangeSince(range);

      // Dashboard statistics honour the caller's domain scope and the selected window.
      // Ranged on endDate, like /api/sources: the window is "reports whose period ended in
      // the last N days", not "reports that started in it".
      const scope = await getDomainScope(req as AuthenticatedRequest);
      const where = {
        ...(scope === null ? {} : { domain: { in: scope } }),
        ...(since === null ? {} : { endDate: { gte: since } }),
      };

      const totalReports = await prisma.report.count({ where });

      if (totalReports === 0) {
        // Return empty stats if no reports are visible to this caller in this window
        const emptyStats: DashboardStats = {
          totalReports: 0,
          totalMessages: 0,
          avgSpfPassRate: 0,
          avgDkimPassRate: 0,
          avgDmarcPassRate: 0,
          range,
          since: since ? since.toISOString() : null,
          policyDistribution: { none: 0, quarantine: 0, reject: 0 },
          trendsData: generateTrendsData([], range),
          topSources: [],
          topIPs: [],
        };

        return res.json(emptyStats);
      }

      // Get all visible reports with records for calculations
      const reports = await prisma.report.findMany({
        where,
        include: {
          records: true,
        },
        orderBy: {
          endDate: 'desc',
        },
      });

      // Calculate total messages and pass rates
      let totalMessages = 0;
      let totalSpfPass = 0;
      let totalDkimPass = 0;
      let totalDmarcPass = 0;
      const policyDistribution = { none: 0, quarantine: 0, reject: 0 };

      reports.forEach(report => {
        report.records.forEach(record => {
          totalMessages += record.count;

          if (record.spf === 'pass') {
            totalSpfPass += record.count;
          }

          if (record.dkim === 'pass') {
            totalDkimPass += record.count;
          }

          if (isDmarcPass(record)) {
            totalDmarcPass += record.count;
          }

          // Count policy distributions
          if (record.disposition in policyDistribution) {
            policyDistribution[record.disposition as keyof typeof policyDistribution] += record.count;
          }
        });
      });

      // Calculate average pass rates
      const avgSpfPassRate = totalMessages > 0 ? Math.round((totalSpfPass / totalMessages) * 100) : 0;
      const avgDkimPassRate = totalMessages > 0 ? Math.round((totalDkimPass / totalMessages) * 100) : 0;
      const avgDmarcPassRate = totalMessages > 0 ? Math.round((totalDmarcPass / totalMessages) * 100) : 0;

      // Generate trends data (the selected window, or the whole span thinned to 365 points)
      const trendsData = generateTrendsData(reports, range);

      // Calculate top sources (organizations)
      const topSources = calculateTopSources(reports);

      // Calculate top IPs
      const topIPs = calculateTopIPs(reports);

      const stats: DashboardStats = {
        totalReports,
        totalMessages,
        avgSpfPassRate,
        avgDkimPassRate,
        avgDmarcPassRate,
        range,
        since: since ? since.toISOString() : null,
        policyDistribution,
        trendsData,
        topSources,
        topIPs,
      };

      console.log('✅ Dashboard statistics calculated');
      return res.json(stats);

    } catch (error) {
      return next(error);
    }
  });

/** YYYY-MM-DD in UTC, the bucket key the chart plots. */
function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function trendPoint(
  date: string,
  bucket: { messageCount: number; failureCount: number } | undefined,
): DashboardStats['trendsData'][number] {
  const messageCount = bucket?.messageCount ?? 0;
  const failureCount = bucket?.failureCount ?? 0;
  return {
    date,
    messageCount,
    failureRate: messageCount > 0 ? Math.round((failureCount / messageCount) * 100) : 0,
  };
}

/**
 * Daily buckets over the selected window.
 *
 * The fixed ranges are zero-filled so the chart spans the window the user selected instead of
 * only the days that happened to carry mail; `all` covers the whole data span, thinned into
 * equal-width buckets once that span exceeds a year so the response stays bounded.
 *
 * A message counts as a failure when neither SPF nor DKIM passed (the DMARC verdict, see
 * services/sources.ts) - the same rule the rates above and the alert scan use.
 */
function generateTrendsData(
  reports: Array<{ endDate: Date; records: Array<{ count: number; spf: string; dkim: string }> }>,
  range: RangeKey,
  now: Date = new Date(),
): DashboardStats['trendsData'] {
  const perDay = new Map<string, { messageCount: number; failureCount: number }>();

  reports.forEach(report => {
    const key = dayKey(report.endDate);

    if (!perDay.has(key)) {
      perDay.set(key, { messageCount: 0, failureCount: 0 });
    }

    const group = perDay.get(key)!;

    report.records.forEach(record => {
      group.messageCount += record.count;

      if (!isDmarcPass(record)) {
        group.failureCount += record.count;
      }
    });
  });

  const days = rangeDays(range);

  if (days !== null) {
    // One point per calendar day from the window's start through today, gaps filled with 0.
    const start = startOfUtcDay(new Date(now.getTime() - days * DAY_MS));
    const end = startOfUtcDay(now);
    const series: DashboardStats['trendsData'] = [];

    for (let cursor = start.getTime(); cursor <= end.getTime(); cursor += DAY_MS) {
      const key = dayKey(new Date(cursor));
      series.push(trendPoint(key, perDay.get(key)));
    }

    return series;
  }

  if (perDay.size === 0) {
    return [];
  }

  // `all`: daily buckets across the span that actually has data, thinned if that is over a year.
  const keys = [...perDay.keys()].sort();
  const firstDay = startOfUtcDay(new Date(`${keys[0]}T00:00:00.000Z`));
  const lastDay = startOfUtcDay(new Date(`${keys[keys.length - 1]}T00:00:00.000Z`));
  const spanDays = Math.round((lastDay.getTime() - firstDay.getTime()) / DAY_MS) + 1;
  const bucketDays = Math.max(1, Math.ceil(spanDays / MAX_TREND_BUCKETS));

  const series: DashboardStats['trendsData'] = [];

  for (let offset = 0; offset < spanDays; offset += bucketDays) {
    const bucketStart = new Date(firstDay.getTime() + offset * DAY_MS);
    const bucket = { messageCount: 0, failureCount: 0 };

    for (let day = 0; day < bucketDays && offset + day < spanDays; day++) {
      const key = dayKey(new Date(bucketStart.getTime() + day * DAY_MS));
      const entry = perDay.get(key);
      if (entry) {
        bucket.messageCount += entry.messageCount;
        bucket.failureCount += entry.failureCount;
      }
    }

    series.push(trendPoint(dayKey(bucketStart), bucket));
  }

  return series;
}

function calculateTopSources(reports: any[]): DashboardStats['topSources'] {
  const sourceGroups = new Map<string, { reportCount: number; messageCount: number }>();

  reports.forEach(report => {
    if (!sourceGroups.has(report.orgName)) {
      sourceGroups.set(report.orgName, { reportCount: 0, messageCount: 0 });
    }

    const group = sourceGroups.get(report.orgName)!;
    group.reportCount++;

    report.records.forEach((record: any) => {
      group.messageCount += record.count;
    });
  });

  return Array.from(sourceGroups.entries())
    .map(([orgName, data]) => ({
      orgName,
      reportCount: data.reportCount,
      messageCount: data.messageCount,
    }))
    .sort((a, b) => b.messageCount - a.messageCount)
    .slice(0, 10); // Top 10
}

function calculateTopIPs(reports: any[]): DashboardStats['topIPs'] {
  const ipGroups = new Map<string, { messageCount: number; failureCount: number }>();

  reports.forEach(report => {
    report.records.forEach((record: any) => {
      if (!ipGroups.has(record.sourceIp)) {
        ipGroups.set(record.sourceIp, { messageCount: 0, failureCount: 0 });
      }

      const group = ipGroups.get(record.sourceIp)!;
      group.messageCount += record.count;

      // Same DMARC failure rule as the trend chart and /api/sources.
      if (!isDmarcPass(record)) {
        group.failureCount += record.count;
      }
    });
  });

  return Array.from(ipGroups.entries())
    .map(([sourceIp, data]) => ({
      sourceIp,
      messageCount: data.messageCount,
      failureRate: data.messageCount > 0 ? Math.round((data.failureCount / data.messageCount) * 100) : 0,
    }))
    .sort((a, b) => b.messageCount - a.messageCount)
    .slice(0, 10); // Top 10
}

export default router;
