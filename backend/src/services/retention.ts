import { prisma } from '../db/prisma.js';
import { getNumberSetting } from './settings.js';
import { pruneAuditEvents } from './audit.js';

/**
 * Data retention.
 *
 * NIS2-style policy is mostly "do not keep what you do not need", and the data here is
 * specific: aggregate reports name source IPs, and a forensic report can contain the reported
 * message's headers and body - third-party content the operator never wanted to archive.
 *
 * Three rules, each with its own setting, each `0 = keep forever`:
 *   data.reportRetentionDays    - aggregate reports, anchored on the report period end
 *   data.forensicRetentionDays  - forensic reports, anchored on arrival (else storage time)
 *   data.auditRetentionDays     - audit rows
 *
 * The cutoffs are computed at run time, so changing a setting takes effect on the next tick
 * without a restart. Pruning is irreversible by design; there is no soft-delete because a
 * "deleted but still in the database" row would defeat the point of the policy.
 */

export type RetentionRuleKey = 'reports' | 'forensics' | 'tlsrpt' | 'audit';

export interface RetentionRuleView {
  key: RetentionRuleKey;
  setting: string;
  retentionDays: number;
  /** Null when the rule is disabled (keep forever). */
  cutoff: string | null;
  /** Rows that a run right now would delete. */
  pending: number;
}

export interface RetentionPlan {
  generatedAt: string;
  rules: RetentionRuleView[];
}

function cutoffFor(days: number): Date | null {
  if (!Number.isFinite(days) || days <= 0) {
    return null;
  }
  return new Date(Date.now() - days * 86_400_000);
}

/**
 * Aggregate reports are anchored on the period they cover, not on when they reached this
 * database: a report about last month is last month's data even if IMAP was down for a week.
 */
function reportsWhere(cutoff: Date) {
  return { endDate: { lt: cutoff } };
}

/**
 * Forensic reports are anchored on arrival, falling back to storage time for the rows where
 * the reporter omitted Arrival-Date. Both branches are needed: Prisma cannot coalesce.
 */
function forensicsWhere(cutoff: Date) {
  return {
    OR: [
      { arrivalDate: { lt: cutoff } },
      { arrivalDate: null, createdAt: { lt: cutoff } },
    ],
  };
}

async function policy(): Promise<{ reports: number; forensics: number; tlsrpt: number; audit: number }> {
  const [reports, forensics, tlsrpt, audit] = await Promise.all([
    getNumberSetting('data.reportRetentionDays'),
    getNumberSetting('data.forensicRetentionDays'),
    getNumberSetting('data.tlsRptRetentionDays'),
    getNumberSetting('data.auditRetentionDays'),
  ]);
  return { reports, forensics, tlsrpt, audit };
}

export async function previewRetention(): Promise<RetentionPlan> {
  const days = await policy();

  const reportCutoff = cutoffFor(days.reports);
  const forensicCutoff = cutoffFor(days.forensics);
  const tlsRptCutoff = cutoffFor(days.tlsrpt);
  const auditCutoff = cutoffFor(days.audit);

  const [reports, forensics, tlsrpt, audit] = await Promise.all([
    reportCutoff ? prisma.report.count({ where: reportsWhere(reportCutoff) }) : 0,
    forensicCutoff ? prisma.forensicReport.count({ where: forensicsWhere(forensicCutoff) }) : 0,
    tlsRptCutoff ? prisma.tlsRptReport.count({ where: { createdAt: { lt: tlsRptCutoff } } }) : 0,
    auditCutoff ? prisma.auditEvent.count({ where: { createdAt: { lt: auditCutoff } } }) : 0,
  ]);

  return {
    generatedAt: new Date().toISOString(),
    rules: [
      {
        key: 'reports',
        setting: 'data.reportRetentionDays',
        retentionDays: days.reports,
        cutoff: reportCutoff?.toISOString() ?? null,
        pending: reports,
      },
      {
        key: 'forensics',
        setting: 'data.forensicRetentionDays',
        retentionDays: days.forensics,
        cutoff: forensicCutoff?.toISOString() ?? null,
        pending: forensics,
      },
      {
        key: 'tlsrpt',
        setting: 'data.tlsRptRetentionDays',
        retentionDays: days.tlsrpt,
        cutoff: tlsRptCutoff?.toISOString() ?? null,
        pending: tlsrpt,
      },
      {
        key: 'audit',
        setting: 'data.auditRetentionDays',
        retentionDays: days.audit,
        cutoff: auditCutoff?.toISOString() ?? null,
        pending: audit,
      },
    ],
  };
}

export interface RetentionRunResult {
  plan: RetentionPlan;
  deleted: { reports: number; forensics: number; tlsrpt: number; audit: number };
}

/**
 * Serialises runs: the daily tick and an administrator pressing "run now" must not both be
 * deleting the same rows (harmless in SQLite, confusing in the audit trail).
 */
let inFlight: Promise<RetentionRunResult> | null = null;

export function runRetention(): Promise<RetentionRunResult> {
  if (!inFlight) {
    inFlight = execute().finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

async function execute(): Promise<RetentionRunResult> {
  const plan = await previewRetention();
  const cutoff = (key: RetentionRuleKey): Date | null => {
    const rule = plan.rules.find((r) => r.key === key);
    return rule?.cutoff ? new Date(rule.cutoff) : null;
  };

  const reportCutoff = cutoff('reports');
  const forensicCutoff = cutoff('forensics');
  const tlsRptCutoff = cutoff('tlsrpt');
  const auditCutoff = cutoff('audit');

  const deleted = { reports: 0, forensics: 0, tlsrpt: 0, audit: 0 };

  if (reportCutoff) {
    // Records are cascade-deleted with their report (schema.prisma), so one statement covers
    // both tables. Processing logs keep their rows with a null reportId - they are the record
    // of what the ingestion did, not part of the report.
    const result = await prisma.report.deleteMany({ where: reportsWhere(reportCutoff) });
    deleted.reports = result.count;
  }

  if (forensicCutoff) {
    const result = await prisma.forensicReport.deleteMany({
      where: forensicsWhere(forensicCutoff),
    });
    deleted.forensics = result.count;
  }

  if (tlsRptCutoff) {
    const result = await prisma.tlsRptReport.deleteMany({ where: { createdAt: { lt: tlsRptCutoff } } });
    deleted.tlsrpt = result.count;
  }

  if (auditCutoff) {
    deleted.audit = await pruneAuditEvents(auditCutoff);
  }

  // Deliberately not audited here: the route records the administrator's click, and the
  // scheduler records a run that removed something. Two writers would double-count.
  return { plan, deleted };
}
