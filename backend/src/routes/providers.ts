import express from 'express';
import type { Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { requireAdmin, sendError, type AuthenticatedRequest } from '../middleware/auth.js';
import {
  assertValidIssuer,
  invalidateProviderCache,
  serializeProvider,
  testProvider,
} from '../services/oidc.js';

/**
 * Administrator management of sign-in providers, mounted at /api/providers.
 *
 * The client secret is write-only over this API: responses carry `clientSecretSet` instead,
 * and a PATCH that omits it (or sends it blank) keeps the stored one. That mirrors the
 * mailbox password, and it means the secret never has to travel back to a browser to be
 * edited - the UI can show "a secret is set" and leave the field alone.
 */
const router = express.Router();

router.use(requireAdmin);

function validationError(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 400, code: 'VALIDATION_ERROR' });
}

function readString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw validationError(`${field} is required`);
  }
  return value.trim();
}

function readDomains(value: unknown): string {
  if (!Array.isArray(value)) {
    throw validationError('defaultDomains must be an array of domain names');
  }
  const domains = [
    ...new Set(
      value
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => entry.trim().toLowerCase())
        .filter((entry) => entry.length > 0),
    ),
  ];
  return JSON.stringify(domains);
}

/**
 * The writable fields, shared by create and update. `partial` makes every field optional
 * and leaves a blank/absent secret out entirely, which is what "keep the stored one" means.
 */
function readProviderBody(
  body: Record<string, unknown>,
  partial: boolean,
): Record<string, unknown> {
  const data: Record<string, unknown> = {};

  if (body.name !== undefined || !partial) {
    data.name = readString(body.name, 'name');
  }
  if (body.issuer !== undefined || !partial) {
    data.issuer = assertValidIssuer(body.issuer);
  }
  if (body.clientId !== undefined || !partial) {
    data.clientId = readString(body.clientId, 'clientId');
  }
  if (!partial || (typeof body.clientSecret === 'string' && body.clientSecret.trim().length > 0)) {
    data.clientSecret = readString(body.clientSecret, 'clientSecret');
  }

  // Only 'oidc' is implemented; the column exists so a second protocol does not need a
  // migration, not so a client can invent one.
  data.type = 'oidc';

  if (body.scopes !== undefined) {
    data.scopes = readString(body.scopes, 'scopes');
  }
  if (body.defaultDomains !== undefined) {
    data.defaultDomains = readDomains(body.defaultDomains);
  }
  if (typeof body.allowAutoProvision === 'boolean') {
    data.allowAutoProvision = body.allowAutoProvision;
  }
  if (typeof body.enabled === 'boolean') {
    data.enabled = body.enabled;
  }

  return data;
}

function handleValidationError(res: Response, error: unknown): boolean {
  const typed = error as Error & { statusCode?: number; code?: string };
  if (typed.statusCode === 400) {
    sendError(res, 400, typed.code ?? 'VALIDATION_ERROR', typed.message);
    return true;
  }
  return false;
}

// GET /providers
router.get('/', async (_req, res) => {
  const providers = await prisma.authProvider.findMany({ orderBy: { name: 'asc' } });
  return res.json({ data: providers.map(serializeProvider) });
});

// POST /providers
router.post('/', async (req: AuthenticatedRequest, res) => {
  let data: Record<string, unknown>;
  try {
    data = readProviderBody(req.body ?? {}, false);
  } catch (error) {
    if (handleValidationError(res, error)) {
      return;
    }
    throw error;
  }

  const created = await prisma.authProvider.create({
    data: data as Prisma.AuthProviderCreateInput,
  });
  invalidateProviderCache();
  console.log(`🔐 ${req.user!.email} added sign-in provider ${created.name} (${created.issuer})`);
  req.audit = {
    action: 'provider.create',
    target: created.name,
    detail: { issuer: created.issuer, enabled: created.enabled },
  };
  return res.status(201).json({ provider: serializeProvider(created) });
});

// PATCH /providers/:id
router.patch('/:id', async (req: AuthenticatedRequest, res) => {
  const existing = await prisma.authProvider.findUnique({ where: { id: req.params.id } });
  if (!existing) {
    return sendError(res, 404, 'NOT_FOUND', 'Provider not found');
  }

  let data: Record<string, unknown>;
  try {
    data = readProviderBody(req.body ?? {}, true);
  } catch (error) {
    if (handleValidationError(res, error)) {
      return;
    }
    throw error;
  }

  const updated = await prisma.authProvider.update({
    where: { id: existing.id },
    data: data as Prisma.AuthProviderUpdateInput,
  });
  // The resolved metadata may be cached; a changed issuer or secret must not keep serving the
  // old one.
  invalidateProviderCache(updated.id);
  console.log(`🔐 ${req.user!.email} updated sign-in provider ${updated.name}`);
  req.audit = {
    action: 'provider.update',
    target: updated.name,
    // The keys that changed, never the values - a client secret may be among them.
    detail: { changed: Object.keys(data) },
  };
  return res.json({ provider: serializeProvider(updated) });
});

// DELETE /providers/:id
//
// The identities are removed with it (onDelete: Cascade). That deletes those users' way in
// through this provider - they keep their password and any passkeys, but a federated-only
// account has no password it knows, so an administrator deleting a provider an account
// depends on is locking that account out until it is reset or the provider is re-added.
router.delete('/:id', async (req: AuthenticatedRequest, res) => {
  const existing = await prisma.authProvider.findUnique({ where: { id: req.params.id } });
  if (!existing) {
    return sendError(res, 404, 'NOT_FOUND', 'Provider not found');
  }

  await prisma.authProvider.delete({ where: { id: existing.id } });
  invalidateProviderCache(existing.id);
  console.log(`🔐 ${req.user!.email} removed sign-in provider ${existing.name}`);
  req.audit = { action: 'provider.delete', target: existing.name, detail: { issuer: existing.issuer } };
  return res.json({ ok: true });
});

// POST /providers/:id/test - a failed check is an answer, so this is 200 with ok:false
router.post('/:id/test', async (req: AuthenticatedRequest, res) => {
  const provider = await prisma.authProvider.findUnique({ where: { id: req.params.id } });
  if (!provider) {
    return sendError(res, 404, 'NOT_FOUND', 'Provider not found');
  }

  const result = await testProvider(provider);
  console.log(
    `🔐 ${req.user!.email} tested provider ${provider.name}: ${result.ok ? 'ok' : result.message}`,
  );
  req.audit = {
    action: 'provider.test',
    target: provider.name,
    outcome: result.ok ? 'success' : 'failure',
    detail: { message: result.message },
  };
  return res.json(result);
});

export default router;
