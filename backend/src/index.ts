import { setupLogging } from './utils/logger.js';
import { createApp } from './app.js';
import { config } from './config/env.js';
import { initializeDatabase, disconnectDatabase } from './db/prisma.js';
import { EmailProcessor } from './services/emailProcessor.js';
import { ensureSettingsSeeded, getBooleanSetting, getNumberSetting } from './services/settings.js';
import { ensureAdminUser } from './services/auth.js';
import { runAllChecks, discoverDomains } from './services/domainMonitor.js';

setupLogging();

async function startServer() {
  try {
    console.log('🚀 Starting DMARC Report Viewer Backend...');
    
    // Validate environment configuration
    console.log('✅ Environment configuration loaded');
    console.log(`📧 IMAP: ${config.imap.user}@${config.imap.host}:${config.imap.port}`);
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
    
    // Run initial email processing
    console.log('🔄 Running initial email processing...');
    try {
      const initialResult = await emailProcessor.processEmails();
      console.log(
        `📊 Initial processing: ${initialResult.processed} aggregate, ${initialResult.forensic} forensic, ${initialResult.errors} errors, ${initialResult.skipped} skipped`,
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
      emailProcessor.scheduleProcessing(schedulerIntervalMs);
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