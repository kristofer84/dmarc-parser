import express from 'express';
import { requireAdmin, sendError, type AuthenticatedRequest } from '../middleware/auth.js';
import {
  exportAuditEvents,
  listAuditActions,
  listAuditEvents,
  type AuditFilters,
  type AuditOutcome,
} from '../services/audit.js';
import type { AuditNote } from '../middleware/audit.js';

/**
 * Reading and exporting the audit trail. Administrator-only, like every other administrative
 * surface: the log names who did what, which is itself sensitive.
 */
const router = express.Router();

router.use(requireAdmin);

const MAX_LIMIT = 200;

export function parseAuditFilters(query: Record<string, unknown>): AuditFilters {
  const asString = (value: unknown): string | undefined => {
    if (typeof value !== 'string') {
      return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  };

  const asDate = (value: unknown): Date | null => {
    const raw = asString(value);
    if (!raw) {
      return null;
    }
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  };

  const outcome = asString(query.outcome);
  const filters: AuditFilters = {};

  const actor = asString(query.actor);
  if (actor) filters.actor = actor;

  const action = asString(query.action);
  if (action) filters.action = action;

  const target = asString(query.target);
  if (target) filters.target = target;

  if (outcome === 'success' || outcome === 'failure') {
    filters.outcome = outcome as AuditOutcome;
  }

  const from = asDate(query.from);
  if (from) filters.from = from;

  const to = asDate(query.to);
  if (to) filters.to = to;

  return filters;
}

// GET /audit - one page of entries, newest first
router.get('/', async (req, res) => {
  const page = Math.max(1, Number.parseInt(String(req.query.page ?? '1'), 10) || 1);
  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, Number.parseInt(String(req.query.limit ?? '50'), 10) || 50),
  );

  const { data, total } = await listAuditEvents(parseAuditFilters(req.query), page, limit);

  return res.json({
    data,
    pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) },
  });
});

// GET /audit/actions - distinct action names, so the filter lists what actually exists
router.get('/actions', async (_req, res) => {
  return res.json({ data: await listAuditActions() });
});

// GET /audit/export?format=csv|json - the evidence copy, with a digest of what was handed out
router.get('/export', async (req: AuthenticatedRequest, res) => {
  const format = req.query.format === 'json' ? 'json' : 'csv';

  try {
    const exported = await exportAuditEvents(parseAuditFilters(req.query), format);

    // Exporting the log is itself an auditable act: it is the moment evidence leaves the box.
    req.audit = {
      action: 'audit.export',
      target: format,
      detail: { rows: exported.count, digest: exported.digest },
    } satisfies AuditNote;

    const extension = format === 'csv' ? 'csv' : 'json';
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    res.setHeader(
      'Content-Type',
      format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8',
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="dmarc-audit-${stamp}.${extension}"`,
    );
    // Any copy of the file can be checked against this after the fact.
    res.setHeader('X-Audit-Digest', `sha256:${exported.digest}`);
    res.setHeader('X-Audit-Rows', String(exported.count));
    return res.send(exported.body);
  } catch (error) {
    const typed = error as Error & { code?: string; statusCode?: number };
    // A refused export is worth a row too: it is either a typo or someone trying to scrape
    // the trail in one piece.
    req.audit = {
      action: 'audit.export',
      outcome: 'failure',
      target: format,
      detail: { error: typed.message },
    };
    return sendError(
      res,
      typed.statusCode ?? 500,
      typed.code ?? 'INTERNAL_SERVER_ERROR',
      typed.message,
    );
  }
});

export default router;
