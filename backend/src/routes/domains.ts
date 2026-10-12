import express from 'express';
import { prisma } from '../db/prisma.js';
import { rateLimit } from '../middleware/validation.js';
import type { DomainCheckResult } from '../services/domainStatus.js';
import { resolveMailboxConfig } from '../services/mailboxConfig.js';
import {
  generateRecords,
  type DmarcPolicy,
  type MtaStsMode,
} from '../services/recordSuggestions.js';
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

// POST /domains/:id/records - the DNS records this domain should publish
router.post('/:id/records', rateLimit(20, 60000), async (req: AuthenticatedRequest, res) => {
  const scope = await getDomainScope(req);
  const existing = await prisma.domain.findUnique({ where: { id: req.params.id } });

  // Out of scope answers 404, exactly like GET /domains/:id.
  if (!existing || (scope !== null && !scope.includes(existing.name))) {
    return sendError(res, 404, 'NOT_FOUND', 'Domain not found');
  }

  const { providers, dmarcPolicy, rua, ruf, mtaStsMode } = (req.body ?? {}) as Record<string, unknown>;
  const dmarcPolicies: readonly string[] = ['none', 'quarantine', 'reject'];
  const mtaStsModes: readonly string[] = ['testing', 'enforce'];

  if (providers !== undefined && (!Array.isArray(providers) || providers.some((entry) => typeof entry !== 'string'))) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'providers must be an array of provider ids');
  }
  if (dmarcPolicy !== undefined && (typeof dmarcPolicy !== 'string' || !dmarcPolicies.includes(dmarcPolicy))) {
    return sendError(res, 400, 'VALIDATION_ERROR', `dmarcPolicy must be one of ${dmarcPolicies.join(', ')}`);
  }
  if (mtaStsMode !== undefined && (typeof mtaStsMode !== 'string' || !mtaStsModes.includes(mtaStsMode))) {
    return sendError(res, 400, 'VALIDATION_ERROR', `mtaStsMode must be one of ${mtaStsModes.join(', ')}`);
  }
  if (rua !== undefined && typeof rua !== 'string') {
    return sendError(res, 400, 'VALIDATION_ERROR', 'rua must be a string');
  }
  if (ruf !== undefined && typeof ruf !== 'string') {
    return sendError(res, 400, 'VALIDATION_ERROR', 'ruf must be a string');
  }

  try {
    let check = await prisma.domainCheck.findFirst({
      where: { domainId: existing.id },
      orderBy: { runAt: 'desc' },
    });

    // The generator needs the current record state and the resolved MX hosts. Replying
    // "run a check first" would only make the caller do the same thing in a second round
    // trip, so the first request for a never-checked domain runs the check inline.
    if (!check) {
      await runDomainCheck(existing.id);
      check = await prisma.domainCheck.findFirst({
        where: { domainId: existing.id },
        orderBy: { runAt: 'desc' },
      });
    }

    let current: DomainCheckResult[] = [];
    if (check) {
      try {
        const parsed = JSON.parse(check.resultsJson);
        if (Array.isArray(parsed)) {
          current = parsed as DomainCheckResult[];
        }
      } catch {
        // A corrupted stored report is treated as "nothing known", not as a failed request.
      }
    }

    const mxResult = current.find((result) => result.id === 'mx');
    const mxHosts = (mxResult?.details ?? [])
      .map((detail) => /^priority \d+: (.+)$/.exec(detail.trim())?.[1])
      .filter((host): host is string => Boolean(host));

    const mailbox = await resolveMailboxConfig();

    const generated = await generateRecords({
      domain: existing.name,
      current,
      mxHosts,
      mailboxAddress: mailbox.config?.user ?? null,
      ...(providers === undefined ? {} : { providers: providers as string[] }),
      ...(dmarcPolicy === undefined ? {} : { dmarcPolicy: dmarcPolicy as DmarcPolicy }),
      ...(rua === undefined ? {} : { rua: rua as string }),
      ...(ruf === undefined ? {} : { ruf: ruf as string }),
      ...(mtaStsMode === undefined ? {} : { mtaStsMode: mtaStsMode as MtaStsMode }),
    });

    console.log(
      `🧾 ${req.user!.email} generated record suggestions for ${existing.name} (${generated.records.length} record(s))`,
    );

    return res.json({
      domain: existing.name,
      generatedAt: new Date().toISOString(),
      records: generated.records,
      providers: generated.providers,
    });
  } catch (error) {
    const typed = error as Error & { statusCode?: number; code?: string };
    return sendError(res, typed.statusCode ?? 500, typed.code ?? 'INTERNAL_SERVER_ERROR', typed.message);
  }
});

export default router;
