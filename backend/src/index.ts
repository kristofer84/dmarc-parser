import { setupLogging } from './utils/logger.js';
import { createApp } from './app.js';
import { config } from './config/env.js';
import { initializeDatabase, disconnectDatabase } from './db/prisma.js';
import { EmailProcessor, type ProcessingResult } from './services/emailProcessor.js';
import { ensureSettingsSeeded, getBooleanSetting, getNumberSetting } from './services/settings.js';
import { ensureAdminUser } from './services/auth.js';
import { runAllChecks, discoverDomains } from './services/domainMonitor.js';
import { resolveMailboxConfig } from './services/mailboxConfig.js';
import { recordMailboxRun, resolveIngestMailboxes } from './services/orgMailboxes.js';
import {
  recordProcessingFailure,
  recordProcessingSuccess,
  setMailboxConfigured,
} from './services/processingStatus.js';
import { runRetention } from './services/retention.js';
import { evaluateAlerts } from './services/alerts.js';
import { recordAudit } from './services/audit.js';
import { ensureDefaultOrganization, ensureSuperadminMembership } from './services/organizations.js';

setupLogging();

async function startServer() {
  try {
    console.log('🚀 Starting DMARC Report Viewer Backend...');
    
    // Validate environment configuration
    console.log('✅ Environment configuration loaded');
    // Environment values win where they are set; anything missing can be filled in from the
    // UI, so a deployment that never sets IMAP_* still becomes functional.
    const mailbox = await resolveMailboxConfig();
    console.log(`📧 Mailbox: ${mailbox.summary}`);
    console.log(`🗄️ Database: ${config.database.url}`);
    console.log(`🌐 Server: Port ${config.server.port} (${config.server.nodeEnv})`);

    // Initialize database
    await initializeDatabase();

    try {
      const seeded = await ensureSettingsSeeded();
      if (seeded > 0) {
        console.log(`⚙️ Seeded ${seeded} application setting(s) with their defaults`);
      }
    } catch (error) {
      console.warn('⚠️ Failed to seed application settings:', error);
    }

    try {
      await ensureAdminUser();
    } catch (error) {
      console.warn('⚠️ Failed to ensure an administrator account exists:', error);
    }

    // Tenancy bootstrap: one Default organisation for everything that predates it, and a
    // membership for every superadmin. Both are idempotent and cheap after the first run.
    try {
      await ensureDefaultOrganization();
      await ensureSuperadminMembership();
    } catch (error) {
      console.warn('⚠️ Failed to initialise organisations:', error);
    }

    // Domain DNS checks. The interval is read from settings on every tick rather than fixed
    // at start, so changing it in the UI takes effect without a restart.
    // Seed the domain list from the reports already in the database, so a fresh deployment
    // shows a populated status page instead of an empty one. Idempotent: existing names are
    // left untouched.
    try {
      const discovered = await discoverDomains();
      if (discovered.added.length > 0) {
        console.log(
          `🔎 Added ${discovered.added.length} domain(s) seen in existing reports: ${discovered.added.join(', ')}`,
        );
      }
    } catch (error) {
      console.warn('⚠️ Domain discovery failed:', error);
    }

    const DOMAIN_TICK_MS = 15 * 60 * 1000;
    let lastDomainCheckAt = 0;

    const runDomainChecksIfDue = async (force = false) => {
      if (!(await getBooleanSetting('domains.autocheckEnabled'))) {
        return;
      }

      const intervalMs = (await getNumberSetting('domains.checkIntervalHours')) * 3600_000;
      if (!force && Date.now() - lastDomainCheckAt < intervalMs) {
        return;
      }

      lastDomainCheckAt = Date.now();
      const result = await runAllChecks();
      console.log(`🔎 Domain checks: ${result.checked} checked, ${result.failed} failed`);
    };

    // Shortly after boot, so a fresh deployment shows real results on the status page rather
    // than "never checked"; the delay keeps it out of the way of the first mail cycle.
    setTimeout(() => {
      runDomainChecksIfDue(true).catch((error) => console.warn('⚠️ Initial domain check failed:', error));
    }, 20_000).unref?.();

    setInterval(() => {
      runDomainChecksIfDue().catch((error) => console.warn('⚠️ Scheduled domain check failed:', error));
    }, DOMAIN_TICK_MS).unref?.();

    // Data retention. The policy is read on every tick, so changing a setting takes effect
    // without a restart. Six-hourly rather than daily: the work is a few indexed deletes, and
    // a missed window on a Pi that reboots is more likely than a run being too frequent.
    const RETENTION_TICK_MS = 6 * 60 * 60 * 1000;

    const runRetentionIfDue = async () => {
      const result = await runRetention();
      const { reports, forensics, tlsrpt: tlsRpt, audit } = result.deleted;
      if (reports + forensics + tlsRpt + audit > 0) {
        console.log(
          `🧹 Retention: ${reports} report(s), ${forensics} forensic, ${tlsRpt} TLS-RPT, ${audit} audit row(s) removed`,
        );
        await recordAudit({
          action: 'retention.run',
          actor: 'system',
          detail: { ...result.deleted, trigger: 'schedule' },
        });
      }
    };

    setTimeout(() => {
      runRetentionIfDue().catch((error) =>
        console.warn('⚠️ Initial retention run failed:', error),
      );
    }, 90_000).unref?.();

    setInterval(() => {
      runRetentionIfDue().catch((error) =>
        console.warn('⚠️ Scheduled retention run failed:', error),
      );
    }, RETENTION_TICK_MS).unref?.();

    // Alert scan. Both findings look back over the same 24 h window and carry a dedupKey that the
    // database enforces, so a 15-minute tick is a cheap re-read rather than a source of duplicates.
    // The setting is read every tick, so switching alerts off takes effect without a restart.
    const ALERT_TICK_MS = 15 * 60 * 1000;

    const runAlertScanIfDue = async () => {
      if (!(await getBooleanSetting('alerts.enabled'))) {
        return;
      }

      const result = await evaluateAlerts();
      console.log(
        `🔔 Alerts: ${result.created} created, ${result.delivered} delivered, ${result.errors} error(s)`,
      );
    };

    // After the first mail cycle rather than before it: the scan reads what ingestion wrote.
    setTimeout(() => {
      runAlertScanIfDue().catch((error) => console.warn('⚠️ Initial alert scan failed:', error));
    }, 60_000).unref?.();

    setInterval(() => {
      runAlertScanIfDue().catch((error) => console.warn('⚠️ Scheduled alert scan failed:', error));
    }, ALERT_TICK_MS).unref?.();

    // Create Express app
    const app = createApp();

    // Start HTTP server
    const server = app.listen(config.server.port, '0.0.0.0', () => {
      console.log(`✅ Server running on port ${config.server.port}`);
      console.log(`🔗 Health check: http://localhost:${config.server.port}/health`);
      console.log(`📊 API endpoints:`);
      console.log(`   - GET /api/reports`);
      console.log(`   - GET /api/reports/:id`);
      console.log(`   - GET /api/summary`);
    });

    // Initialize email processor
    console.log('🛠️ Initializing email processor...');
    let emailProcessor: EmailProcessor;
    try {
      emailProcessor = new EmailProcessor();
      console.log('✅ Email processor initialized');
    } catch (error) {
      console.error('❌ Failed to initialize email processor:', error);
      throw error;
    }
    
    // Ingestion cycle: one sequential pass over every mailbox that should be ingested - each
    // organisation's enabled OrgMailbox rows, plus the virtual legacy mailbox for the Default
    // organisation while it has none. Sequential rather than parallel on purpose: the same
    // EmailProcessor instance stamps a per-run context onto every row it writes, and a shared
    // IMAP budget is the last thing that should compete with itself on a small host. One
    // mailbox failing must not stop the others, so failures are collected per mailbox.
    const runIngestionCycle = async (): Promise<ProcessingResult> => {
      const mailboxes = await resolveIngestMailboxes();
      setMailboxConfigured(mailboxes.length > 0);

      if (mailboxes.length === 0) {
        console.log(
          '📭 No mailbox configured yet - set the legacy one under Administration → Settings, or add one to an organisation',
        );
        const empty: ProcessingResult = {
          processed: 0,
          forensic: 0,
          tlsRpt: 0,
          errors: 0,
          skipped: 0,
          quarantined: 0,
          details: [],
        };
        recordProcessingSuccess(empty);
        return empty;
      }

      const totals: ProcessingResult = {
        processed: 0,
        forensic: 0,
        tlsRpt: 0,
        errors: 0,
        skipped: 0,
        quarantined: 0,
        details: [],
      };
      let failures = 0;
      let firstError: unknown = null;

      for (const mailbox of mailboxes) {
        const label = `${mailbox.orgName ? `${mailbox.orgName} · ` : ''}${mailbox.label}`;

        try {
          const result = await emailProcessor.processMailbox(mailbox, { recordStatus: false });
          totals.processed += result.processed;
          totals.forensic += result.forensic;
          totals.tlsRpt += result.tlsRpt;
          totals.errors += result.errors;
          totals.skipped += result.skipped;
          totals.quarantined += result.quarantined;
          totals.details.push(...result.details);

          await recordMailboxRun(mailbox.mailboxId, null);
          console.log(
            `📬 ${label}: ${result.processed} aggregate, ${result.forensic} forensic, ${result.tlsRpt} TLS-RPT, ${result.skipped} skipped, ${result.quarantined} quarantined, ${result.errors} error(s)`,
          );
        } catch (error) {
          failures++;
          if (firstError === null) {
            firstError = error;
          }
          await recordMailboxRun(mailbox.mailboxId, error);
          console.error(
            `❌ ${label}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      if (failures > 0) {
        recordProcessingFailure(firstError);
      } else {
        recordProcessingSuccess(totals);
      }

      return totals;
    };

    // Run initial email processing
    console.log('🔄 Running initial email processing...');
    try {
      const initialResult = await runIngestionCycle();
      console.log(
        `📊 Initial processing: ${initialResult.processed} aggregate, ${initialResult.forensic} forensic, ${initialResult.tlsRpt} TLS-RPT, ${initialResult.errors} errors, ${initialResult.skipped} skipped, ${initialResult.quarantined} quarantined`,
      );
    } catch (error) {
      console.warn('⚠️ Initial email processing failed (this is normal if IMAP credentials are not configured):', error);
    }

    const schedulerPreference = process.env.ENABLE_SCHEDULED_EMAIL_PROCESSING?.trim().toLowerCase();
    const schedulerEnabled = config.server.enableScheduledProcessing;
    const schedulerIntervalMs = config.server.scheduledProcessingIntervalMs;
    const schedulerPreferenceDescription = schedulerPreference === undefined
      ? 'not set (using default behaviour)'
      : `set to "${schedulerPreference}"`;

    console.log(
      `🗓️ Scheduled email processing at startup: ${schedulerEnabled ? 'ENABLED' : 'DISABLED'} (${schedulerPreferenceDescription})`,
    );

    if (schedulerEnabled) {
      console.log('⏰ Starting scheduled email processing...');
      emailProcessor.scheduleProcessing(schedulerIntervalMs, runIngestionCycle);
      console.log(`⏲️ Email processing interval: ${Math.round(schedulerIntervalMs / 1000)} seconds`);
    } else {
      const disabledReason = schedulerPreference === 'false'
        ? 'via ENABLE_SCHEDULED_EMAIL_PROCESSING=false'
        : 'because automatic scheduling is disabled by default for this environment';
      console.log(`⏰ Scheduled processing disabled ${disabledReason}`);
      console.log('💡 To enable automatic checks, set ENABLE_SCHEDULED_EMAIL_PROCESSING=true');
      console.log('💡 You can still process emails manually using the CLI or service methods');
    }

    // Graceful shutdown handling
    const gracefulShutdown = async (signal: string) => {
      console.log(`\n🛑 Received ${signal}, starting graceful shutdown...`);
      
      // Stop accepting new connections
      server.close(async () => {
        console.log('🔌 HTTP server closed');
        
        try {
          // Disconnect from database
          await disconnectDatabase();
          console.log('✅ Graceful shutdown completed');
          process.exit(0);
        } catch (error) {
          console.error('❌ Error during shutdown:', error);
          process.exit(1);
        }
      });

      // Force shutdown after 10 seconds
      setTimeout(() => {
        console.error('❌ Forced shutdown after timeout');
        process.exit(1);
      }, 10000);
    };

    // Handle shutdown signals
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

    // Handle uncaught exceptions
    process.on('uncaughtException', (error) => {
      console.error('❌ Uncaught Exception:', error);
      process.exit(1);
    });

    process.on('unhandledRejection', (reason, promise) => {
      console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
      process.exit(1);
    });

  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

// Start the server
startServer();