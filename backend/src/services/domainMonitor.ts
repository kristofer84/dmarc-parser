import { prisma } from '../db/prisma.js';
import {
  checkDomain,
  type DomainCheckReport,
  type DomainCheckResult,
  type CheckStatus,
} from './domainStatus.js';

/**
 * Persistence and scheduling around the DNS checks in domainStatus.ts.
 *
 * The checker itself is stateless; this module owns the domain list, the history of runs and
 * the pruning, so the status page can show "what changed since last time" instead of only
 * the current answer, and so an unchanged domain does not need a live check on every page
 * load.
 */

/** Runs kept per domain. Enough for a month-long trend at the default daily interval. */
const HISTORY_LIMIT = 30;

export interface DomainSummary {
  id: string;
  name: string;
  monitored: boolean;
  dkimSelectors: string[];
  expectedMx: string[];
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  lastCheck: {
    status: CheckStatus;
    runAt: string;
    durationMs: number;
    results: DomainCheckResult[];
  } | null;
  /** Oldest-first status trail for a trend sparkline, so the list needs no per-row request. */
  recent: Array<{ status: CheckStatus; runAt: string }>;
}

/** How many past runs the list carries per domain. */
export const RECENT_CHECK_LIMIT = 14;

export interface DomainHealthSummary {
  total: number;
  ok: number;
  warn: number;
  error: number;
  neverChecked: number;
  needsAttention: Array<{ id: string; name: string; status: CheckStatus; problems: string[] }>;
}

/** JSON array stored as text (SQLite has no JSON column here); never trust its contents. */
function parseList(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((entry): entry is string => typeof entry === 'string');
  } catch {
    return [];
  }
}

export function normalizeDomainName(name: string): string {
  const trimmed = name.trim().toLowerCase().replace(/\.$/, '');
  if (trimmed.length === 0 || trimmed.length > 253) {
    throw Object.assign(new Error('Enter a valid domain name'), {
      statusCode: 400,
      code: 'VALIDATION_ERROR',
    });
  }
  if (trimmed.includes('/') || trimmed.includes('@') || trimmed.includes(' ')) {
    throw Object.assign(new Error('Enter a bare domain name, without scheme, path or @'), {
      statusCode: 400,
      code: 'VALIDATION_ERROR',
    });
  }
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(trimmed)) {
    throw Object.assign(new Error(`"${name}" does not look like a domain name`), {
      statusCode: 400,
      code: 'VALIDATION_ERROR',
    });
  }
  return trimmed;
}

function serialize(
  row: {
    id: string;
    name: string;
    monitored: boolean;
    dkimSelectors: string;
    expectedMx: string;
    notes: string | null;
    createdAt: Date;
    updatedAt: Date;
    checks?: Array<{ status: string; runAt: Date; durationMs: number; resultsJson: string }>;
  },
  withResults = true,
): DomainSummary {
  const latest = row.checks?.[0];

  return {
    id: row.id,
    name: row.name,
    monitored: row.monitored,
    dkimSelectors: parseList(row.dkimSelectors),
    expectedMx: parseList(row.expectedMx),
    notes: row.notes,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lastCheck: latest
      ? {
          status: latest.status as CheckStatus,
          runAt: latest.runAt.toISOString(),
          durationMs: latest.durationMs,
          results: withResults ? (JSON.parse(latest.resultsJson) as DomainCheckResult[]) : [],
        }
      : null,
    // Oldest first, which is the order a sparkline wants.
    recent: [...(row.checks ?? [])]
      .reverse()
      .map((check) => ({ status: check.status as CheckStatus, runAt: check.runAt.toISOString() })),
  };
}

/** Domains plus their most recent check. `scope` is null for admins, else the allowed names. */
export async function listDomains(scope: string[] | null = null): Promise<DomainSummary[]> {
  const rows = await prisma.domain.findMany({
    where: scope === null ? {} : { name: { in: scope } },
    orderBy: { name: 'asc' },
    include: { checks: { orderBy: { runAt: 'desc' }, take: RECENT_CHECK_LIMIT } },
  });

  return rows.map((row) => serialize(row));
}

export async function getDomain(
  id: string,
  scope: string[] | null = null,
  historyLimit = HISTORY_LIMIT,
): Promise<{ domain: DomainSummary; history: NonNullable<DomainSummary['lastCheck']>[] } | null> {
  const row = await prisma.domain.findUnique({
    where: { id },
    include: {
      checks: { orderBy: { runAt: 'desc' }, take: historyLimit },
    },
  });

  if (!row || (scope !== null && !scope.includes(row.name))) {
    return null;
  }

  const [latest, ...rest] = row.checks;
  const history = [latest, ...rest]
    .filter((check): check is NonNullable<typeof check> => Boolean(check))
    .map((check) => ({
      status: check.status as CheckStatus,
      runAt: check.runAt.toISOString(),
      durationMs: check.durationMs,
      results: JSON.parse(check.resultsJson) as DomainCheckResult[],
    }));

  return {
    domain: serialize({ ...row, checks: latest ? [latest] : [] }),
    history,
  };
}

async function pruneHistory(domainId: string): Promise<void> {
  const keep = await prisma.domainCheck.findMany({
    where: { domainId },
    orderBy: { runAt: 'desc' },
    take: HISTORY_LIMIT,
    select: { id: true },
  });

  await prisma.domainCheck.deleteMany({
    where: { domainId, id: { notIn: keep.map((row) => row.id) } },
  });
}

/** Runs the checks for one stored domain and records the result. */
export async function runDomainCheck(domainId: string): Promise<DomainCheckReport> {
  const domain = await prisma.domain.findUnique({ where: { id: domainId } });
  if (!domain) {
    throw Object.assign(new Error('Domain not found'), {
      statusCode: 404,
      code: 'NOT_FOUND',
    });
  }

  const report = await checkDomain(domain.name, {
    dkimSelectors: parseList(domain.dkimSelectors),
    expectedMx: parseList(domain.expectedMx),
  });

  await prisma.domainCheck.create({
    data: {
      domainId: domain.id,
      status: report.status,
      durationMs: report.durationMs,
      resultsJson: JSON.stringify(report.results),
    },
  });

  await pruneHistory(domain.id);

  return report;
}

/**
 * Checks every monitored domain. Domains are checked with small concurrency: each one makes
 * several DNS lookups plus an HTTPS fetch, and a residential line or a public resolver will
 * rate limit a burst of sixty of them.
 */
export async function runAllChecks(concurrency = 2): Promise<{ checked: number; failed: number }> {
  const domains = await prisma.domain.findMany({ where: { monitored: true }, orderBy: { name: 'asc' } });

  let checked = 0;
  let failed = 0;
  const queue = [...domains];

  const worker = async (): Promise<void> => {
    for (;;) {
      const domain = queue.shift();
      if (!domain) {
        return;
      }
      try {
        const report = await runDomainCheck(domain.id);
        checked++;
        if (report.status === 'error' || report.status === 'warn') {
          const problems = report.results
            .filter((result) => result.status === 'error' || result.status === 'warn')
            .map((result) => `${result.label}: ${result.summary}`);
          console.log(`🔎 ${domain.name}: ${report.status}${problems.length ? ` — ${problems[0]}` : ''}`);
        }
      } catch (error) {
        failed++;
        console.error(`❌ Domain check failed for ${domain.name}:`, error);
      }
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));

  return { checked, failed };
}

/** Adds any domain that has sent reports but is not in the domain list yet. */
export async function discoverDomains(): Promise<{ added: string[]; existing: number }> {
  const [reportDomains, forensicDomains, known] = await Promise.all([
    prisma.report.findMany({ distinct: ['domain'], select: { domain: true } }),
    prisma.forensicReport.findMany({ distinct: ['domain'], select: { domain: true } }),
    prisma.domain.findMany({ select: { name: true } }),
  ]);

  const names = new Set<string>();
  for (const row of [...reportDomains, ...forensicDomains]) {
    names.add(row.domain.toLowerCase());
  }

  const knownNames = new Set(known.map((row) => row.name));
  const added: string[] = [];

  for (const name of [...names].sort()) {
    if (knownNames.has(name)) {
      continue;
    }
    try {
      await prisma.domain.create({ data: { name: normalizeDomainName(name) } });
      added.push(name);
    } catch (error) {
      console.warn(`⚠️ Could not add discovered domain ${name}:`, error);
    }
  }

  return { added, existing: knownNames.size };
}

export async function domainHealthSummary(scope: string[] | null = null): Promise<DomainHealthSummary> {
  const domains = await listDomains(scope);

  const summary: DomainHealthSummary = {
    total: domains.length,
    ok: 0,
    warn: 0,
    error: 0,
    neverChecked: 0,
    needsAttention: [],
  };

  for (const domain of domains) {
    const status = domain.lastCheck?.status;

    if (!status) {
      summary.neverChecked++;
      continue;
    }
    if (status === 'ok') {
      summary.ok++;
      continue;
    }
    if (status === 'warn') {
      summary.warn++;
    } else if (status === 'error') {
      summary.error++;
    }

    summary.needsAttention.push({
      id: domain.id,
      name: domain.name,
      status,
      problems: (domain.lastCheck?.results ?? [])
        .filter((result) => result.status === 'error' || result.status === 'warn')
        .map((result) => `${result.label}: ${result.summary}`),
    });
  }

  summary.needsAttention.sort((a, b) => (a.status === b.status ? a.name.localeCompare(b.name) : a.status === 'error' ? -1 : 1));

  return summary;
}
