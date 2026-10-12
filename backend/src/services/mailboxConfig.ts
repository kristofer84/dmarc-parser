import Imap from 'node-imap';
import { config } from '../config/env.js';
import { getBooleanSetting, getNumberSetting, getSetting } from './settings.js';

/**
 * Where the mailbox credentials come from.
 *
 * A deployment configured through the environment (the compose files do that) keeps working
 * unchanged; anything set in the UI covers what the environment left out. Per field, so
 * changing the password in the UI does not require repeating the host, and a deployment with
 * no IMAP_* variables at all is configured entirely from the settings table.
 */

export interface MailboxConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  verifyTls: boolean;
}

export interface ResolvedMailbox {
  configured: boolean;
  config: MailboxConfig | null;
  missing: string[];
  source: 'environment' | 'settings' | 'mixed' | 'none';
  /** One line, safe to log: never contains the password. */
  summary: string;
}

const REQUIRED_FIELDS: Array<'host' | 'user' | 'password'> = ['host', 'user', 'password'];

async function fromSettings(): Promise<MailboxConfig> {
  const [host, user, password, port, verifyTls] = await Promise.all([
    getSetting('mailbox.host'),
    getSetting('mailbox.user'),
    getSetting('mailbox.password'),
    getNumberSetting('mailbox.port'),
    getBooleanSetting('mailbox.verifyTls'),
  ]);

  return { host: host.trim(), user: user.trim(), password, port, verifyTls };
}

export async function resolveMailboxConfig(): Promise<ResolvedMailbox> {
  const merged = await fromSettings();

  const usedEnvironment: string[] = [];
  if (process.env.IMAP_HOST?.trim()) {
    merged.host = process.env.IMAP_HOST.trim();
    usedEnvironment.push('host');
  }
  if (process.env.IMAP_PORT?.trim()) {
    merged.port = config.imap.port;
    usedEnvironment.push('port');
  }
  if (process.env.IMAP_USER?.trim()) {
    merged.user = process.env.IMAP_USER.trim();
    usedEnvironment.push('user');
  }
  if (process.env.IMAP_PASSWORD) {
    merged.password = process.env.IMAP_PASSWORD;
    usedEnvironment.push('password');
  }

  const missing = REQUIRED_FIELDS.filter((field) => !merged[field]);

  if (missing.length > 0) {
    return {
      configured: false,
      config: null,
      missing,
      source: usedEnvironment.length > 0 ? 'mixed' : 'none',
      summary: `no mailbox configured yet (missing ${missing.join(', ')})`,
    };
  }

  const source: ResolvedMailbox['source'] =
    usedEnvironment.length === 0 ? 'settings' : usedEnvironment.length === 4 ? 'environment' : 'mixed';

  return {
    configured: true,
    config: merged,
    missing: [],
    source,
    summary: `${merged.user}@${merged.host}:${merged.port} (from the ${source === 'mixed' ? 'environment and settings' : source})`,
  };
}

export interface MailboxTestResult {
  ok: boolean;
  message: string;
  greeting?: string;
}

/** Only for building a candidate config from a test request; ignores empty strings. */
function applyOverrides(base: MailboxConfig, overrides: Partial<MailboxConfig>): MailboxConfig {
  const next = { ...base };
  if (typeof overrides.host === 'string' && overrides.host.trim()) {
    next.host = overrides.host.trim();
  }
  if (typeof overrides.user === 'string' && overrides.user.trim()) {
    next.user = overrides.user.trim();
  }
  if (typeof overrides.password === 'string' && overrides.password.length > 0) {
    next.password = overrides.password;
  }
  if (typeof overrides.port === 'number' && Number.isFinite(overrides.port)) {
    next.port = overrides.port;
  }
  if (typeof overrides.verifyTls === 'boolean') {
    next.verifyTls = overrides.verifyTls;
  }
  return next;
}

/**
 * Opens a real IMAP connection to prove the credentials work, then closes it. Used by the
 * "Test connection" button so a wrong hostname or password is a message in the UI rather
 * than a silent failure five minutes later in the ingestion cycle.
 */
export async function testMailboxConnection(
  overrides: Partial<MailboxConfig> = {},
  timeoutMs = 15000,
): Promise<MailboxTestResult> {
  const resolved = await resolveMailboxConfig();
  const base: MailboxConfig =
    resolved.config ??
    (await fromSettings()); /* may be incomplete; validated below after applying overrides */
  const candidate = applyOverrides(base, overrides);

  const missing = REQUIRED_FIELDS.filter((field) => !candidate[field]);
  if (missing.length > 0) {
    return { ok: false, message: `Still missing: ${missing.join(', ')}` };
  }

  return new Promise<MailboxTestResult>((resolve) => {
    let settled = false;

    const finish = (result: MailboxTestResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      try {
        imap.end();
      } catch {
        // The connection may already be gone; nothing useful to do about it.
      }
      resolve(result);
    };

    const timer = setTimeout(
      () => finish({ ok: false, message: `Timed out after ${Math.round(timeoutMs / 1000)}s connecting to ${candidate.host}:${candidate.port}` }),
      timeoutMs + 5000,
    );

    const imap = new Imap({
      user: candidate.user,
      password: candidate.password,
      host: candidate.host,
      port: candidate.port,
      tls: true,
      tlsOptions: {
        rejectUnauthorized: candidate.verifyTls,
        servername: candidate.host,
      },
      connTimeout: timeoutMs,
      authTimeout: timeoutMs,
    });

    imap.once('ready', () => {
      finish({
        ok: true,
        message: `Connected to ${candidate.host}:${candidate.port} as ${candidate.user}`,
      });
    });

    imap.once('error', (error: Error) => {
      finish({ ok: false, message: `Connection failed: ${error.message}` });
    });

    try {
      imap.connect();
    } catch (error) {
      finish({
        ok: false,
        message: `Connection failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  });
}
