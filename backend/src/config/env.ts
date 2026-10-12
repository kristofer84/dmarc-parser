import dotenv from 'dotenv';

dotenv.config();

interface Config {
  imap: {
    /** Null when the mailbox has not been given in the environment - it can then be set in the UI. */
    host: string | null;
    port: number;
    user: string | null;
    password: string | null;
  };
  database: {
    url: string;
  };
  server: {
    port: number;
    nodeEnv: string;
    enableScheduledProcessing: boolean;
    scheduledProcessingIntervalMs: number;
  };
}

function validateEnv(): Config {
  // Everything except the database URL is optional: a fresh deployment should start, serve the
  // UI and let an administrator fill in the mailbox there instead of crash-looping on a
  // missing variable.
  const requiredVars = ['DATABASE_URL'];

  const missing = requiredVars.filter(varName => !process.env[varName]);
  
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  const imapPortRaw = process.env.IMAP_PORT?.trim();
  const imapPort = imapPortRaw ? parseInt(imapPortRaw, 10) : 993;
  if (imapPortRaw && (isNaN(imapPort) || imapPort <= 0 || imapPort > 65535)) {
    throw new Error('IMAP_PORT must be a valid port number between 1 and 65535');
  }

  const serverPort = parseInt(process.env.PORT || '3000', 10);
  if (isNaN(serverPort) || serverPort <= 0 || serverPort > 65535) {
    throw new Error('PORT must be a valid port number between 1 and 65535');
  }

  const rawNodeEnv = process.env.NODE_ENV || 'development';
  const normalizedNodeEnv = rawNodeEnv.trim().toLowerCase();

  const rawSchedulerPreference = process.env.ENABLE_SCHEDULED_EMAIL_PROCESSING?.trim().toLowerCase();
  const schedulerIntervalEnv = process.env.EMAIL_PROCESSING_INTERVAL_MS?.trim();

  const schedulerIntervalMs = schedulerIntervalEnv ? parseInt(schedulerIntervalEnv, 10) : 300000;

  if (Number.isNaN(schedulerIntervalMs) || schedulerIntervalMs <= 0) {
    throw new Error('EMAIL_PROCESSING_INTERVAL_MS must be a positive integer');
  }

  const enableScheduledProcessing = rawSchedulerPreference === 'true'
    ? true
    : rawSchedulerPreference === 'false'
      ? false
      : true;

  return {
    imap: {
      host: process.env.IMAP_HOST?.trim() || null,
      port: imapPort,
      user: process.env.IMAP_USER?.trim() || null,
      password: process.env.IMAP_PASSWORD || null,
    },
    database: {
      url: process.env.DATABASE_URL!,
    },
    server: {
      port: serverPort,
      nodeEnv: normalizedNodeEnv,
      enableScheduledProcessing,
      scheduledProcessingIntervalMs: schedulerIntervalMs,
    },
  };
}

export const config = validateEnv();