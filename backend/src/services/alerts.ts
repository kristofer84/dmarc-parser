import { Prisma } from '../generated/prisma/client.js';
import { prisma } from '../db/prisma.js';
import { getBooleanSetting, getNumberSetting, getSetting } from './settings.js';

/**
 * The recurring scan behind /api/alerts.
 *
 * Two findings, both windowed on the report period (`Report.endDate`) rather than on ingestion
 * time, because a report can arrive days after the period it describes:
 *
 *  - `new_source`: a sender never seen before *for that domain*.
 *  - `failure_spike`: a failure share above the configured threshold, over enough volume to
 *    mean something.
 *
 * Idempotence is the whole design constraint. The scan runs every fifteen minutes, so a finding
 * is only ever recorded once: `dedupKey` is unique in the schema, and a re-run hits the existing
 * row instead of creating a second one. `failure_spike` deliberately includes a coarsened
 * timestamp in its key, so the same continuing spike is recorded again after the cooldown
 * (`alerts.cooldownHours`) instead of disappearing forever.
 *
 * Nothing here may throw out of the scan: a broken domain, a malformed row or a dead webhook
 * must leave the rest of the run intact. Failures are counted and logged.
 */

/** The lookback both findings use. Reports are daily, so this is "yesterday and today". */
const LOOKBACK_MS = 24 * 60 * 60 * 1000;
const WEBHOOK_TIMEOUT_MS = 5000;
const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 500;

export const ALERT_STATUSES = ['open', 'acknowledged', 'all'] as const;
export type AlertStatus = (typeof ALERT_STATUSES)[number];

export const ALERT_RANGES = ['7d', '30d', '90d', 'all'] as const;
export type AlertRange = (typeof ALERT_RANGES)[number];

const RANGE_DAYS: Record<Exclude<AlertRange, 'all'>, number> = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
};

export interface AlertScanResult {
  created: number;
  delivered: number;
  /**
   * Per-domain scan failures plus webhook deliveries that did not get a 2xx. A webhook that
   * keeps failing is a real fault an operator should see in the log line, not silence.
   */
  errors: number;
}

export interface AlertRecord {
  id: string;
  createdAt: string;
  kind: string;
  severity: string;
  domain: string;
  sourceIp: string | null;
  title: string;
  /** Parsed from the stored JSON text; null when the column is empty or unreadable. */
  detail: Record<string, unknown> | null;
  dedupKey: string;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  deliveredAt: string | null;
}

export interface AlertListResult {
  data: AlertRecord[];
  total: number;
}

interface AlertRow {
  id: string;
  createdAt: Date;
  kind: string;
  severity: string;
  domain: string;
  sourceIp: string | null;
  title: string;
  detail: string | null;
  dedupKey: string;
  acknowledgedAt: Date | null;
  acknowledgedBy: string | null;
  deliveredAt: Date | null;
}

interface AlertCandidate {
  kind: 'new_source' | 'failure_spike';
  severity: string;
  domain: string;
  sourceIp: string | null;
  title: string;
  detail: Record<string, unknown>;
  dedupKey: string;
}

function parseDetail(value: string | null): Record<string, unknown> | null {
  if (!value) {
    return null;
  }
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function serialize(row: AlertRow): AlertRecord {
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    kind: row.kind,
    severity: row.severity,
    domain: row.domain,
    sourceIp: row.sourceIp,
    title: row.title,
    detail: parseDetail(row.detail),
    dedupKey: row.dedupKey,
    acknowledgedAt: row.acknowledgedAt?.toISOString() ?? null,
    acknowledgedBy: row.acknowledgedBy,
    deliveredAt: row.deliveredAt?.toISOString() ?? null,
  };
}

/**
 * Unrecognised query values fall back to the default rather than erroring, matching the other
 * list endpoints in this app: a stale bookmark should show the default view, not a 400.
 */
function normalizeStatus(value: string | undefined): AlertStatus {
  const raw = value?.trim().toLowerCase();
  return (ALERT_STATUSES as readonly string[]).includes(raw ?? '') ? (raw as AlertStatus) : 'open';
}

function normalizeRange(value: string | undefined): AlertRange {
  const raw = value?.trim().toLowerCase();
  return (ALERT_RANGES as readonly string[]).includes(raw ?? '') ? (raw as AlertRange) : 'all';
}

/** The lower bound the range implies; null means "no bound" (`all`). */
export function alertRangeStart(range: AlertRange, now: Date = new Date()): Date | null {
  return range === 'all' ? null : new Date(now.getTime() - RANGE_DAYS[range] * 86_400_000);
}

export interface ListAlertsOptions {
  /** null for an administrator; otherwise the caller's domains (`[]` yields nothing). */
  scope: string[] | null;
  status?: string;
  range?: string;
  limit?: number;
}

/** Newest first, with `total` counting everything the filters match - not just the page. */
export async function listAlerts(options: ListAlertsOptions): Promise<AlertListResult> {
  const status = normalizeStatus(options.status);
  const range = normalizeRange(options.range);
  const requested = Math.trunc(options.limit ?? DEFAULT_LIST_LIMIT);
  const limit = Math.min(Math.max(Number.isFinite(requested) ? requested : DEFAULT_LIST_LIMIT, 1), MAX_LIST_LIMIT);

  const where: Prisma.AlertWhereInput = {};
  if (options.scope !== null) {
    // Applied to the query itself, so an empty scope returns nothing rather than everything.
    where.domain = { in: options.scope };
  }
  if (status === 'open') {
    where.acknowledgedAt = null;
  } else if (status === 'acknowledged') {
    where.acknowledgedAt = { not: null };
  }

  const since = alertRangeStart(range);
  if (since) {
    where.createdAt = { gte: since };
  }

  const [total, rows] = await Promise.all([
    prisma.alert.count({ where }),
    prisma.alert.findMany({ where, orderBy: { createdAt: 'desc' }, take: limit }),
  ]);

  return { data: rows.map(serialize), total };
}

export interface AcknowledgeResult {
  alert: AlertRecord;
  /** False when it was already acknowledged; the original timestamp and actor are kept. */
  changed: boolean;
}

/**
 * Acknowledging is idempotent on purpose: two admins clicking at once, or a retried request,
 * must not move the "seen at" marker and misattribute the acknowledgement.
 * Out-of-scope ids answer null so the route can respond 404, never 403.
 */
export async function acknowledgeAlert(
  id: string,
  scope: string[] | null,
  actor: string,
): Promise<AcknowledgeResult | null> {
  const row = await prisma.alert.findUnique({ where: { id } });
  if (!row || (scope !== null && !scope.includes(row.domain))) {
    return null;
  }
  if (row.acknowledgedAt) {
    return { alert: serialize(row), changed: false };
  }

  const updated = await prisma.alert.update({
    where: { id },
    data: { acknowledgedAt: new Date(), acknowledgedBy: actor },
  });
  return { alert: serialize(updated), changed: true };
}

interface NewSourceEntry {
  messages: number;
  firstSeen: Date;
  organization: string;
}

/**
 * Senders whose very first record falls inside the lookback.
 *
 * The guard the plan calls out lives in `evaluateAlerts` (only domains with a report older than
 * the lookback are scanned here). Without it, importing a domain's history would alert on every
 * historical sender at once, which is exactly the noise an operator stops reading.
 */
async function findNewSources(domain: string, since: Date): Promise<AlertCandidate[]> {
  const recent = await prisma.record.findMany({
    where: { report: { domain, endDate: { gte: since } } },
    select: {
      sourceIp: true,
      count: true,
      report: { select: { orgName: true, endDate: true } },
    },
  });
  if (recent.length === 0) {
    return [];
  }

  const byIp = new Map<string, NewSourceEntry>();
  for (const record of recent) {
    const entry = byIp.get(record.sourceIp);
    if (!entry) {
      byIp.set(record.sourceIp, {
        messages: record.count,
        firstSeen: record.report.endDate,
        organization: record.report.orgName,
      });
      continue;
    }
    entry.messages += record.count;
    if (record.report.endDate < entry.firstSeen) {
      entry.firstSeen = record.report.endDate;
      entry.organization = record.report.orgName;
    }
  }

  // One query for "which of these were already sending before the window", instead of one per IP.
  const seenBefore = new Set(
    (
      await prisma.record.findMany({
        where: {
          sourceIp: { in: [...byIp.keys()] },
          report: { domain, endDate: { lt: since } },
        },
        select: { sourceIp: true },
        distinct: ['sourceIp'],
      })
    ).map((row) => row.sourceIp),
  );

  const candidates: AlertCandidate[] = [];
  for (const [sourceIp, entry] of byIp) {
    if (seenBefore.has(sourceIp)) {
      continue;
    }
    candidates.push({
      kind: 'new_source',
      severity: 'info',
      domain,
      sourceIp,
      title: `New sender ${sourceIp} for ${domain}`,
      detail: {
        sourceIp,
        firstSeen: entry.firstSeen.toISOString(),
        organization: entry.organization,
        messages: entry.messages,
      },
      dedupKey: `new_source:${domain}:${sourceIp}`,
    });
  }
  return candidates;
}

/**
 * The failure share over the lookback, or null when it is below the volume floor or the
 * threshold. A failure is a record that failed *both* policy-evaluated checks - the stored
 * values already carry the receiver's alignment decision, so it is not recomputed here.
 */
async function findFailureSpike(
  domain: string,
  since: Date,
  now: Date,
  cooldownMs: number,
  minMessages: number,
  thresholdPercent: number,
): Promise<AlertCandidate | null> {
  const window: Prisma.RecordWhereInput = { report: { domain, endDate: { gte: since } } };

  const [totals, failures] = await Promise.all([
    prisma.record.aggregate({ where: window, _sum: { count: true } }),
    prisma.record.aggregate({
      where: { ...window, spf: { not: 'pass' }, dkim: { not: 'pass' } },
      _sum: { count: true },
    }),
  ]);

  const messages = totals._sum.count ?? 0;
  const failed = failures._sum.count ?? 0;
  if (messages < minMessages) {
    return null;
  }

  const percent = (failed / messages) * 100;
  if (percent < thresholdPercent) {
    return null;
  }

  const rounded = Math.round(percent * 10) / 10;
  return {
    kind: 'failure_spike',
    // Half of the traffic failing is a different problem from a threshold that is a little high.
    severity: percent >= 50 ? 'critical' : 'warning',
    domain,
    sourceIp: null,
    title: `Failure spike on ${domain}: ${rounded}% of ${messages} messages failed`,
    detail: {
      windowStart: since.toISOString(),
      windowEnd: now.toISOString(),
      messages,
      failures: failed,
      failurePercent: rounded,
      thresholdPercent,
      minMessages,
    },
    // Coarsened by the cooldown, so re-running the same window is a no-op but the finding can
    // come back once the cooldown has passed.
    dedupKey: `failure_spike:${domain}:${Math.floor(now.getTime() / cooldownMs)}`,
  };
}

interface DeliveryOutcome {
  created: boolean;
  delivered: boolean;
  deliveryFailed: boolean;
}

/**
 * Persists one finding, then optionally POSTs it.
 *
 * The webhook URL is trusted as stored: the settings API is what enforces `https://`, and
 * re-checking here would only make a local test stub unreachable.
 */
async function recordAlert(candidate: AlertCandidate, webhookUrl: string | null): Promise<DeliveryOutcome> {
  const existing = await prisma.alert.findUnique({
    where: { dedupKey: candidate.dedupKey },
    select: { id: true },
  });
  if (existing) {
    return { created: false, delivered: false, deliveryFailed: false };
  }

  let row: AlertRow;
  try {
    row = await prisma.alert.create({
      data: { ...candidate, detail: JSON.stringify(candidate.detail) },
    });
  } catch (error) {
    // The lookup above is not a lock. A second instance sharing the database can lose the
    // insert race, and the unique index is the real guard - that is not an error.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return { created: false, delivered: false, deliveryFailed: false };
    }
    throw error;
  }

  if (!webhookUrl) {
    return { created: true, delivered: false, deliveryFailed: false };
  }

  const delivered = await deliverWebhook(row, webhookUrl);
  return { created: true, delivered, deliveryFailed: !delivered };
}

async function deliverWebhook(alert: AlertRow, webhookUrl: string): Promise<boolean> {
  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'dmarc-parser-alerts/1' },
      body: JSON.stringify({
        kind: alert.kind,
        severity: alert.severity,
        domain: alert.domain,
        sourceIp: alert.sourceIp,
        title: alert.title,
        detail: parseDetail(alert.detail),
        createdAt: alert.createdAt.toISOString(),
      }),
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });

    // Drain the body so the connection is released even though the content is ignored.
    await response.arrayBuffer().catch(() => undefined);

    if (!response.ok) {
      console.warn(`⚠️ Alert webhook returned HTTP ${response.status} for ${alert.dedupKey}`);
      return false;
    }

    await prisma.alert.update({ where: { id: alert.id }, data: { deliveredAt: new Date() } });
    return true;
  } catch (error) {
    // Best effort, no retry: the in-app alert is the record, the webhook is a convenience.
    console.warn(
      `⚠️ Alert webhook failed for ${alert.dedupKey}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

/**
 * Runs both findings over every domain with reports.
 *
 * Returns counters rather than throwing: the scheduler logs one line per run, and a scan that
 * threw would leave the caller unable to distinguish "nothing found" from "did not run".
 */
export async function evaluateAlerts(now: Date = new Date()): Promise<AlertScanResult> {
  const result: AlertScanResult = { created: 0, delivered: 0, errors: 0 };

  if (!(await getBooleanSetting('alerts.enabled'))) {
    return result;
  }

  const since = new Date(now.getTime() - LOOKBACK_MS);
  const cooldownMs = Math.max(await getNumberSetting('alerts.cooldownHours'), 1) * 3_600_000;
  const minMessages = Math.max(await getNumberSetting('alerts.minMessages'), 1);
  const thresholdPercent = await getNumberSetting('alerts.failureSpikePercent');
  const webhookUrl = (await getSetting('alerts.webhookUrl')).trim() || null;

  let domains: string[] = [];
  const withHistory = new Set<string>();
  try {
    const rows = await prisma.report.findMany({ distinct: ['domain'], select: { domain: true } });
    domains = rows.map((row) => row.domain);
    // The first-import guard: a domain only qualifies for `new_source` when it has a report
    // older than the lookback, i.e. the scan has a "before" to compare against.
    const historic = await prisma.report.findMany({
      distinct: ['domain'],
      where: { endDate: { lt: since } },
      select: { domain: true },
    });
    for (const row of historic) {
      withHistory.add(row.domain);
    }
  } catch (error) {
    console.warn('⚠️ Alert scan could not list domains:', error);
    return { ...result, errors: result.errors + 1 };
  }

  for (const domain of domains) {
    const findings: AlertCandidate[] = [];

    try {
      if (withHistory.has(domain)) {
        findings.push(...(await findNewSources(domain, since)));
      }
      const spike = await findFailureSpike(domain, since, now, cooldownMs, minMessages, thresholdPercent);
      if (spike) {
        findings.push(spike);
      }
    } catch (error) {
      result.errors += 1;
      console.warn(`⚠️ Alert scan failed for ${domain}:`, error);
      continue;
    }

    for (const finding of findings) {
      try {
        const outcome = await recordAlert(finding, webhookUrl);
        if (outcome.created) {
          result.created += 1;
        }
        if (outcome.delivered) {
          result.delivered += 1;
        }
        if (outcome.deliveryFailed) {
          result.errors += 1;
        }
      } catch (error) {
        result.errors += 1;
        console.warn(`⚠️ Failed to record alert ${finding.dedupKey}:`, error);
      }
    }
  }

  return result;
}
