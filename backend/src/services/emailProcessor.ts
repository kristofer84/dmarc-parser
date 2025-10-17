import { ImapClient, EmailMessage } from './imapClient.js';
import { DmarcParser } from './dmarcParser.js';
import { prisma } from '../db/prisma.js';

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

      // Connect to IMAP server
      await this.imapClient.connectWithRetry();
      
      // Fetch emails with DMARC attachments
      const messages = await this.imapClient.processEmails();
      
      if (messages.length === 0) {
        console.log('📭 No new DMARC reports to process');
        return result;
      }

      console.log(`📬 Processing ${messages.length} DMARC reports...`);

      // Process each message
      for (const message of messages) {
        try {
          await this.processMessage(message, result);
        } catch (error) {
          console.error(`❌ Failed to process message ${message.uid}:`, error);
          result.errors++;
          result.details.push({
            status: 'error',
            message: `Failed to process message ${message.uid}: ${error}`,
          });
        }
      }

      console.log('✅ Email processing completed');
      console.log(`📊 Results: ${result.processed} processed, ${result.errors} errors, ${result.skipped} skipped`);

      return result;

    } catch (error) {
      console.error('❌ Email processing service failed:', error);
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

  private async processMessage(message: EmailMessage, result: ProcessingResult): Promise<void> {
    console.log(`🔄 Processing message from ${message.from} - ${message.subject}`);

    // Process each attachment
    for (const attachment of message.attachments) {
      try {
        await this.processAttachment(attachment.content, message, result);
      } catch (error) {
        console.error(`❌ Failed to process attachment ${attachment.filename}:`, error);
        result.errors++;
        result.details.push({
          status: 'error',
          message: `Failed to process attachment ${attachment.filename}: ${error}`,
        });
      }
    }
  }

  private async processAttachment(xmlContent: Buffer, message: EmailMessage, result: ProcessingResult): Promise<void> {
    try {
      // Parse and validate the DMARC report
      const { reportData, records } = await this.dmarcParser.parseAndValidate(xmlContent);

      // Check if report already exists
      const existingReport = await prisma.report.findUnique({
        where: { reportId: reportData.reportId },
      });

      if (existingReport) {
        console.log(`⏭️ Report ${reportData.reportId} already exists, skipping`);
        result.skipped++;
        result.details.push({
          status: 'skipped',
          message: `Report ${reportData.reportId} already exists`,
          reportId: reportData.reportId,
        });
        return;
      }

      // Store the report in database
      const savedReport = await this.storeReport(reportData, records);

      console.log(`✅ Stored report ${savedReport.id} for domain ${reportData.domain}`);
      result.processed++;
      result.details.push({
        status: 'success',
        message: `Successfully processed report for ${reportData.domain} from ${reportData.orgName}`,
        reportId: savedReport.id,
      });

    } catch (error) {
      throw new Error(`DMARC processing failed: ${error}`);
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
    console.log(`⏰ Scheduling email processing every ${intervalMs / 1000} seconds`);
    
    const processInterval = setInterval(async () => {
      try {
        console.log('🔄 Scheduled processing starting...');
        const result = await this.processEmails();
        
        if (result.processed > 0 || result.errors > 0) {
          console.log(`📊 Scheduled processing completed: ${result.processed} processed, ${result.errors} errors`);
        }
      } catch (error) {
        console.error('❌ Scheduled processing failed:', error);
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