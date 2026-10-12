import express from 'express';
import { prisma } from '../db/prisma.js';
import { rateLimit } from '../middleware/validation.js';
import {
  getDomainScope,
  requireAdmin,
  requireAuth,
  sendError,
  type AuthenticatedRequest,
} from '../middleware/auth.js';
import {
  discoverDomains,
  domainHealthSummary,
  getDomain,
  listDomains,
  normalizeDomainName,
  runAllChecks,
  runDomainCheck,
} from '../services/domainMonitor.js';

const router = express.Router();

router.use(requireAuth);

function readStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw Object.assign(new Error(`${field} must be an array of strings`), {
      statusCode: 400,
      code: 'VALIDATION_ERROR',
    });
  }
  return [...new Set(value.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.trim()).filter(Boolean))];
}

// GET /domains/summary - dashboard card: how many domains are fine and which are not
router.get('/summary', rateLimit(30, 60000), async (req: AuthenticatedRequest, res) => {
  const scope = await getDomainScope(req);
  return res.json(await domainHealthSummary(scope));
});

// GET /domains - the list, each with its most recent check
router.get('/', rateLimit(60, 60000), async (req: AuthenticatedRequest, res) => {
  const scope = await getDomainScope(req);
  return res.json({ data: await listDomains(scope) });
});

// POST /domains/discover - add domains that have sent reports but are not tracked yet
router.post('/discover', requireAdmin, async (req: AuthenticatedRequest, res) => {
  const result = await discoverDomains();
  if (result.added.length > 0) {
    console.log(`🔎 ${req.user!.email} discovered ${result.added.length} domain(s): ${result.added.join(', ')}`);
  }
  return res.json(result);
});

// POST /domains/check-all - run every monitored domain now (admin; the schedule does this anyway)
router.post('/check-all', requireAdmin, rateLimit(5, 60000), async (req: AuthenticatedRequest, res) => {
  const result = await runAllChecks();
  console.log(`🔎 ${req.user!.email} ran all domain checks: ${result.checked} checked, ${result.failed} failed`);
  return res.json(result);
});

// POST /domains - add one by hand
router.post('/', requireAdmin, async (req: AuthenticatedRequest, res) => {
  const { name, dkimSelectors, expectedMx, notes, monitored } = req.body ?? {};

  try {
    const normalized = normalizeDomainName(String(name ?? ''));
    const existing = await prisma.domain.findUnique({ where: { name: normalized } });
    if (existing) {
      return sendError(res, 409, 'CONFLICT', `${normalized} is already in the list`);
    }

    const created = await prisma.domain.create({
      data: {
        name: normalized,
        dkimSelectors: JSON.stringify(dkimSelectors === undefined ? [] : readStringArray(dkimSelectors, 'dkimSelectors')),
        expectedMx: JSON.stringify(expectedMx === undefined ? [] : readStringArray(expectedMx, 'expectedMx')),
        monitored: monitored === undefined ? true : Boolean(monitored),
        notes: typeof notes === 'string' && notes.trim() ? notes.trim() : null,
      },
    });

    console.log(`🔎 ${req.user!.email} added domain ${created.name}`);
    return res.status(201).json({ domain: (await getDomain(created.id, null))?.domain ?? null });
  } catch (error) {
    const typed = error as Error & { statusCode?: number; code?: string };
    return sendError(res, typed.statusCode ?? 500, typed.code ?? 'INTERNAL_SERVER_ERROR', typed.message);
  }
});

// GET /domains/:id - one domain with its history
router.get('/:id', async (req: AuthenticatedRequest, res) => {
  const scope = await getDomainScope(req);
  const found = await getDomain(req.params.id, scope);

  // Out of scope answers 404, like every other per-domain resource.
  if (!found) {
    return sendError(res, 404, 'NOT_FOUND', 'Domain not found');
  }

  return res.json(found);
});

// PATCH /domains/:id - selectors, expected MX, monitoring, notes
router.patch('/:id', requireAdmin, async (req: AuthenticatedRequest, res) => {
  const { dkimSelectors, expectedMx, notes, monitored } = req.body ?? {};

  const existing = await prisma.domain.findUnique({ where: { id: req.params.id } });
  if (!existing) {
    return sendError(res, 404, 'NOT_FOUND', 'Domain not found');
  }

  try {
    await prisma.domain.update({
      where: { id: existing.id },
      data: {
        ...(dkimSelectors === undefined ? {} : { dkimSelectors: JSON.stringify(readStringArray(dkimSelectors, 'dkimSelectors')) }),
        ...(expectedMx === undefined ? {} : { expectedMx: JSON.stringify(readStringArray(expectedMx, 'expectedMx')) }),
        ...(monitored === undefined ? {} : { monitored: Boolean(monitored) }),
        ...(notes === undefined ? {} : { notes: typeof notes === 'string' && notes.trim() ? notes.trim() : null }),
      },
    });

    console.log(`🔎 ${req.user!.email} updated domain ${existing.name}`);
    return res.json({ domain: (await getDomain(existing.id, null))?.domain ?? null });
  } catch (error) {
    const typed = error as Error & { statusCode?: number; code?: string };
    return sendError(res, typed.statusCode ?? 500, typed.code ?? 'INTERNAL_SERVER_ERROR', typed.message);
  }
});

// DELETE /domains/:id
router.delete('/:id', requireAdmin, async (req: AuthenticatedRequest, res) => {
  const existing = await prisma.domain.findUnique({ where: { id: req.params.id } });
  if (!existing) {
    return sendError(res, 404, 'NOT_FOUND', 'Domain not found');
  }

  await prisma.domain.delete({ where: { id: existing.id } });
  console.log(`🔎 ${req.user!.email} removed domain ${existing.name}`);
  return res.json({ ok: true });
});

// POST /domains/:id/check - run the checks now
router.post('/:id/check', rateLimit(20, 60000), async (req: AuthenticatedRequest, res) => {
  const scope = await getDomainScope(req);
  const existing = await prisma.domain.findUnique({ where: { id: req.params.id } });

  if (!existing || (scope !== null && !scope.includes(existing.name))) {
    return sendError(res, 404, 'NOT_FOUND', 'Domain not found');
  }

  try {
    const report = await runDomainCheck(existing.id);
    return res.json(report);
  } catch (error) {
    const typed = error as Error & { statusCode?: number; code?: string };
    return sendError(res, typed.statusCode ?? 500, typed.code ?? 'INTERNAL_SERVER_ERROR', typed.message);
  }
});

export default router;
