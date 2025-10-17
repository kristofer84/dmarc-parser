import express from 'express';
import { prisma } from '../db/prisma.js';
import { rateLimit } from '../middleware/validation.js';

const router = express.Router();

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

// GET /summary - Get aggregated dashboard statistics
router.get('/',
  rateLimit(20, 60000), // 20 requests per minute (expensive operation)
  async (_req, res, next) => {
    try {
      console.log('🔄 Calculating dashboard statistics...');

      // Get basic counts
      const totalReports = await prisma.report.count();

      if (totalReports === 0) {
        // Return empty stats if no reports
        const emptyStats: DashboardStats = {
          totalReports: 0,
          totalMessages: 0,
          avgSpfPassRate: 0,
          avgDkimPassRate: 0,
          policyDistribution: { none: 0, quarantine: 0, reject: 0 },
          trendsData: [],
          topSources: [],
          topIPs: [],
        };

        return res.json(emptyStats);
      }

      // Get all reports with records for calculations
      const reports = await prisma.report.findMany({
        include: {
          records: true,
        },
        orderBy: {
          startDate: 'desc',
        },
      });

      // Calculate total messages and pass rates
      let totalMessages = 0;
      let totalSpfPass = 0;
      let totalDkimPass = 0;
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

          // Count policy distributions
          if (record.disposition in policyDistribution) {
            policyDistribution[record.disposition as keyof typeof policyDistribution] += record.count;
          }
        });
      });

      // Calculate average pass rates
      const avgSpfPassRate = totalMessages > 0 ? Math.round((totalSpfPass / totalMessages) * 100) : 0;
      const avgDkimPassRate = totalMessages > 0 ? Math.round((totalDkimPass / totalMessages) * 100) : 0;

      // Generate trends data (last 30 days or available data)
      const trendsData = generateTrendsData(reports);

      // Calculate top sources (organizations)
      const topSources = calculateTopSources(reports);

      // Calculate top IPs
      const topIPs = calculateTopIPs(reports);

      const stats: DashboardStats = {
        totalReports,
        totalMessages,
        avgSpfPassRate,
        avgDkimPassRate,
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

function generateTrendsData(reports: any[]): DashboardStats['trendsData'] {
  // Group reports by date
  const dateGroups = new Map<string, { messageCount: number; failureCount: number }>();

  reports.forEach(report => {
    const dateKey = report.startDate.toISOString().split('T')[0]; // YYYY-MM-DD

    if (!dateGroups.has(dateKey)) {
      dateGroups.set(dateKey, { messageCount: 0, failureCount: 0 });
    }

    const group = dateGroups.get(dateKey)!;

    report.records.forEach((record: any) => {
      group.messageCount += record.count;

      // Count failures (either SPF or DKIM fail)
      if (record.spf === 'fail' || record.dkim === 'fail') {
        group.failureCount += record.count;
      }
    });
  });

  // Convert to array and sort by date
  const trendsArray = Array.from(dateGroups.entries())
    .map(([date, data]) => ({
      date,
      messageCount: data.messageCount,
      failureRate: data.messageCount > 0 ? Math.round((data.failureCount / data.messageCount) * 100) : 0,
    }))
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-30); // Last 30 data points

  return trendsArray;
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

      // Count failures
      if (record.spf === 'fail' || record.dkim === 'fail') {
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