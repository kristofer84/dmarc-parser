import express from 'express';
import { rateLimit } from '../middleware/validation.js';
import {
  getDomainScope,
  requireOrgAdmin,
  requireAuth,
  sendError,
  type AuthenticatedRequest,
} from '../middleware/auth.js';
import { pathParam, queryParam } from '../utils/requestParams.js';
import { acknowledgeAlert, listAlerts } from '../services/alerts.js';

/**
 * Alerts produced by the recurring scan in services/alerts.ts.
 *
 * Reads are domain-scoped (an assigned user sees their own domains only); acknowledging is an
 * administrator action, like every other write. The rows themselves are evidence, so nothing
 * but `acknowledgedAt`/`acknowledgedBy` is ever mutated - there is no delete and no edit.
 */
const router = express.Router();

router.use(requireAuth);

// GET /alerts?status=open|acknowledged|all&range=7d|30d|90d|all&limit=100
router.get('/', rateLimit(60, 60000), async (req: AuthenticatedRequest, res) => {
  const scope = await getDomainScope(req);

  const result = await listAlerts({
    scope,
    status: queryParam(req, 'status'),
    range: queryParam(req, 'range'),
    limit: Number.parseInt(queryParam(req, 'limit') ?? '', 10),
  });

  return res.json(result);
});

// POST /alerts/:id/ack
router.post('/:id/ack', requireOrgAdmin, rateLimit(30, 60000, 'alerts.ack'), async (req: AuthenticatedRequest, res) => {
  const id = pathParam(req, 'id');
  const scope = await getDomainScope(req);
  const result = await acknowledgeAlert(id, scope, req.user!.email);

  // Same rule as the rest of the app: an id outside the scope answers 404, not 403, so the
  // endpoint cannot be used to probe which domains this instance holds.
  if (!result) {
    return sendError(res, 404, 'NOT_FOUND', 'Alert not found');
  }

  req.audit = {
    action: 'alert.acknowledge',
    target: result.alert.id,
    detail: {
      domain: result.alert.domain,
      kind: result.alert.kind,
      // A second acknowledgement changes nothing; the note says so rather than pretending
      // the timestamp moved.
      alreadyAcknowledged: !result.changed,
    },
  };

  return res.json(result.alert);
});

export default router;
