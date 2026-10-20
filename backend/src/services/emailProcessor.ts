import { ImapClient, EmailMessage, EmailAttachment } from './imapClient.js';
import { DmarcParser, type RecordDbData, type ReportDbData } from './dmarcParser.js';
import { RufParser } from './rufParser.js';
import { TlsRptParser } from './tlsRptParser.js';
import { prisma } from '../db/prisma.js';
import { getBooleanSetting } from './settings.js';
import { resolveMailboxConfig, type MailboxConfig } from './mailboxConfig.js';
import { claimOrCheckDomain } from './domainOwnership.js';
import { getDefaultOrganizationId } from './orgMailboxes.js';
import {
  recordProcessingSuccess,
  recordProcessingFailure,
  recordScheduledRun,
  setMailboxConfigured,
} from './processingStatus.js';

/** Logged once per unconfigured spell rather than on every cycle. */
let warnedAboutMailbox = false;

/**
 * Where a run's rows belong: the organisation that owns the mailbox and, when the mailbox is a
 * real `OrgMailbox` row, its id. `mailboxId: null` is either the legacy environment/settings
 * mailbox or a manual reparse - both are attributed to the Default organisation so their rows
 * do not disappear behind the tenant scope.
 */
export interface IngestContext {
  orgId: string | null;
  mailboxId: string | null;
  /** Human label for log lines; never credentials. */
  label?: string;
  /** Required by `processMailbox`, optional elsewhere (a reparse resolves it itself). */
  config?: MailboxConfig | null;
}

export type ProcessingDetailStatus = 'success' | 'error' | 'skipped' | 'quarantined';

export interface ProcessingResult {
  processed: number;
  forensic: number;
  tlsRpt: number;
  errors: number;
  skipped: number;
  /** Reports understood but withheld because another organisation owns the domain. */
  quarantined: number;
  details: Array<{
    status: ProcessingDetailStatus;
    message: string;
    reportId?: string;
    forensicReportId?: string;
  }>;
}

function emptyResult(): ProcessingResult {
  return {
    processed: 0,
    forensic: 0,
    tlsRpt: 0,
    errors: 0,
    skipped: 0,
    quarantined: 0,
    details: [],
  };
}

/** Network mailboxes render senders as `Name <addr>`; we only want the address. */
function extractEmailAddress(from: string): string | null {
  const match = from.match(/<([^>]+)>/);
  const address = (match ? match[1] : from).trim();
  return address.length > 0 ? address : null;
}

export class EmailProcessor {
  private dmarcParser: DmarcParser;
  private rufParser: RufParser;
  /**
   * The context the current run stamps onto every row it writes. A field rather than a
   * parameter because the parsers are called several layers down; safe because ingestion is
   * sequential (one mailbox at a time) and it is cleared in `finally`.
   */
  private context: IngestContext | null = null;

  constructor() {
    this.dmarcParser = new DmarcParser();
    this.rufParser = new RufParser();
  }

  /**
   * Legacy entry point: the environment/settings mailbox, ingested as the Default organisation.
   * Kept for the CLI (`process-emails`), the manual batch helpers and anything that predates
   * per-organisation mailboxes.
   */
  async processEmails(): Promise<ProcessingResult> {
    // Without a mailbox there is nothing to fetch. This is a normal state on a fresh
    // deployment - the UI is up and an administrator still has to fill the settings in - so
    // it is reported as "not configured" rather than as a failure.
    const mailbox = await resolveMailboxConfig();
    setMailboxConfigured(mailbox.configured);

    if (!mailbox.configured || !mailbox.config) {
      if (!warnedAboutMailbox) {
        console.log(`📭 ${mailbox.summary} - set it under Administration → Settings`);
        warnedAboutMailbox = true;
      }
      const result = emptyResult();
      recordProcessingSuccess(result);
      return result;
    }
    warnedAboutMailbox = false;

    return this.processMailbox({
      orgId: await getDefaultOrganizationId(),
      mailboxId: null,
      label: 'Legacy settings',
      config: mailbox.config,
    });
  }

  /**
   * Ingests one mailbox. The caller passes the already-resolved configuration, so the same code
   * serves an organisation's `OrgMailbox` row and the virtual legacy mailbox, and no credentials
   * are re-read (or logged) between choosing a mailbox and connecting to it.
   *
   * `recordStatus: false` is for the scheduler, which aggregates several mailboxes into one
   * cycle verdict; a single manual run records its own outcome.
   */
  async processMailbox(
    context: IngestContext,
    options: { recordStatus?: boolean } = {},
  ): Promise<ProcessingResult> {
    const config = context.config;
    if (!config) {
      throw new Error('processMailbox requires a mailbox configuration');
    }

    const recordStatus = options.recordStatus ?? true;
    const result = emptyResult();
    const label = context.label ?? context.mailboxId ?? 'mailbox';
    // A fresh client per run: the credentials differ per mailbox, and an instance that was
    // created for mailbox A would keep A's host after the loop moved on.
    const imap = new ImapClient();

    this.context = context;

    try {
      console.log(`🚀 Starting email processing for ${label}...`);
      await this.fetchAndStore(imap, config, context, result);
      if (recordStatus) {
        recordProcessingSuccess(result);
      }
      return result;
    } catch (error) {
      console.error(`❌ Email processing failed for ${label}:`, error);
      if (recordStatus) {
        recordProcessingFailure(error);
      }
      throw error;
    } finally {
      this.context = null;
      try {
        await imap.disconnect();
      } catch (error) {
        console.error('⚠️ Failed to disconnect IMAP client:', error);
      }
    }
  }

  /** Connect, fetch, store, archive. Throws on anything fatal; the caller records the outcome. */
  private async fetchAndStore(
    imap: ImapClient,
    config: MailboxConfig,
    context: IngestContext,
    result: ProcessingResult,
  ): Promise<void> {
    // Check if this is the first run for this mailbox (no rows stored through it yet). A
    // deployment that already ingested keeps its incremental behaviour; a newly added
    // organisation mailbox imports everything once, read or unread, and archives it.
    const isFirstRun = await this.isFirstRun(context);

    if (isFirstRun) {
      console.log('📊 No reports stored through this mailbox yet - performing an initial import of all DMARC reports');
    }

    // Connect to IMAP server
    await imap.connectWithRetry(config);

    // Fetch emails with DMARC attachments
    const messages = await imap.processEmails(isFirstRun);

    if (messages.length === 0) {
      console.log('📭 No DMARC reports to process');
      return;
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
      await imap.markProcessedMessagesAsRead(successfullyProcessedUids);
      console.log(`📁 Attempting to archive ${successfullyProcessedUids.length} processed messages`);
      await imap.moveMessagesToArchive(successfullyProcessedUids);
    } else {
      console.log('📭 No messages were successfully processed, nothing to mark as read');
    }

    console.log('✅ Email processing completed');
    console.log(
      `📊 Results: ${result.processed} aggregate, ${result.forensic} forensic, ${result.tlsRpt} TLS-RPT, ${result.errors} errors, ${result.skipped} skipped, ${result.quarantined} quarantined`,
    );
  }

  /** True until this mailbox has stored an aggregate report. */
  private async isFirstRun(context: IngestContext): Promise<boolean> {
    const count = await prisma.report.count({
      where: {
        orgId: context.orgId ?? null,
        mailboxId: context.mailboxId ?? null,
      },
    });
    return count === 0;
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
   *
   * Rows written by a reparse are attributed to the Default organisation (no mailbox row), or
   * to nothing when no organisation exists yet - otherwise they would be invisible to every
   * scoped reader.
   */
  async reparseArchivedMessages(mailbox: string = 'dmarc-archive'): Promise<ProcessingResult> {
    const result = emptyResult();
    const imap = new ImapClient();

    console.log(`🔄 Reparsing the ${mailbox} mailbox (read-only: no flags changed, nothing moved)`);

    this.context = {
      orgId: await getDefaultOrganizationId(),
      mailboxId: null,
      label: mailbox,
    };

    try {
      await imap.connectWithRetry();
      const messages = await imap.fetchAllFromMailbox(mailbox);
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
      this.context = null;
      try {
        await imap.disconnect();
      } catch (error) {
        console.warn('⚠️ Failed to disconnect IMAP client:', error);
      }
    }

    console.log(
      `📊 Reparse finished: ${result.processed} new aggregate, ${result.forensic} new forensic, ${result.skipped} already stored, ${result.quarantined} quarantined, ${result.errors} errors`,
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

      // Ownership first: a report about another organisation's domain is evidence we must not
      // keep (and must not silently drop either), so it is quarantined with a log entry.
      const claim = await claimOrCheckDomain(this.context?.orgId ?? null, reportData.domain);
      if (!claim.ok) {
        const details = `Quarantined forensic report for ${claim.domain}: another organisation owns that domain`;
        console.warn(`🔒 ${details} (${attachment.filename})`);
        await this.createProcessingLog({ message, attachment, status: 'quarantined', details });
        result.quarantined++;
        result.details.push({ status: 'quarantined', message: details });
        return 'skipped';
      }

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
        data: {
          ...this.rufParser.transformToDbFormat(reportData, message.uid),
          ...this.tenantColumns(),
        },
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
   *
   * Ownership is checked per *policy domain*, because one report can cover several domains and
   * only some of them may belong to the ingesting organisation.
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
      let quarantined = 0;
      const quarantinedDomains: string[] = [];

      for (const entry of entries) {
        const claim = await claimOrCheckDomain(this.context?.orgId ?? null, entry.policyDomain);
        if (!claim.ok) {
          quarantined++;
          if (!quarantinedDomains.includes(claim.domain)) {
            quarantinedDomains.push(claim.domain);
          }
          continue;
        }

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
            ...this.tenantColumns(),
          },
        });
        stored++;
      }

      const failures = entries.reduce((sum, entry) => sum + entry.failureCount, 0);
      console.log(
        `✅ TLS-RPT ${attachment.filename}: ${stored} policy entr(ies) stored, ${duplicates} duplicate(s), ${quarantined} quarantined, ${failures} failed session(s)`,
      );

      if (quarantined > 0) {
        const details =
          `Quarantined ${quarantined} TLS-RPT policy entr(ies) for ${quarantinedDomains.join(', ')}: ` +
          `another organisation owns that domain`;
        console.warn(`🔒 ${details} (${attachment.filename})`);
        await this.createProcessingLog({ message, attachment, status: 'quarantined', details });
        result.quarantined += quarantined;
        result.details.push({ status: 'quarantined', message: details });
      }

      if (stored > 0 || duplicates > 0) {
        await this.createProcessingLog({
          message,
          attachment,
          status: stored > 0 ? 'success' : 'skipped',
          details:
            stored > 0
              ? `Stored ${stored} TLS-RPT policy entr(ies)${failures > 0 ? `, ${failures} failed session(s)` : ''}`
              : `TLS-RPT already stored (${duplicates} duplicate entr(ies))`,
        });
      }

      if (stored > 0) {
        result.tlsRpt++;
      } else if (quarantined === 0) {
        result.skipped++;
      }

      if (stored > 0) {
        result.details.push({
          status: 'success',
          message: `Stored TLS-RPT report for ${entries.map((e) => e.policyDomain).join(', ')}`,
        });
      } else if (quarantined === 0) {
        result.details.push({
          status: 'skipped',
          message: `TLS-RPT report already stored (${attachment.filename})`,
        });
      }

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

      // Ownership before storage: a report for a domain owned by another organisation is
      // quarantined, so neither tenant reads the other's data. Doing this before the dedup
      // lookup also means the collision is logged instead of looking like a duplicate.
      const claim = await claimOrCheckDomain(this.context?.orgId ?? null, reportData.domain);
      if (!claim.ok) {
        const details = `Quarantined aggregate report for ${claim.domain}: another organisation owns that domain`;
        console.warn(`🔒 ${details} (${attachment.filename})`);
        await this.createProcessingLog({ message, attachment, status: 'quarantined', details });
        result.quarantined++;
        result.details.push({ status: 'quarantined', message: details });
        return 'skipped';
      }

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

  /** The tenant columns every row written by this run carries. */
  private tenantColumns(): { orgId: string | null; mailboxId: string | null } {
    return {
      orgId: this.context?.orgId ?? null,
      mailboxId: this.context?.mailboxId ?? null,
    };
  }

  private async createProcessingLog(params: {
    message: EmailMessage;
    attachment: EmailAttachment;
    status: 'started' | 'success' | 'skipped' | 'error' | 'quarantined';
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
          ...this.tenantColumns(),
        },
      });
    } catch (error) {
      console.error('⚠️ Failed to create processing log entry:', error);
    }
  }

  /**
   * Public so a test can drive the write path without an IMAP server: the parser output is the
   * only input, and what lands in the database is the thing worth asserting on.
   *
   * `context` overrides the run's context, so the tenant stamping is testable on its own.
   */
  async storeReport(
    reportData: ReportDbData,
    records: RecordDbData[],
    context?: IngestContext | null,
  ) {
    const tenant =
      context === undefined
        ? this.tenantColumns()
        : { orgId: context?.orgId ?? null, mailboxId: context?.mailboxId ?? null };

    return await prisma.report.create({
      data: {
        domain: reportData.domain,
        reportId: reportData.reportId,
        orgName: reportData.orgName,
        email: reportData.email,
        startDate: reportData.startDate,
        endDate: reportData.endDate,
        // The published policy is stored rather than dropped: it is the only record of what
        // receivers were told to do, and it cannot be recomputed from the verdicts.
        policyP: reportData.policyP,
        policySp: reportData.policySp,
        policyPct: reportData.policyPct,
        policyAdkim: reportData.policyAdkim,
        policyAspf: reportData.policyAspf,
        ...tenant,
        records: {
          create: records.map(record => ({
            sourceIp: record.sourceIp,
            count: record.count,
            disposition: record.disposition,
            dkim: record.dkim,
            spf: record.spf,
            headerFrom: record.headerFrom,
            // JSON text: SQLite has no array column here, and the lists are short.
            dkimAuth: JSON.stringify(record.dkimAuth ?? []),
            spfAuth: JSON.stringify(record.spfAuth ?? []),
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

  /**
   * The interval loop. `runCycle` is supplied by the scheduler in `index.ts`, which processes
   * every organisation mailbox sequentially; without it this falls back to the legacy
   * single-mailbox path so existing callers keep working.
   */
  async scheduleProcessing(
    intervalMs: number = 300000,
    runCycle?: () => Promise<ProcessingResult>,
  ): Promise<void> {
    const intervalSeconds = Math.round(intervalMs / 1000);
    const nextRun = new Date(Date.now() + intervalMs);
    const cycle = runCycle ?? (() => this.processEmails());

    console.log(`⏰ Scheduling email processing every ${intervalSeconds} seconds`);
    console.log(`🗓️ Next scheduled check at ${nextRun.toISOString()}`);
    recordScheduledRun(intervalMs, nextRun);

    const processInterval = setInterval(async () => {
      try {
        console.log('🔄 Scheduled processing starting...');
        const result = await cycle();

        if (
          result.processed > 0 ||
          result.forensic > 0 ||
          result.tlsRpt > 0 ||
          result.errors > 0 ||
          result.quarantined > 0
        ) {
          console.log(
            `📊 Scheduled processing completed: ${result.processed} aggregate, ${result.forensic} forensic, ${result.tlsRpt} TLS-RPT, ${result.errors} errors, ${result.quarantined} quarantined`,
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
