import { ImapClient, EmailMessage, EmailAttachment } from './imapClient.js';
import { DmarcParser } from './dmarcParser.js';
import { prisma } from '../db/prisma.js';
import {
  recordProcessingSuccess,
  recordProcessingFailure,
  recordScheduledRun,
} from './processingStatus.js';

export interface ProcessingResult {
  processed: number;
  errors: number;
  skipped: number;
  details: Array<{
    status: 'success' | 'error' | 'skipped';
    message: string;
    reportId?: string;
  }>;
}

export class EmailProcessor {
  private imapClient: ImapClient;
  private dmarcParser: DmarcParser;

  constructor() {
    this.imapClient = new ImapClient();
    this.dmarcParser = new DmarcParser();
  }

  async processEmails(): Promise<ProcessingResult> {
    const result: ProcessingResult = {
      processed: 0,
      errors: 0,
      skipped: 0,
      details: [],
    };

    try {
      console.log('🚀 Starting email processing service...');

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
      console.log(`📊 Results: ${result.processed} processed, ${result.errors} errors, ${result.skipped} skipped`);

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

  private async processMessage(message: EmailMessage, result: ProcessingResult): Promise<boolean> {
    console.log(`🔄 Processing message from ${message.from} - ${message.subject}`);

    let hasSuccessfulAttachment = false;

    // Process each attachment
    for (const attachment of message.attachments) {
      try {
        const attachmentResult = await this.processAttachment(attachment, message, result);
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
  }): Promise<void> {
    try {
      await prisma.processingLog.create({
        data: {
          messageUid: params.message.uid,
          attachmentName: params.attachment.filename,
          status: params.status,
          details: params.details,
          reportId: params.reportId,
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

        if (result.processed > 0 || result.errors > 0) {
          console.log(`📊 Scheduled processing completed: ${result.processed} processed, ${result.errors} errors`);
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