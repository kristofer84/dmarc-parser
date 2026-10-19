import express from 'express';
import { requireAdmin, sendError, type AuthenticatedRequest } from '../middleware/auth.js';
import { rateLimit } from '../middleware/validation.js';
import {
  SETTINGS,
  getAllSettings,
  getSettingDefinition,
  setSetting,
} from '../services/settings.js';
import { resolveMailboxConfig, testMailboxConnection } from '../services/mailboxConfig.js';
import { getStoredSetting, type SettingDefinition } from '../services/settings.js';
import { previewRetention, runRetention } from '../services/retention.js';

const router = express.Router();

router.use(requireAdmin);

// GET /settings - every option with its current value, type and description
router.get('/', async (_req, res) => {
  const settings = await getAllSettings();
  const mailbox = await resolveMailboxConfig();

  return res.json({
    // Secrets are never echoed back: the UI only needs to know whether one is stored.
    data: settings.map((setting) =>
      setting.secret
        ? { ...setting, value: '', isSet: setting.value.trim().length > 0 }
        : setting,
    ),
    categories: [...new Set(SETTINGS.map((s) => s.category))],
    mailbox: { configured: mailbox.configured, missing: mailbox.missing, source: mailbox.source, summary: mailbox.summary },
  });
});

// POST /settings/mailbox/test - try the credentials, optionally before saving them
router.post('/mailbox/test', rateLimit(10, 60000), async (req: AuthenticatedRequest, res) => {
  const { host, port, user, password } = req.body ?? {};

  const result = await testMailboxConnection({
    ...(typeof host === 'string' ? { host } : {}),
    ...(typeof user === 'string' ? { user } : {}),
    ...(typeof password === 'string' ? { password } : {}),
    ...(typeof port === 'number' || typeof port === 'string' ? { port: Number(port) } : {}),
  });

  console.log(`📧 ${req.user!.email} tested the mailbox connection: ${result.ok ? 'ok' : result.message}`);

  // A failed test is a normal answer, not an error: 200 with ok:false lets the UI show it.
  return res.json(result);
});

// GET /settings/retention - what a run right now would delete, per rule
router.get('/retention', async (_req, res) => {
  return res.json(await previewRetention());
});

// POST /settings/retention/run - prune now, with the policy currently stored
router.post('/retention/run', rateLimit(5, 60000), async (req: AuthenticatedRequest, res) => {
  const result = await runRetention();
  console.log(
    `🧹 ${req.user!.email} ran retention: ${result.deleted.reports} report(s), ${result.deleted.forensics} forensic, ${result.deleted.audit} audit row(s)`,
  );
  req.audit = {
    action: 'retention.run',
    detail: { ...result.deleted, trigger: 'manual' },
  };
  return res.json(result);
});

// PATCH /settings/:key
router.patch('/:key', async (req: AuthenticatedRequest, res) => {
  const { key } = req.params;
  const { value } = req.body ?? {};

  const definition = getSettingDefinition(key);
  if (!definition) {
    return sendError(res, 404, 'NOT_FOUND', `Unknown setting: ${key}`);
  }

  if (value === undefined || value === null || typeof value === 'object') {
    return sendError(res, 400, 'VALIDATION_ERROR', 'value must be a string, number or boolean');
  }

  try {
    // Read the stored value first: the audit row is only useful if it says what changed.
    const previous = await getStoredSetting(key);
    const updated = await setSetting(key, String(value), req.user!.email);
    console.log(`⚙️ ${req.user!.email} set ${key} = ${updated.value}`);

    req.audit = {
      action: 'settings.update',
      target: key,
      // A credential setting records that it changed, never either value.
      detail: describeSettingChange(definition, previous, updated.value),
    };
    return res.json({ setting: updated });
  } catch (error) {
    const typed = error as Error & { code?: string; statusCode?: number };
    return sendError(res, typed.statusCode ?? 500, typed.code ?? 'INTERNAL_SERVER_ERROR', typed.message);
  }
});

function describeSettingChange(
  definition: SettingDefinition,
  previous: string | null,
  next: string,
): Record<string, unknown> {
  if (definition.secret) {
    return { secret: true, changed: true };
  }
  return { from: previous ?? '(default)', to: next };
}

export default router;
