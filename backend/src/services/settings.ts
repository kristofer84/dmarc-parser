import { prisma } from '../db/prisma.js';

/**
 * Runtime application options.
 *
 * These are the things an operator should be able to change without rebuilding the
 * container - they live in the `settings` table and are edited from the admin UI.
 * Anything that must be known before the process can start (IMAP credentials, database
 * URL, listen port) stays in the environment instead.
 *
 * Values are stored as strings and validated against the definitions below on write.
 */

export type SettingType = 'boolean' | 'number' | 'string';

export interface SettingDefinition {
  key: string;
  type: SettingType;
  default: string;
  label: string;
  description: string;
  category: 'forensics' | 'processing' | 'auth' | 'domains' | 'mailbox' | 'branding' | 'data';
  min?: number;
  max?: number;
  /** Never returned to a client; the UI shows whether a value is stored instead. */
  secret?: boolean;
  /** Optional shape check for string settings (e.g. a colour must look like a colour). */
  pattern?: RegExp;
  /** Changing this one is worth a warning in the UI. */
  dangerous?: boolean;
}

export const SETTINGS: SettingDefinition[] = [
  {
    key: 'forensics.enabled',
    type: 'boolean',
    default: 'true',
    label: 'Process forensic (RUF) reports',
    description:
      'Parse authentication-failure reports that receivers send to the ruf= address. Turning this off leaves the mail unread in the mailbox (nothing is marked as read).',
    category: 'forensics',
  },
  {
    key: 'forensics.storeRawFeedback',
    type: 'boolean',
    default: 'true',
    label: 'Store the raw feedback report block',
    description:
      'Keeps the original message/feedback-report fields (including any DKIM-Canonicalized-* values) so a report can be re-examined. This is the report itself, not the reported mail.',
    category: 'forensics',
  },
  {
    key: 'forensics.storeFullHeaders',
    type: 'boolean',
    default: 'false',
    label: 'Store the full headers of the reported message',
    description:
      'Off: only From, To, Subject, Date and Message-ID of the reported message are kept. On: the whole reported header block is stored as well, which is more useful for investigating a forgery but keeps more third-party data at rest.',
    category: 'forensics',
    dangerous: true,
  },
  {
    key: 'forensics.storeReportedMessage',
    type: 'boolean',
    default: 'false',
    label: 'Store the body of the reported message',
    description:
      'Off by default. Forensic reports often embed the complete failing message, which is attacker-controlled content (and usually the phish itself). Stored truncated, for inspection only, never rendered as HTML.',
    category: 'forensics',
    dangerous: true,
  },
  {
    key: 'processing.enabled',
    type: 'boolean',
    default: 'true',
    label: 'Run scheduled mail processing',
    description:
      'Pause ingestion without stopping the container. Takes effect on the next cycle; a cycle already running is allowed to finish.',
    category: 'processing',
  },
  {
    key: 'domains.autocheckEnabled',
    type: 'boolean',
    default: 'true',
    label: 'Check domain DNS records on a schedule',
    description:
      'Re-runs the MX/SPF/DMARC/DKIM/MTA-STS checks for every monitored domain in the background, so the domain status page is already populated when you open it.',
    category: 'domains',
  },
  {
    key: 'domains.checkIntervalHours',
    type: 'number',
    default: '24',
    min: 1,
    max: 720,
    label: 'Domain check interval (hours)',
    description: 'How often the background check runs. Records change rarely; daily is plenty.',
    category: 'domains',
  },
  {
    key: 'mailbox.host',
    type: 'string',
    default: '',
    label: 'Mail server hostname',
    description:
      'The IMAP server holding the reports, e.g. mail.example.com. Usually the same server that receives mail for rua=/ruf=.',
    category: 'mailbox',
  },
  {
    key: 'mailbox.port',
    type: 'number',
    default: '993',
    min: 1,
    max: 65535,
    label: 'IMAP port',
    description: '993 is IMAPS (TLS). Plain 143 is not supported - the connection is always encrypted.',
    category: 'mailbox',
  },
  {
    key: 'mailbox.user',
    type: 'string',
    default: '',
    label: 'Mailbox user',
    description: 'The account that receives the reports, e.g. dmarc@example.com.',
    category: 'mailbox',
  },
  {
    key: 'mailbox.password',
    type: 'string',
    default: '',
    label: 'Mailbox password',
    description:
      'Stored in the database, so the volume holding it needs the same care as the reports themselves. Leave it empty to keep the current value.',
    category: 'mailbox',
    secret: true,
  },
  {
    key: 'mailbox.verifyTls',
    type: 'boolean',
    default: 'true',
    label: 'Verify the mail server certificate',
    description:
      'On by default. Turning it off accepts any certificate, which makes an interception or a wrong hostname invisible - only do it for a server with a self-signed certificate.',
    category: 'mailbox',
    dangerous: true,
  },
  {
    key: 'branding.instanceName',
    type: 'string',
    default: 'DMARC Viewer',
    label: 'Instance name',
    description: 'Shown in the header, the browser tab and the sign-in screen.',
    category: 'branding',
  },
  {
    key: 'branding.accent',
    type: 'string',
    default: '#4f46e5',
    label: 'Accent colour',
    description:
      'Brand colour as a hex value, applied to buttons, links and highlights. The whole palette is derived from it at runtime, so no rebuild is needed.',
    category: 'branding',
    pattern: /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i,
  },
  {
    key: 'auth.registrationOpen',
    type: 'boolean',
    default: 'false',
    label: 'Allow self-registration',
    description:
      'Off: only an admin can create accounts, and a new account sees no domains until an admin assigns one. On: anyone who can reach the login page can create a (domain-less) account.',
    category: 'auth',
  },
  {
    key: 'auth.sessionHours',
    type: 'number',
    default: '12',
    min: 1,
    max: 720,
    label: 'Session lifetime (hours)',
    description: 'How long a login stays valid before the user must sign in again.',
    category: 'auth',
  },
  {
    key: 'auth.maxFailedLogins',
    type: 'number',
    default: '10',
    min: 1,
    max: 1000,
    label: 'Failed logins before lockout',
    description: 'Consecutive failures from one account before it is locked.',
    category: 'auth',
  },
  {
    key: 'auth.lockoutMinutes',
    type: 'number',
    default: '15',
    min: 1,
    max: 10080,
    label: 'Lockout duration (minutes)',
    description: 'How long an account stays locked after too many failed logins.',
    category: 'auth',
  },
  {
    key: 'data.reportRetentionDays',
    type: 'number',
    default: '0',
    min: 0,
    max: 3650,
    label: 'Keep aggregate reports for (days)',
    description:
      'Deletes aggregate reports whose reporting period ended more than this many days ago, and their records with them. 0 keeps them forever. Irreversible - and a backup taken earlier still contains them.',
    category: 'data',
    dangerous: true,
  },
  {
    key: 'data.forensicRetentionDays',
    type: 'number',
    default: '0',
    min: 0,
    max: 3650,
    label: 'Keep forensic reports for (days)',
    description:
      'Forensic reports can contain the reported message itself - headers always, the body when enabled below. This is third-party content you may not need to keep; 0 keeps them forever. Irreversible.',
    category: 'data',
    dangerous: true,
  },
  {
    key: 'data.tlsRptRetentionDays',
    type: 'number',
    default: '365',
    min: 0,
    max: 3650,
    label: 'Keep TLS-RPT reports for (days)',
    description:
      'SMTP TLS outcomes reported by senders. They are the evidence for MTA-STS enforcement, so they default to a year rather than forever: a year of failures is more than enough to answer the question. 0 keeps them forever.',
    category: 'data',
    dangerous: true,
  },
  {
    key: 'data.auditRetentionDays',
    type: 'number',
    default: '365',
    min: 0,
    max: 3650,
    label: 'Keep audit records for (days)',
    description:
      'The audit log is evidence of who changed what. Export it before shortening this. 0 keeps it forever; the default is one year.',
    category: 'data',
    dangerous: true,
  },
];

const DEFINITIONS = new Map(SETTINGS.map((s) => [s.key, s]));

const CACHE_TTL_MS = 15_000;
let cache: Map<string, string> | null = null;
let cacheLoadedAt = 0;

export function isSettingKey(key: string): boolean {
  return DEFINITIONS.has(key);
}

export function getSettingDefinition(key: string): SettingDefinition | undefined {
  return DEFINITIONS.get(key);
}

export function invalidateSettingsCache(): void {
  cache = null;
  cacheLoadedAt = 0;
}

async function loadCache(): Promise<Map<string, string>> {
  const now = Date.now();
  if (cache && now - cacheLoadedAt < CACHE_TTL_MS) {
    return cache;
  }

  const rows = await prisma.setting.findMany();
  const next = new Map<string, string>();
  for (const { key, value } of rows) {
    next.set(key, value);
  }
  cache = next;
  cacheLoadedAt = now;
  return next;
}

/** Reads a setting, falling back to its declared default. */
export async function getSetting(key: string): Promise<string> {
  const definition = DEFINITIONS.get(key);
  if (!definition) {
    throw new Error(`Unknown setting: ${key}`);
  }

  try {
    const values = await loadCache();
    return values.get(key) ?? definition.default;
  } catch (error) {
    // Never let a settings lookup break mail processing or a request.
    console.warn(`⚠️ Failed to read setting ${key}, using default:`, error);
    return definition.default;
  }
}

/** The value actually stored in the database, ignoring the declared default. */
export async function getStoredSetting(key: string): Promise<string | null> {
  const row = await prisma.setting.findUnique({ where: { key } });
  return row?.value ?? null;
}

export async function getBooleanSetting(key: string): Promise<boolean> {
  const raw = (await getSetting(key)).trim().toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes' || raw === 'on';
}

export async function getNumberSetting(key: string): Promise<number> {
  const parsed = Number.parseInt(await getSetting(key), 10);
  const definition = DEFINITIONS.get(key);
  if (Number.isNaN(parsed)) {
    return definition ? Number.parseInt(definition.default, 10) : 0;
  }
  return parsed;
}

export interface SettingsSnapshot extends SettingDefinition {
  value: string;
  updatedAt: string | null;
  updatedBy: string | null;
}

export async function getAllSettings(): Promise<SettingsSnapshot[]> {
  const rows = await prisma.setting.findMany();
  const rowByKey = new Map(rows.map((r) => [r.key, r]));

  return SETTINGS.map((definition) => {
    const row = rowByKey.get(definition.key);
    return {
      ...definition,
      value: row?.value ?? definition.default,
      updatedAt: row?.updatedAt ? row.updatedAt.toISOString() : null,
      updatedBy: row?.updatedBy ?? null,
    };
  });
}

export function validateSettingValue(definition: SettingDefinition, value: string): string {
  const raw = value.trim();

  if (definition.type === 'boolean') {
    const normalized = raw.toLowerCase();
    if (!['true', 'false'].includes(normalized)) {
      throw Object.assign(new Error(`Setting ${definition.key} expects true or false`), {
        statusCode: 400,
        code: 'VALIDATION_ERROR',
      });
    }
    return normalized;
  }

  if (definition.type === 'number') {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isNaN(parsed)) {
      throw Object.assign(new Error(`Setting ${definition.key} expects a number`), {
        statusCode: 400,
        code: 'VALIDATION_ERROR',
      });
    }
    if (definition.min !== undefined && parsed < definition.min) {
      throw Object.assign(
        new Error(`Setting ${definition.key} must be at least ${definition.min}`),
        { statusCode: 400, code: 'VALIDATION_ERROR' },
      );
    }
    if (definition.max !== undefined && parsed > definition.max) {
      throw Object.assign(
        new Error(`Setting ${definition.key} must be at most ${definition.max}`),
        { statusCode: 400, code: 'VALIDATION_ERROR' },
      );
    }
    return String(parsed);
  }

  if (definition.pattern && !definition.pattern.test(raw)) {
    throw Object.assign(
      new Error(`Setting ${definition.key} does not look right (expected ${definition.pattern})`),
      { statusCode: 400, code: 'VALIDATION_ERROR' },
    );
  }

  return raw;
}

export async function setSetting(key: string, value: string, updatedBy?: string): Promise<SettingsSnapshot> {
  const definition = DEFINITIONS.get(key);
  if (!definition) {
    throw Object.assign(new Error(`Unknown setting: ${key}`), {
      statusCode: 404,
      code: 'NOT_FOUND',
    });
  }

  const normalized = validateSettingValue(definition, value);

  const row = await prisma.setting.upsert({
    where: { key },
    create: { key, value: normalized, updatedBy: updatedBy ?? null },
    update: { value: normalized, updatedBy: updatedBy ?? null },
  });

  invalidateSettingsCache();

  return {
    ...definition,
    value: row.value,
    updatedAt: row.updatedAt.toISOString(),
    updatedBy: row.updatedBy,
  };
}

/** Writes the declared default for every setting that has no row yet. Existing values are kept. */
export async function ensureSettingsSeeded(): Promise<number> {
  let created = 0;

  for (const definition of SETTINGS) {
    const existing = await prisma.setting.findUnique({ where: { key: definition.key } });
    if (existing) {
      continue;
    }
    await prisma.setting.create({
      data: { key: definition.key, value: definition.default, updatedBy: 'system' },
    });
    created++;
  }

  if (created > 0) {
    invalidateSettingsCache();
  }

  return created;
}
