import express from 'express';
import {
  getDomainScope,
  requireAuth,
  type AuthenticatedRequest,
} from '../middleware/auth.js';
import { rateLimit } from '../middleware/validation.js';
import {
  aggregateSources,
  clampSourceLimit,
  parseRange,
  rangeSince,
} from '../services/sources.js';
import { queryParam } from '../utils/requestParams.js';

/**
 * `GET /api/sources` - the senders (source IPs) that mail for the caller's domains came from,
 * with the DMARC/SPF/DKIM pass rates and dispositions behind them.
 *
 * Read-only and domain-scoped: the aggregation gets the scope, not a post-filter, so a scoped
 * user never has another domain's messages summed into a rate.
 */
const router = express.Router();

router.use(requireAuth);

router.get('/', rateLimit(30, 60000, 'sources'), async (req: AuthenticatedRequest, res, next) => {
  try {
    const scope = await getDomainScope(req);
    const range = parseRange(queryParam(req, 'range'));
    const since = rangeSince(range);
    const limit = clampSourceLimit(queryParam(req, 'limit'));

    const { totals, sources } = await aggregateSources({ domains: scope, since, limit });

    return res.json({
      range,
      since: since ? since.toISOString() : null,
      totals,
      sources,
    });
  } catch (error) {
    return next(error);
  }
});

export default router;
