import type { NextFunction, Response } from 'express';
import type { AuthenticatedRequest } from './auth.js';
import { recordAudit, type AuditOutcome } from '../services/audit.js';

/**
 * One audit row per state-changing request, plus any read a route explicitly marks.
 *
 * The contract for routes is small on purpose:
 *
 *   req.audit = { action: 'user.create', target: user.email, detail: { role } };
 *
 * and then the handler does its work as usual. The middleware writes the row on `finish`, with
 * the actor resolved from the session and the outcome from the status code - so a handler that
 * forgets to think about failure cannot record a failure as a success. Routes must NOT call
 * `recordAudit` themselves: doing both would double-count every action.
 *
 * Requests that change nothing and carry no note (browsing reports) are not recorded. That is
 * deliberate: an audit log nobody can read is not evidence.
 */

export interface AuditNote {
  /** Required unless `ignore` is set. */
  action?: string;
  /** Overrides the session's actor, for flows that run before a session exists (login). */
  actor?: string;
  actorId?: string;
  target?: string;
  detail?: Record<string, unknown>;
  /** Only needed when the status code does not describe the outcome (a 200 that failed). */
  outcome?: AuditOutcome;
  /** Tenant the action belongs to; defaults to the request's active organisation. */
  orgId?: string;
  /**
   * A POST that only reads (it exists for its body): nothing changed, so there is nothing to
   * record. Without this, every DNS-suggestion lookup would look like a state change.
   */
  ignore?: boolean;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      audit?: AuditNote;
    }
  }
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * The fallback name for a route that has not been annotated yet. It is intentionally ugly -
 * a generic `http.post /api/...` row is a reminder to add a real action, and it is still
 * better than a state change that leaves no trace at all.
 */
function fallbackAction(req: AuthenticatedRequest): string {
  const route = req.route?.path ?? req.path;
  return `http.${req.method.toLowerCase()} ${req.baseUrl}${route}`.slice(0, 200);
}

export function auditRequests(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): void {
  const mutating = MUTATING.has(req.method.toUpperCase());

  res.on('finish', () => {
    const note = req.audit;

    if (note?.ignore) {
      return;
    }

    // A read is only recorded when the route asked for it (an export, say).
    if (!note && !mutating) {
      return;
    }
    // An anonymous mutation with no note is almost always a probe against a route that
    // requires auth; recording it adds noise without an actor worth keeping.
    if (!note && !req.user) {
      return;
    }

    const outcome: AuditOutcome =
      note?.outcome ?? (res.statusCode >= 400 ? 'failure' : 'success');

    void recordAudit({
      action: note?.action ?? fallbackAction(req),
      outcome,
      orgId: note?.orgId ?? req.organizationId ?? null,
      actor: note?.actor ?? req.user?.email ?? 'anonymous',
      actorId: note?.actorId ?? req.user?.id ?? null,
      target: note?.target ?? null,
      detail: {
        ...(note?.detail ?? {}),
        // The status is part of the evidence: 'failure' plus a 403 reads differently from
        // 'failure' plus a 500, and the row keeps both without another column.
        status: res.statusCode,
        ...(note ? {} : { method: req.method, path: `${req.baseUrl}${req.path}` }),
      },
      ip: req.ip ?? null,
      userAgent: req.headers['user-agent'] ?? null,
    });
  });

  next();
}
