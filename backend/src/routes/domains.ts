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
  requireOrgAdmin,
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
import { pathParam } from '../utils/requestParams.js';

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

/** Evidence window for `verified`: a report that arrived recently is what proves rua= works. */
const INGEST_WINDOW_DAYS = 30;

// GET /domains/:name/ingest - where reports for this domain currently go, and whether any arrive
router.get('/:name/ingest', rateLimit(60, 60000), async (req: AuthenticatedRequest, res) => {
  const scope = await getDomainScope(req);

  // The path carries a name here, not an id, so it is normalised the same way a new domain is.
  let name: string;
  try {
    name = normalizeDomainName(pathParam(req, 'name'));
  } catch {
    return sendError(res, 400, 'VALIDATION_ERROR', 'Enter a valid domain name');
  }

  // Out of scope answers 404, like every other per-domain resource.
  if (scope !== null && !scope.includes(name)) {
    return sendError(res, 404, 'NOT_FOUND', 'Domain not found');
  }

  const mailbox = await resolveMailboxConfig();
  const address = mailbox.config?.user.trim() || null;

  const since = new Date(Date.now() - INGEST_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const [latest, reports30d] = await Promise.all([
    prisma.report.findFirst({
      where: { domain: name },
      orderBy: { endDate: 'desc' },
      select: { endDate: true },
    }),
    prisma.report.count({ where: { domain: name, endDate: { gte: since } } }),
  ]);

  // `verified` is evidence, not configuration: only a report that actually arrived for this
  // domain proves the published rua= points here. ruf= is optional for receivers, and when one
  // does send a forensic report it goes to the same mailbox, so both addresses are the same.
  return res.json({
    rua: address ? `mailto:${address}` : null,
    ruf: address ? `mailto:${address}` : null,
    configured: mailbox.configured,
    lastReportAt: latest ? latest.endDate.toISOString() : null,
    reports30d,
    verified: reports30d > 0,
  });
});

// POST /domains/discover - add domains that have sent reports but are not tracked yet
router.post('/discover', requireAdmin, async (req: AuthenticatedRequest, res) => {
  const result = await discoverDomains();
  if (result.added.length > 0) {
    console.log(`🔎 ${req.user!.email} discovered ${result.added.length} domain(s): ${result.added.join(', ')}`);
  }
  req.audit = { action: 'domain.discover', detail: { added: result.added } };
  return res.json(result);
});

// POST /domains/check-all - run every monitored domain now (admin; the schedule does this anyway)
router.post('/check-all', requireAdmin, rateLimit(5, 60000), async (req: AuthenticatedRequest, res) => {
  const result = await runAllChecks();
  console.log(`🔎 ${req.user!.email} ran all domain checks: ${result.checked} checked, ${result.failed} failed`);
  req.audit = { action: 'domain.check_all', detail: result };
  return res.json(result);
});

// POST /domains - add one by hand
router.post('/', requireOrgAdmin, async (req: AuthenticatedRequest, res) => {
  const { name, dkimSelectors, expectedMx, notes, monitored, orgId } = req.body ?? {};

  try {
    const normalized = normalizeDomainName(String(name ?? ''));

    // Where the claim lands: an org admin can only add to their active organisation; a
    // superadmin may name one, use the selected organisation, or leave it unowned.
    let targetOrgId: string | null = req.organizationId ?? null;
    if (req.user!.role === 'admin' && orgId !== undefined) {
      if (orgId === null) {
        targetOrgId = null;
      } else if (typeof orgId === 'string') {
        const org = await prisma.organization.findUnique({ where: { id: orgId } });
        if (!org) {
          return sendError(res, 404, 'ORG_NOT_FOUND', 'Organisation not found');
        }
        targetOrgId = org.id;
      } else {
        return sendError(res, 400, 'VALIDATION_ERROR', 'orgId must be a string or null');
      }
    }
    if (req.user!.role !== 'admin' && !targetOrgId) {
      return sendError(res, 409, 'ORG_REQUIRED', 'Select an organisation before adding a domain');
    }

    const existing = await prisma.domain.findUnique({ where: { name: normalized } });
    if (existing) {
      // A domain can be claimed once. An unowned row - typically discovered from a report that
      // landed in the legacy mailbox - may be claimed by the org that adds it now.
      if (existing.orgId !== null) {
        return sendError(
          res,
          409,
          'DOMAIN_OWNED',
          `${normalized} is already claimed by another organisation`,
        );
      }
      if (targetOrgId === null) {
        return sendError(res, 409, 'CONFLICT', `${normalized} already exists (unowned)`);
      }
      const claimed = await prisma.domain.update({
        where: { id: existing.id },
        data: {
          orgId: targetOrgId,
          claimedAt: new Date(),
          claimSource: 'manual',
        },
      });
      console.log(`🔎 ${req.user!.email} claimed unowned domain ${normalized}`);
      req.audit = {
        action: 'domain.claim',
        target: normalized,
        orgId: targetOrgId,
        detail: { from: 'unowned' },
      };
      return res.json({ domain: (await getDomain(claimed.id, null))?.domain ?? null });
    }

    const created = await prisma.domain.create({
      data: {
        name: normalized,
        orgId: targetOrgId,
        claimedAt: targetOrgId ? new Date() : null,
        claimSource: targetOrgId ? 'manual' : null,
        dkimSelectors: JSON.stringify(dkimSelectors === undefined ? [] : readStringArray(dkimSelectors, 'dkimSelectors')),
        expectedMx: JSON.stringify(expectedMx === undefined ? [] : readStringArray(expectedMx, 'expectedMx')),
        monitored: monitored === undefined ? true : Boolean(monitored),
        notes: typeof notes === 'string' && notes.trim() ? notes.trim() : null,
      },
    });

    console.log(`🔎 ${req.user!.email} added domain ${created.name}`);
    req.audit = {
      action: 'domain.create',
      target: created.name,
      orgId: targetOrgId ?? undefined,
      detail: { monitored: created.monitored },
    };
    return res.status(201).json({ domain: (await getDomain(created.id, null))?.domain ?? null });
  } catch (error) {
    const typed = error as Error & { statusCode?: number; code?: string };
    return sendError(res, typed.statusCode ?? 500, typed.code ?? 'INTERNAL_SERVER_ERROR', typed.message);
  }
});

// GET /domains/:id - one domain with its history
router.get('/:id', async (req: AuthenticatedRequest, res) => {
  const scope = await getDomainScope(req);
  const found = await getDomain(pathParam(req, 'id'), scope);

  // Out of scope answers 404, like every other per-domain resource.
  if (!found) {
    return sendError(res, 404, 'NOT_FOUND', 'Domain not found');
  }

  return res.json(found);
});

// PATCH /domains/:id - selectors, expected MX, monitoring, notes
router.patch('/:id', requireOrgAdmin, async (req: AuthenticatedRequest, res) => {
  const { dkimSelectors, expectedMx, notes, monitored, orgId, dnsAccountId } = req.body ?? {};

  const existing = await prisma.domain.findUnique({ where: { id: pathParam(req, 'id') } });
  if (!existing) {
    return sendError(res, 404, 'NOT_FOUND', 'Domain not found');
  }

  // An org admin may edit only a domain their organisation owns.
  if (
    req.user!.role !== 'admin' &&
    (!req.organizationId || existing.orgId !== req.organizationId)
  ) {
    return sendError(res, 404, 'NOT_FOUND', 'Domain not found');
  }

  try {
    let nextOrgId = existing.orgId;
    if (orgId !== undefined) {
      if (req.user!.role !== 'admin') {
        return sendError(res, 403, 'FORBIDDEN', 'Only an instance administrator may move a domain');
      }
      if (orgId === null) {
        nextOrgId = null;
      } else if (typeof orgId === 'string') {
        const org = await prisma.organization.findUnique({ where: { id: orgId } });
        if (!org) {
          return sendError(res, 404, 'ORG_NOT_FOUND', 'Organisation not found');
        }
        nextOrgId = org.id;
      } else {
        return sendError(res, 400, 'VALIDATION_ERROR', 'orgId must be a string or null');
      }
    }

    let nextDnsAccountId = existing.dnsAccountId;
    if (dnsAccountId !== undefined) {
      if (dnsAccountId === null) {
        nextDnsAccountId = null;
      } else if (typeof dnsAccountId === 'string') {
        const account = await prisma.dnsAccount.findUnique({ where: { id: dnsAccountId } });
        if (!account) {
          return sendError(res, 404, 'DNS_ACCOUNT_NOT_FOUND', 'DNS account not found');
        }
        if (!nextOrgId || account.orgId !== nextOrgId) {
          return sendError(
            res,
            409,
            'DNS_ACCOUNT_ORG_MISMATCH',
            'The DNS account belongs to a different organisation',
          );
        }
        nextDnsAccountId = account.id;
      } else {
        return sendError(res, 400, 'VALIDATION_ERROR', 'dnsAccountId must be a string or null');
      }
    }

    await prisma.domain.update({
      where: { id: existing.id },
      data: {
        ...(dkimSelectors === undefined ? {} : { dkimSelectors: JSON.stringify(readStringArray(dkimSelectors, 'dkimSelectors')) }),
        ...(expectedMx === undefined ? {} : { expectedMx: JSON.stringify(readStringArray(expectedMx, 'expectedMx')) }),
        ...(monitored === undefined ? {} : { monitored: Boolean(monitored) }),
        ...(notes === undefined ? {} : { notes: typeof notes === 'string' && notes.trim() ? notes.trim() : null }),
        ...(orgId === undefined ? {} : {
          orgId: nextOrgId,
          claimedAt: nextOrgId ? existing.claimedAt ?? new Date() : null,
          claimSource: nextOrgId ? existing.claimSource ?? 'admin' : null,
        }),
        ...(dnsAccountId === undefined ? {} : { dnsAccountId: nextDnsAccountId }),
      },
    });

    console.log(`🔎 ${req.user!.email} updated domain ${existing.name}`);
    req.audit = {
      action: 'domain.update',
      target: existing.name,
      detail: {
        changed: Object.fromEntries(
          Object.entries({ dkimSelectors, expectedMx, notes, monitored, orgId, dnsAccountId }).filter(
            ([, value]) => value !== undefined,
          ),
        ),
      },
    };
    return res.json({ domain: (await getDomain(existing.id, null))?.domain ?? null });
  } catch (error) {
    const typed = error as Error & { statusCode?: number; code?: string };
    return sendError(res, typed.statusCode ?? 500, typed.code ?? 'INTERNAL_SERVER_ERROR', typed.message);
  }
});

// DELETE /domains/:id
router.delete('/:id', requireAdmin, async (req: AuthenticatedRequest, res) => {
  const existing = await prisma.domain.findUnique({ where: { id: pathParam(req, 'id') } });
  if (!existing) {
    return sendError(res, 404, 'NOT_FOUND', 'Domain not found');
  }

  await prisma.domain.delete({ where: { id: existing.id } });
  console.log(`🔎 ${req.user!.email} removed domain ${existing.name}`);
  req.audit = { action: 'domain.delete', target: existing.name };
  return res.json({ ok: true });
});

// POST /domains/:id/check - run the checks now
router.post('/:id/check', rateLimit(20, 60000), async (req: AuthenticatedRequest, res) => {
  const scope = await getDomainScope(req);
  const existing = await prisma.domain.findUnique({ where: { id: pathParam(req, 'id') } });

  if (!existing || (scope !== null && !scope.includes(existing.name))) {
    return sendError(res, 404, 'NOT_FOUND', 'Domain not found');
  }

  try {
    const report = await runDomainCheck(existing.id);
    req.audit = { action: 'domain.check', target: existing.name, detail: { status: report.status } };
    return res.json(report);
  } catch (error) {
    const typed = error as Error & { statusCode?: number; code?: string };
    return sendError(res, typed.statusCode ?? 500, typed.code ?? 'INTERNAL_SERVER_ERROR', typed.message);
  }
});

// POST /domains/:id/records - the DNS records this domain should publish
router.post('/:id/records', rateLimit(20, 60000), async (req: AuthenticatedRequest, res) => {
  const scope = await getDomainScope(req);
  const existing = await prisma.domain.findUnique({ where: { id: pathParam(req, 'id') } });

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

    // A POST only because it carries a body; nothing is written, so nothing is audited.
    req.audit = { ignore: true };

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
