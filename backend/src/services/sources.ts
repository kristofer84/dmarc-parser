import { prisma } from '../db/prisma.js';

/**
 * Sender-source aggregation: "which IPs sent mail for our domains, and did it authenticate".
 *
 * This is the shared implementation behind `/api/sources` and the range handling in
 * `/api/summary`; the alert scan needs the same failure definition, so the rule lives here
 * once rather than being re-derived per caller.
 *
 * DMARC pass for a record is `spf === 'pass' || dkim === 'pass'`. Both stored columns are the
 * *policy-evaluated* verdict (`policy_evaluated` in the RFC 7489 XML), so the receiver has
 * already applied alignment - a DKIM signature by a third-party domain that is not aligned
 * arrives here as `fail`. Alignment is therefore never recomputed; doing so would need the
 * reported header From and the signing domain, and would contradict what the receiver decided.
 */

export const RANGES = ['7d', '30d', '90d', 'all'] as const;
export type RangeKey = (typeof RANGES)[number];
export const DEFAULT_RANGE: RangeKey = '30d';

/** Days covered by each range; `null` means "everything ever stored". */
const RANGE_DAYS: Record<RangeKey, number | null> = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
  all: null,
};

export const DAY_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_SOURCE_LIMIT = 100;
export const MAX_SOURCE_LIMIT = 500;

export interface DispositionCounts {
  none: number;
  quarantine: number;
  reject: number;
}

export interface SourceRow {
  sourceIp: string;
  messages: number;
  /** Messages where neither SPF nor DKIM passed: the same rule the alert scan uses. */
  failures: number;
  dmarcPassRate: number;
  spfPassRate: number;
  dkimPassRate: number;
  dispositions: DispositionCounts;
  domains: string[];
  organizations: string[];
  /** Over all time, not just the selected range - that is what makes a new sender stand out. */
  firstSeen: string | null;
  lastSeen: string | null;
}

export interface SourcesTotals {
  messages: number;
  failures: number;
  dmarcPassRate: number;
  sourceCount: number;
}

export interface SourcesAggregate {
  totals: SourcesTotals;
  sources: SourceRow[];
}

export interface AggregateSourcesOptions {
  /** `null` = every domain (admin); an empty array = nothing assigned, so nothing to report. */
  domains: string[] | null;
  /** `null` = all time. Reports are ranged on `endDate` (the end of the reporting period). */
  since: Date | null;
  limit?: number;
}

/** An unknown or absent `range` falls back to the default rather than failing the request. */
export function parseRange(value: unknown, fallback: RangeKey = DEFAULT_RANGE): RangeKey {
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if ((RANGES as readonly string[]).includes(normalized)) {
      return normalized as RangeKey;
    }
  }
  return fallback;
}

export function rangeDays(range: RangeKey): number | null {
  return RANGE_DAYS[range];
}

export function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/**
 * Inclusive lower bound for a range, at midnight UTC so the window boundary is stable across
 * requests and matches the daily buckets the charts use.
 */
export function rangeSince(range: RangeKey, now: Date = new Date()): Date | null {
  const days = RANGE_DAYS[range];
  if (days === null) {
    return null;
  }
  return startOfUtcDay(new Date(now.getTime() - days * DAY_MS));
}

export function clampSourceLimit(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_SOURCE_LIMIT;
  }
  return Math.min(Math.max(Math.trunc(parsed), 1), MAX_SOURCE_LIMIT);
}

/** The single definition of "this message passed DMARC", shared by every aggregation. */
export function isDmarcPass(record: { spf: string; dkim: string }): boolean {
  return record.spf === 'pass' || record.dkim === 'pass';
}

function rate(passed: number, total: number): number {
  return total > 0 ? Math.round((passed / total) * 100) : 0;
}

interface Accumulator {
  sourceIp: string;
  messages: number;
  failures: number;
  spfPass: number;
  dkimPass: number;
  dispositions: DispositionCounts;
  domains: Set<string>;
  organizations: Set<string>;
}

/**
 * Groups every record in the window by source IP.
 *
 * `limit` applies to the returned rows only: the totals describe the whole window, so the
 * header numbers do not silently change when the table is truncated.
 */
export async function aggregateSources(options: AggregateSourcesOptions): Promise<SourcesAggregate> {
  const { domains, since } = options;
  const limit = clampSourceLimit(options.limit ?? DEFAULT_SOURCE_LIMIT);

  // An empty scope means "nothing assigned yet" - an empty answer, not everything.
  if (domains !== null && domains.length === 0) {
    return { totals: { messages: 0, failures: 0, dmarcPassRate: 0, sourceCount: 0 }, sources: [] };
  }

  const records = await prisma.record.findMany({
    where: {
      report: {
        ...(domains === null ? {} : { domain: { in: domains } }),
        ...(since === null ? {} : { endDate: { gte: since } }),
      },
    },
    select: {
      sourceIp: true,
      count: true,
      disposition: true,
      dkim: true,
      spf: true,
      report: { select: { domain: true, orgName: true } },
    },
  });

  const byIp = new Map<string, Accumulator>();
  let totalMessages = 0;
  let totalPassed = 0;

  for (const record of records) {
    let entry = byIp.get(record.sourceIp);
    if (!entry) {
      entry = {
        sourceIp: record.sourceIp,
        messages: 0,
        failures: 0,
        spfPass: 0,
        dkimPass: 0,
        dispositions: { none: 0, quarantine: 0, reject: 0 },
        domains: new Set<string>(),
        organizations: new Set<string>(),
      };
      byIp.set(record.sourceIp, entry);
    }

    const passed = isDmarcPass(record);

    entry.messages += record.count;
    if (!passed) {
      entry.failures += record.count;
    }
    if (record.spf === 'pass') {
      entry.spfPass += record.count;
    }
    if (record.dkim === 'pass') {
      entry.dkimPass += record.count;
    }
    if (record.disposition === 'none' || record.disposition === 'quarantine' || record.disposition === 'reject') {
      entry.dispositions[record.disposition] += record.count;
    }
    entry.domains.add(record.report.domain);
    entry.organizations.add(record.report.orgName);

    totalMessages += record.count;
    if (passed) {
      totalPassed += record.count;
    }
  }

  const ranked = [...byIp.values()].sort(
    (a, b) => b.messages - a.messages || a.sourceIp.localeCompare(b.sourceIp),
  );

  const top = ranked.slice(0, limit);
  const spans = await sourceSpans(top.map((entry) => entry.sourceIp), domains);

  const sources: SourceRow[] = top.map((entry) => {
    const span = spans.get(entry.sourceIp);
    return {
      sourceIp: entry.sourceIp,
      messages: entry.messages,
      failures: entry.failures,
      dmarcPassRate: rate(entry.messages - entry.failures, entry.messages),
      spfPassRate: rate(entry.spfPass, entry.messages),
      dkimPassRate: rate(entry.dkimPass, entry.messages),
      dispositions: entry.dispositions,
      domains: [...entry.domains].sort(),
      organizations: [...entry.organizations].sort(),
      firstSeen: span ? span.firstSeen.toISOString() : null,
      lastSeen: span ? span.lastSeen.toISOString() : null,
    };
  });

  return {
    totals: {
      messages: totalMessages,
      failures: totalMessages - totalPassed,
      dmarcPassRate: rate(totalPassed, totalMessages),
      sourceCount: ranked.length,
    },
    sources,
  };
}

/**
 * Earliest/latest report end date per source IP over *all* time, for the IPs in the answer.
 *
 * Raw SQL on purpose: the span deliberately ignores the range, so the Prisma equivalent would
 * load every historical record row of a busy sender just to compute two dates. SQLite keeps
 * DateTime as epoch-milliseconds (see db/prisma.ts), which MIN/MAX compare correctly.
 */
async function sourceSpans(
  sourceIps: string[],
  domains: string[] | null,
): Promise<Map<string, { firstSeen: Date; lastSeen: Date }>> {
  const spans = new Map<string, { firstSeen: Date; lastSeen: Date }>();
  if (sourceIps.length === 0) {
    return spans;
  }

  const conditions = [`r.sourceIp IN (${sourceIps.map(() => '?').join(', ')})`];
  const params: unknown[] = [...sourceIps];

  if (domains !== null) {
    // Scoped users must not learn when a sender first hit a domain they cannot see.
    conditions.push(`LOWER(rp.domain) IN (${domains.map(() => '?').join(', ')})`);
    params.push(...domains.map((domain) => domain.toLowerCase()));
  }

  const rows = await prisma.$queryRawUnsafe<Array<{ sourceIp: string; firstSeen: unknown; lastSeen: unknown }>>(
    `SELECT r.sourceIp AS sourceIp,
            MIN(rp.endDate) AS firstSeen,
            MAX(rp.endDate) AS lastSeen
       FROM records r
       JOIN reports rp ON rp.id = r.reportId
      WHERE ${conditions.join(' AND ')}
      GROUP BY r.sourceIp`,
    ...params,
  );

  for (const row of rows) {
    const firstSeen = toDate(row.firstSeen);
    const lastSeen = toDate(row.lastSeen);
    if (firstSeen && lastSeen) {
      spans.set(row.sourceIp, { firstSeen, lastSeen });
    }
  }

  return spans;
}

/** A raw query can hand back a Date, epoch-ms as number/bigint, or ISO text; accept all three. */
function toDate(value: unknown): Date | null {
  let date: Date | null = null;
  if (value instanceof Date) {
    date = value;
  } else if (typeof value === 'number') {
    date = new Date(value);
  } else if (typeof value === 'bigint') {
    date = new Date(Number(value));
  } else if (typeof value === 'string' && value.trim().length > 0) {
    date = new Date(value);
  }
  return date && !Number.isNaN(date.getTime()) ? date : null;
}
