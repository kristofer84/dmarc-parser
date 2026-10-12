import express from 'express';
import { getAllSettings } from '../services/settings.js';

const router = express.Router();

export interface Branding {
  name: string;
  accent: string;
}

/**
 * Deliberately unauthenticated: the sign-in screen shows the instance name and accent before
 * any session exists, and neither value is a secret. Everything else in /api/settings stays
 * behind the administrator guard.
 */
router.get('/', async (_req, res) => {
  const settings = await getAllSettings();
  const value = (key: string): string => settings.find((setting) => setting.key === key)?.value ?? '';

  const branding: Branding = {
    name: value('branding.instanceName').trim() || 'DMARC Viewer',
    accent: value('branding.accent').trim() || '#4f46e5',
  };

  return res.json(branding);
});

export default router;
