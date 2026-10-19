import { createHash } from 'node:crypto';
import { prisma } from '../db/prisma.js';

/**
 * Persistent audit trail.
 *
 * Route handlers never call `recordAudit` directly: they set `req.audit` and the middleware in
 * `middleware/audit.ts` writes exactly one row when the response finishes, so the outcome and
 * the HTTP status can never disagree. See that file for the contract.
 *
 * Two rules make the log usable as evidence:
 *  - writing it must never break the request it describes (`recordAudit` swallows errors);
 *  - a failed write is loud in the console, because a silent hole in the log is worse than
 *    no log at all.
 */

export type AuditOutcome = 'success' | 'failure';

export interface AuditInput {
  action: string;
  outcome?: AuditOutcome;
  actor?: string | null;
  actorId?: string | null;
  target?: string | null;
  detail?: Record<string, unknown> | null;
  ip?: string | null;
  userAgent?: string | null;
}

/** Keys whose values never belong in an audit row, whatever the caller passes. */
const SECRET_KEY = /pass(word)?|secret|token|credential|authorization|cookie|api[_-]?key/i;

const MAX_STRING = 500;
const MAX_DETAIL_BYTES = 4000;

/** Recursively redacts anything credential-shaped and caps the row's size. */
function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 4) {
    return '[truncated]';
  }

  if (typeof value === 'string') {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  }

  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => sanitize(item, depth + 1));
  }

  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      result[key] = SECRET_KEY.test(key) ? '[redacted]' : sanitize(item, depth + 1);
    }
    return result;
  }

  return value;
}

function serializeDetail(detail: Record<string, unknown> | null | undefined): string | null {
  if (!detail || Object.keys(detail).length === 0) {
    return null;
  }

  const json = JSON.stringify(sanitize(detail));
  if (json.length <= MAX_DETAIL_BYTES) {
    return json;
  }

  // Never store a half-written JSON document; say what happened to it instead.
  return JSON.stringify({ truncated: true, bytes: json.length, keys: Object.keys(detail) });
}

/**
 * Writes one row. Never throws: an audit failure must not turn a working login into a 500.
 * The console line is intentional - it is the only signal that a gap exists.
 */
export async function recordAudit(input: AuditInput): Promise<void> {
  try {
    await prisma.auditEvent.create({
      data: {
        actor: (input.actor ?? 'anonymous').slice(0, MAX_STRING),
        actorId: input.actorId ?? null,
        action: input.action.slice(0, 200),
        outcome: input.outcome === 'failure' ? 'failure' : 'success',
        target: input.target ? input.target.slice(0, MAX_STRING) : null,
        ip: input.ip ? input.ip.slice(0, MAX_STRING) : null,
        userAgent: input.userAgent ? input.userAgent.slice(0, MAX_STRING) : null,
        detail: serializeDetail(input.detail),
      },
    });
  } catch (error) {
    console.warn(`⚠️ Failed to write audit event "${input.action}":`, error);
  }
}

export interface AuditFilters {
  actor?: string;
  action?: string;
  outcome?: AuditOutcome;
  target?: string;
  /** Inclusive start of the window. */
  from?: Date | null;
  /** Exclusive end of the window. */
  to?: Date | null;
}

export interface AuditEventRow {
  id: string;
  createdAt: string;
  actor: string;
  action: string;
  outcome: string;
  target: string | null;
  ip: string | null;
  userAgent: string | null;
  detail: string | null;
}

function buildWhere(filters: AuditFilters): Record<string, unknown> {
  const where: Record<string, unknown> = {};

  if (filters.actor) {
    where.actor = { contains: filters.actor };
  }
  if (filters.action) {
    // A trailing dot means "the whole family", so `auth.` finds every sign-in event without
    // the caller having to enumerate them.
    where.action = filters.action.endsWith('.')
      ? { startsWith: filters.action }
      : filters.action;
  }
  if (filters.outcome) {
    where.outcome = filters.outcome;
  }
  if (filters.target) {
    where.target = { contains: filters.target };
  }
  if (filters.from || filters.to) {
    where.createdAt = {
      ...(filters.from ? { gte: filters.from } : {}),
      ...(filters.to ? { lt: filters.to } : {}),
    };
  }

  return where;
}

export async function listAuditEvents(
  filters: AuditFilters,
  page: number,
  limit: number,
): Promise<{ data: AuditEventRow[]; total: number }> {
  const where = buildWhere(filters);

  const [rows, total] = await Promise.all([
    prisma.auditEvent.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.auditEvent.count({ where }),
  ]);

  return {
    data: rows.map((row) => ({
      id: row.id,
      createdAt: row.createdAt.toISOString(),
      actor: row.actor,
      action: row.action,
      outcome: row.outcome,
      target: row.target,
      ip: row.ip,
      userAgent: row.userAgent,
      detail: row.detail,
    })),
    total,
  };
}

/** Distinct action names with counts, for the filter dropdown. */
export async function listAuditActions(): Promise<{ action: string; count: number }[]> {
  const rows = await prisma.auditEvent.groupBy({
    by: ['action'],
    _count: { action: true },
    orderBy: { action: 'asc' },
  });

  return rows.map((row) => ({ action: row.action, count: row._count.action }));
}

export const MAX_EXPORT_ROWS = 20_000;

export interface AuditExport {
  format: 'csv' | 'json';
  body: string;
  digest: string;
  count: number;
}

const CSV_COLUMNS = [
  'timestamp',
  'actor',
  'action',
  'outcome',
  'target',
  'ip',
  'user_agent',
  'detail',
] as const;

function csvCell(value: string | null): string {
  const text = value ?? '';
  // RFC 4180: quote when the value could be read as a delimiter, and double inner quotes.
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * Exports the matching rows, or refuses when the set is too large to hand out in one piece.
 * Refusing is deliberate: a silently truncated audit export looks complete and would be used
 * as if it were.
 */
export async function exportAuditEvents(
  filters: AuditFilters,
  format: 'csv' | 'json',
): Promise<AuditExport> {
  const where = buildWhere(filters);

  const total = await prisma.auditEvent.count({ where });
  if (total > MAX_EXPORT_ROWS) {
    throw Object.assign(
      new Error(
        `That export would be ${total} rows; the limit is ${MAX_EXPORT_ROWS}. Narrow the date range or the filters.`,
      ),
      { statusCode: 400, code: 'EXPORT_TOO_LARGE' },
    );
  }

  const rows = await prisma.auditEvent.findMany({
    where,
    orderBy: { createdAt: 'asc' },
  });

  const events = rows.map((row) => ({
    id: row.id,
    timestamp: row.createdAt.toISOString(),
    actor: row.actor,
    action: row.action,
    outcome: row.outcome,
    target: row.target,
    ip: row.ip,
    userAgent: row.userAgent,
    detail: row.detail,
  }));

  // The digest covers exactly the rows in this export, in order. It proves the file was not
  // altered after it left the database - it says nothing about the database itself, which is
  // why the server-side case for tamper evidence is "export on a schedule and keep the copies".
  const body =
    format === 'csv'
      ? [
          CSV_COLUMNS.join(','),
          ...events.map((event) =>
            [
              event.timestamp,
              event.actor,
              event.action,
              event.outcome,
              event.target,
              event.ip,
              event.userAgent,
              event.detail,
            ]
              .map(csvCell)
              .join(','),
          ),
        ].join('\r\n')
      : JSON.stringify(
          {
            exportedAt: new Date().toISOString(),
            filters: {
              ...filters,
              from: filters.from?.toISOString() ?? null,
              to: filters.to?.toISOString() ?? null,
            },
            count: events.length,
            digest: {
              algorithm: 'sha256',
              scope: 'the `events` array of this document, as serialized',
              value: createHash('sha256').update(JSON.stringify(events)).digest('hex'),
            },
            events,
          },
          null,
          2,
        );

  return {
    format,
    body,
    digest: createHash('sha256').update(body).digest('hex'),
    count: events.length,
  };
}

/** Deletes audit rows older than the cutoff. Returns how many went. The caller audits this. */
export async function pruneAuditEvents(cutoff: Date): Promise<number> {
  const result = await prisma.auditEvent.deleteMany({ where: { createdAt: { lt: cutoff } } });
  return result.count;
}
