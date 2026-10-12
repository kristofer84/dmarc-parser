import express from 'express';
import { requireAdmin, sendError, type AuthenticatedRequest } from '../middleware/auth.js';
import {
  SETTINGS,
  getAllSettings,
  getSettingDefinition,
  setSetting,
} from '../services/settings.js';

const router = express.Router();

router.use(requireAdmin);

// GET /settings - every option with its current value, type and description
router.get('/', async (_req, res) => {
  const settings = await getAllSettings();
  return res.json({
    data: settings,
    categories: [...new Set(SETTINGS.map((s) => s.category))],
  });
});

// PATCH /settings/:key
router.patch('/:key', async (req: AuthenticatedRequest, res) => {
  const { key } = req.params;
  const { value } = req.body ?? {};

  if (!getSettingDefinition(key)) {
    return sendError(res, 404, 'NOT_FOUND', `Unknown setting: ${key}`);
  }

  if (value === undefined || value === null || typeof value === 'object') {
    return sendError(res, 400, 'VALIDATION_ERROR', 'value must be a string, number or boolean');
  }

  try {
    const updated = await setSetting(key, String(value), req.user!.email);
    console.log(`⚙️ ${req.user!.email} set ${key} = ${updated.value}`);
    return res.json({ setting: updated });
  } catch (error) {
    const typed = error as Error & { code?: string; statusCode?: number };
    return sendError(res, typed.statusCode ?? 500, typed.code ?? 'INTERNAL_SERVER_ERROR', typed.message);
  }
});

export default router;
