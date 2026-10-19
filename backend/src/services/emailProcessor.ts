import { ImapClient, EmailMessage, EmailAttachment } from './imapClient.js';
import { DmarcParser } from './dmarcParser.js';
import { RufParser } from './rufParser.js';
import { TlsRptParser } from './tlsRptParser.js';
import { prisma } from '../db/prisma.js';
import { getBooleanSetting } from './settings.js';
import { resolveMailboxConfig } from './mailboxConfig.js';
import {
  recordProcessingSuccess,
  recordProcessingFailure,
  recordScheduledRun,
  setMailboxConfigured,
} from './processingStatus.js';

/** Logged once per unconfigured spell rather than on every cycle. */
let warnedAboutMailbox = false;

export interface ProcessingResult {
  processed: number;
  forensic: number;
  tlsRpt: number;
  errors: number;
  skipped: number;
  details: Array<{
    status: 'success' | 'error' | 'skipped';
    message: string;
    reportId?: string;
    forensicReportId?: string;
  }>;
}

/** Network mailboxes render senders as `Name <addr>`; we only want the address. */
function extractEmailAddress(from: string): string | null {
  const match = from.match(/<([^>]+)>/);
  const address = (match ? match[1] : from).trim();
  return address.length > 0 ? address : null;
}

export class EmailProcessor {
  private imapClient: ImapClient;
  private dmarcParser: DmarcParser;
  private rufParser: RufParser;

  constructor() {
    this.imapClient = new ImapClient();
    this.dmarcParser = new DmarcParser();
    this.rufParser = new RufParser();
  }

  async processEmails(): Promise<ProcessingResult> {
    const result: ProcessingResult = {
      processed: 0,
      forensic: 0,
      tlsRpt: 0,
      errors: 0,
      skipped: 0,
      details: [],
    };

    try {
      console.log('🚀 Starting email processing service...');

      // Without a mailbox there is nothing to fetch. This is a normal state on a fresh
      // deployment - the UI is up and an administrator still has to fill the settings in - so
      // it is reported as "not configured" rather than as a failure.
      const mailbox = await resolveMailboxConfig();
      setMailboxConfigured(mailbox.configured);

      if (!mailbox.configured) {
        if (!warnedAboutMailbox) {
          console.log(`📭 ${mailbox.summary} - set it under Administration → Settings`);
          warnedAboutMailbox = true;
        }
        recordProcessingSuccess(result);
        return result;
      }
      warnedAboutMailbox = false;

      // Check if this is the first run (empty database)
      const reportCount = await prisma.report.count();
      const isFirstRun = reportCount === 0;

      if (isFirstRun) {
        console.log('📊 Database is empty - performing initial import of all DMARC reports');
      }

      // Connect to IMAP server
      await this.imapClient.connectWithRetry();
      
      // Fetch emails with DMARC attachments
      const messages = await this.imapClient.processEmails(isFirstRun);
      
      if (messages.length === 0) {
        console.log('📭 No DMARC reports to process');
        recordProcessingSuccess(result);
        return result;
      }

      console.log(`📬 Processing ${messages.length} DMARC reports...`);

      // Track successfully processed messages to mark as read
      const successfullyProcessedUids: number[] = [];

      // Process each message
      for (const message of messages) {
        try {
          const messageProcessed = await this.processMessage(message, result);
          if (messageProcessed) {
            successfullyProcessedUids.push(message.uid);
          }
        } catch (error) {
          console.error(`❌ Failed to process message ${message.uid}:`, error);
          result.errors++;
          result.details.push({
            status: 'error',
            message: `Failed to process message ${message.uid}: ${error}`,
          });
        }
      }

      // Mark successfully processed messages as read
      if (successfullyProcessedUids.length > 0) {
        console.log(`📧 Attempting to mark ${successfullyProcessedUids.length} messages as read: [${successfullyProcessedUids.join(', ')}]`);
        await this.imapClient.markProcessedMessagesAsRead(successfullyProcessedUids);
        console.log(`📁 Attempting to archive ${successfullyProcessedUids.length} processed messages`);
        await this.imapClient.moveMessagesToArchive(successfullyProcessedUids);
      } else {
        console.log('📭 No messages were successfully processed, nothing to mark as read');
      }

      console.log('✅ Email processing completed');
      console.log(
        `📊 Results: ${result.processed} aggregate, ${result.forensic} forensic, ${result.errors} errors, ${result.skipped} skipped`,
      );

      recordProcessingSuccess(result);

      return result;

    } catch (error) {
      console.error('❌ Email processing service failed:', error);
      recordProcessingFailure(error);
      throw error;
    } finally {
      // Always disconnect
      try {
        await this.imapClient.disconnect();
      } catch (error) {
        console.error('⚠️ Failed to disconnect IMAP client:', error);
      }
    }
  }

  /**
   * Reprocesses mail that was already ingested, straight out of the archive.
   *
   * The mailbox is only read: no flags are set, nothing is moved, so an interrupted reparse
   * is harmless and can simply be run again. The database writes go through the same dedup
   * keys as normal ingestion, so a report that is already stored is skipped rather than
   * duplicated; the useful case is backfilling fields that were switched on after the first
   * pass (full headers, the reported body, the raw feedback block) or re-running a parser
   * fix over old reports.
   */
  async reparseArchivedMessages(mailbox: string = 'dmarc-archive'): Promise<ProcessingResult> {
    const result: ProcessingResult = {
      processed: 0,
      forensic: 0,
      tlsRpt: 0,
      errors: 0,
      skipped: 0,
      details: [],
    };

    console.log(`🔄 Reparsing the ${mailbox} mailbox (read-only: no flags changed, nothing moved)`);

    try {
      await this.imapClient.connectWithRetry();
      const messages = await this.imapClient.fetchAllFromMailbox(mailbox);
      console.log(`📬 Reparsing ${messages.length} archived message(s)...`);

      for (const message of messages) {
        try {
          await this.processMessage(message, result);
        } catch (error) {
          console.error(`❌ Failed to reparse message ${message.uid}:`, error);
          result.errors++;
        }
      }
    } catch (error) {
      console.error('❌ Reparse failed:', error);
      // Deliberately not recorded as a processing run: a manual reparse must not make a
      // stalled scheduler look healthy on /health.
      recordProcessingFailure(error);
      throw error;
    } finally {
      try {
        await this.imapClient.disconnect();
      } catch (error) {
        console.warn('⚠️ Failed to disconnect IMAP client:', error);
      }
    }

    console.log(
      `📊 Reparse finished: ${result.processed} new aggregate, ${result.forensic} new forensic, ${result.skipped} already stored, ${result.errors} errors`,
    );

    return result;
  }

  private async processMessage(message: EmailMessage, result: ProcessingResult): Promise<boolean> {
    console.log(`🔄 Processing message from ${message.from} - ${message.subject}`);

    let hasSuccessfulAttachment = false;

    // Process each attachment. The kind decides the parser, and an unrecognised kind is
    // recorded rather than skipped in silence - "we received something we did not understand"
    // is itself a report worth seeing.
    for (const attachment of message.attachments) {
      try {
        const attachmentResult =
          attachment.kind === 'forensic'
            ? await this.processForensicAttachment(attachment, message, result)
            : attachment.kind === 'tlsrpt'
              ? await this.processTlsRptAttachment(attachment, message, result)
              : attachment.kind === 'unknown'
                ? await this.processUnknownAttachment(attachment, message, result)
                : await this.processAttachment(attachment, message, result);

        if (attachmentResult === 'success' || attachmentResult === 'skipped') {
          hasSuccessfulAttachment = true;
        }
      } catch (error) {
        console.error(`❌ Failed to process attachment ${attachment.filename}:`, error);
        result.errors++;
        result.details.push({
          status: 'error',
          message: `Failed to process attachment ${attachment.filename}: ${error}`,
        });
      }
    }

    return hasSuccessfulAttachment;
  }

  /**
   * Forensic (RUF) reports describe one failing message each, so they are stored one row per
   * report rather than aggregated. Returns 'ignored' when forensic processing is switched off,
   * which deliberately leaves the mail unread and in place.
   */
  private async processForensicAttachment(
    attachment: EmailAttachment,
    message: EmailMessage,
    result: ProcessingResult,
  ): Promise<'success' | 'skipped' | 'ignored'> {
    if (!(await getBooleanSetting('forensics.enabled'))) {
      console.log('⏸️ Forensic report processing is disabled in settings - leaving the message unread');
      return 'ignored';
    }

    await this.createProcessingLog({
      message,
      attachment,
      status: 'started',
      details: `Processing forensic report ${attachment.filename}`,
    });

    try {
      const reportData = await this.rufParser.parseAndValidate(attachment.content.toString('utf8'), {
        reportedMessageRaw: attachment.reportedMessage ?? null,
        reportMessageId: message.messageId ?? null,
        reporterEmail: extractEmailAddress(message.from),
        reportAuthenticationResults: message.authenticationResults ?? null,
        storeRawFeedback: await getBooleanSetting('forensics.storeRawFeedback'),
        storeFullHeaders: await getBooleanSetting('forensics.storeFullHeaders'),
        storeReportedMessage: await getBooleanSetting('forensics.storeReportedMessage'),
      });

      const existing = await prisma.forensicReport.findUnique({
        where: { dedupKey: reportData.dedupKey },
      });

      if (existing) {
        console.log(`⏭️ Forensic report ${reportData.dedupKey} already exists, skipping`);
        await this.createProcessingLog({
          message,
          attachment,
          status: 'skipped',
          details: `Forensic report ${reportData.dedupKey} already exists`,
          forensicReportId: existing.id,
        });
        result.skipped++;
        result.details.push({
          status: 'skipped',
          message: `Forensic report for ${reportData.domain} already exists`,
          forensicReportId: existing.id,
        });
        return 'skipped';
      }

      const saved = await prisma.forensicReport.create({
        data: this.rufParser.transformToDbFormat(reportData, message.uid),
      });

      console.log(
        `✅ Stored forensic report ${saved.id} for ${saved.domain} (source ${saved.sourceIp ?? 'unknown'}, spf=${reportData.spfResult ?? '?'} dkim=${reportData.dkimResult ?? '?'} dmarc=${reportData.dmarcResult ?? '?'})`,
      );
      if (!reportData.reportAuthenticated) {
        console.warn(`   ⚠️ Report mail did not authenticate - treat the claim as unverified`);
      }

      await this.createProcessingLog({
        message,
        attachment,
        status: 'success',
        details: `Stored forensic report ${saved.id} for domain ${reportData.domain}`,
        forensicReportId: saved.id,
      });

      result.forensic++;
      result.details.push({
        status: 'success',
        message: `Stored forensic report for ${reportData.domain} from ${reportData.reporter ?? 'unknown reporter'}`,
        forensicReportId: saved.id,
      });
      return 'success';
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      console.error(`❌ Forensic report processing failed: ${errorMessage}`);
      await this.createProcessingLog({
        message,
        attachment,
        status: 'error',
        details: `Forensic report processing failed: ${errorMessage}`,
      });
      result.errors++;
      result.details.push({
        status: 'error',
        message: `Failed to process forensic report ${attachment.filename}: ${errorMessage}`,
      });
      throw new Error(`Forensic report processing failed: ${errorMessage}`);
    }
  }

  /**
   * TLS-RPT (RFC 8460): one row per policy entry, deduplicated by report-id + domain + MX.
   * Unlike a DMARC report this is not about authentication - it is about whether SMTP TLS to
   * the MX actually worked, which is the evidence for promoting MTA-STS to enforce.
   */
  private async processTlsRptAttachment(
    attachment: EmailAttachment,
    message: EmailMessage,
    result: ProcessingResult,
  ): Promise<'success' | 'skipped'> {
    await this.createProcessingLog({
      message,
      attachment,
      status: 'started',
      details: `Processing TLS-RPT report ${attachment.filename}`,
    });

    try {
      const entries = TlsRptParser.parse(attachment.content, {
        fallbackDate: message.date ?? new Date(),
        filename: attachment.filename,
      });

      let stored = 0;
      let duplicates = 0;

      for (const entry of entries) {
        const existing = await prisma.tlsRptReport.findUnique({ where: { dedupKey: entry.dedupKey } });
        if (existing) {
          duplicates++;
          continue;
        }

        await prisma.tlsRptReport.create({
          data: {
            dedupKey: entry.dedupKey,
            reportId: entry.reportId,
            orgName: entry.orgName,
            contactInfo: entry.contactInfo,
            dateBegin: entry.dateBegin,
            dateEnd: entry.dateEnd,
            policyDomain: entry.policyDomain,
            policyType: entry.policyType,
            mxHost: entry.mxHost,
            successfulCount: entry.successfulCount,
            failureCount: entry.failureCount,
            failureDetails: JSON.stringify(entry.failureDetails),
            policyString: entry.policyString,
            raw: entry.raw,
          },
        });
        stored++;
      }

      const failures = entries.reduce((sum, entry) => sum + entry.failureCount, 0);
      console.log(
        `✅ TLS-RPT ${attachment.filename}: ${stored} policy entr(ies) stored, ${duplicates} duplicate(s), ${failures} failed session(s)`,
      );

      await this.createProcessingLog({
        message,
        attachment,
        status: stored > 0 ? 'success' : 'skipped',
        details:
          stored > 0
            ? `Stored ${stored} TLS-RPT policy entr(ies)${failures > 0 ? `, ${failures} failed session(s)` : ''}`
            : `TLS-RPT already stored (${duplicates} duplicate entr(ies))`,
      });

      if (stored > 0) {
        result.tlsRpt++;
      } else {
        result.skipped++;
      }
      result.details.push({
        status: stored > 0 ? 'success' : 'skipped',
        message:
          stored > 0
            ? `Stored TLS-RPT report for ${entries.map((e) => e.policyDomain).join(', ')}`
            : `TLS-RPT report already stored (${attachment.filename})`,
      });
      return stored > 0 ? 'success' : 'skipped';
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`❌ TLS-RPT processing failed: ${errorMessage}`);
      await this.createProcessingLog({
        message,
        attachment,
        status: 'error',
        details: `TLS-RPT processing failed: ${errorMessage}`,
      });
      result.errors++;
      result.details.push({
        status: 'error',
        message: `Failed to process TLS-RPT ${attachment.filename}: ${errorMessage}`,
      });
      throw new Error(`TLS-RPT processing failed: ${errorMessage}`);
    }
  }

  /** Something arrived at the reports mailbox that this app does not parse. Surface it. */
  private async processUnknownAttachment(
    attachment: EmailAttachment,
    message: EmailMessage,
    result: ProcessingResult,
  ): Promise<'skipped'> {
    const details =
      `Unrecognised attachment "${attachment.filename}" (${attachment.contentType}, ` +
      `${attachment.content.length} bytes) - not stored, listed here so nothing arriving ` +
      `at the reports mailbox is invisible`;

    console.warn(`⚠️ ${details}`);
    await this.createProcessingLog({ message, attachment, status: 'skipped', details });
    result.skipped++;
    result.details.push({ status: 'skipped', message: details });
    return 'skipped';
  }

  private async processAttachment(
    attachment: EmailAttachment,
    message: EmailMessage,
    result: ProcessingResult,
  ): Promise<'success' | 'skipped'> {
    await this.createProcessingLog({
      message,
      attachment,
      status: 'started',
      details: `Processing attachment ${attachment.filename}`,
    });

    try {
      // Parse and validate the DMARC report
      const { reportData, records } = await this.dmarcParser.parseAndValidate(attachment.content, {
        filename: attachment.filename,
        contentType: attachment.contentType,
      });

      // Check if report already exists
      const existingReport = await prisma.report.findUnique({
        where: { reportId: reportData.reportId },
      });

      if (existingReport) {
        console.log(`⏭️ Report ${reportData.reportId} already exists, skipping`);
        await this.createProcessingLog({
          message,
          attachment,
          status: 'skipped',
          details: `Report ${reportData.reportId} already exists`,
          reportId: existingReport.id,
        });
        result.skipped++;
        result.details.push({
          status: 'skipped',
          message: `Report ${reportData.reportId} already exists`,
          reportId: reportData.reportId,
        });
        return 'skipped';
      }

      // Store the report in database
      const savedReport = await this.storeReport(reportData, records);

      console.log(`✅ Stored report ${savedReport.id} for domain ${reportData.domain}`);
      await this.createProcessingLog({
        message,
        attachment,
        status: 'success',
        details: `Stored report ${savedReport.id} for domain ${reportData.domain}`,
        reportId: savedReport.id,
      });
      result.processed++;
      result.details.push({
        status: 'success',
        message: `Successfully processed report for ${reportData.domain} from ${reportData.orgName}`,
        reportId: savedReport.id,
      });
      return 'success';
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      await this.createProcessingLog({
        message,
        attachment,
        status: 'error',
        details: `DMARC processing failed: ${errorMessage}`,
      });
      throw new Error(`DMARC processing failed: ${error}`);
    }
  }

  private async createProcessingLog(params: {
    message: EmailMessage;
    attachment: EmailAttachment;
    status: 'started' | 'success' | 'skipped' | 'error';
    details?: string;
    reportId?: string;
    forensicReportId?: string;
  }): Promise<void> {
    try {
      await prisma.processingLog.create({
        data: {
          messageUid: params.message.uid,
          attachmentName: params.attachment.filename,
          status: params.status,
          details: params.details,
          reportId: params.reportId,
          forensicReportId: params.forensicReportId,
        },
      });
    } catch (error) {
      console.error('⚠️ Failed to create processing log entry:', error);
    }
  }

  private async storeReport(
    reportData: {
      domain: string;
      reportId: string;
      orgName: string;
      email: string;
      startDate: Date;
      endDate: Date;
    },
    records: Array<{
      sourceIp: string;
      count: number;
      disposition: string;
      dkim: string;
      spf: string;
      headerFrom: string;
    }>
  ) {
    return await prisma.report.create({
      data: {
        domain: reportData.domain,
        reportId: reportData.reportId,
        orgName: reportData.orgName,
        email: reportData.email,
        startDate: reportData.startDate,
        endDate: reportData.endDate,
        records: {
          create: records.map(record => ({
            sourceIp: record.sourceIp,
            count: record.count,
            disposition: record.disposition,
            dkim: record.dkim,
            spf: record.spf,
            headerFrom: record.headerFrom,
          })),
        },
      },
      include: {
        records: true,
      },
    });
  }

  async processBatch(batchSize: number = 10): Promise<ProcessingResult> {
    console.log(`🔄 Starting batch processing (batch size: ${batchSize})...`);
    
    // For now, we'll process all available emails
    // In a production system, you might want to implement actual batching
    return await this.processEmails();
  }

  async scheduleProcessing(intervalMs: number = 300000): Promise<void> {
    const intervalSeconds = Math.round(intervalMs / 1000);
    const nextRun = new Date(Date.now() + intervalMs);

    console.log(`⏰ Scheduling email processing every ${intervalSeconds} seconds`);
    console.log(`🗓️ Next scheduled check at ${nextRun.toISOString()}`);
    recordScheduledRun(intervalMs, nextRun);

    const processInterval = setInterval(async () => {
      try {
        console.log('🔄 Scheduled processing starting...');
        const result = await this.processEmails();

        if (result.processed > 0 || result.forensic > 0 || result.errors > 0) {
          console.log(
            `📊 Scheduled processing completed: ${result.processed} aggregate, ${result.forensic} forensic, ${result.errors} errors`,
          );
        }

        const upcomingRun = new Date(Date.now() + intervalMs);
        console.log(`🗓️ Next scheduled check at ${upcomingRun.toISOString()}`);
      } catch (error) {
        console.error('❌ Scheduled processing failed:', error);
      } finally {
        recordScheduledRun(intervalMs, new Date(Date.now() + intervalMs));
      }
    }, intervalMs);

    // Handle graceful shutdown
    process.on('SIGINT', () => {
      console.log('🛑 Stopping scheduled processing...');
      clearInterval(processInterval);
    });

    process.on('SIGTERM', () => {
      console.log('🛑 Stopping scheduled processing...');
      clearInterval(processInterval);
    });
  }
}