import { createHash } from 'node:crypto';
import { simpleParser } from 'mailparser';

/**
 * DMARC forensic (RUF) report parser.
 *
 * Forensic reports are per-message authentication failures in the ARF format
 * (RFC 5965) with DMARC-specific fields (RFC 7489 section 7.2). They arrive as a
 * mail whose `message/feedback-report` part holds `Key: value` fields, optionally
 * with the failing message attached as `message/rfc822`.
 *
 * Three shapes occur in the wild and all three are handled:
 *   1. multipart/report with a `message/feedback-report` part (conformant),
 *   2. the same, plus the failing message inline as `message/rfc822`,
 *   3. no feedback-report part at all - the fields sit in the top-level text/plain
 *      body (non-conformant, seen from smaller reporters).
 *
 * Nothing here trusts the input: the ruf= mailbox accepts mail from anyone, so the
 * parser only validates shape and records whether the enclosing mail authenticated.
 */

export interface ReportedMessage {
  from: string | null;
  to: string | null;
  subject: string | null;
  date: Date | null;
  messageId: string | null;
  /** Raw header block of the reported message (gated by forensics.storeFullHeaders). */
  headerBlock: string | null;
  /** Plain-text body of the reported message (gated by forensics.storeReportedMessage). */
  body: string | null;
}

export interface ForensicReportData {
  dedupKey: string;
  feedbackType: string;
  reportVersion: string | null;
  userAgent: string | null;
  /** The domain the report is about. */
  domain: string;
  reportedDomain: string | null;
  reportingMta: string | null;
  /** Reporting organisation, derived from the report mail's From domain. */
  reporter: string | null;
  reporterEmail: string | null;
  sourceIp: string | null;
  arrivalDate: Date | null;
  originalMailFrom: string | null;
  originalRcptTo: string | null;
  originalEnvelopeId: string | null;
  incidents: string | null;
  authResults: string | null;
  spfResult: string | null;
  dkimResult: string | null;
  dmarcResult: string | null;
  dkimDomain: string | null;
  dkimIdentity: string | null;
  dkimSelector: string | null;
  identityAlignment: string | null;
  rawFeedback: string | null;
  reported: ReportedMessage | null;
  reportMessageId: string | null;
  reportAuthenticated: boolean;
  reportAuthDetail: string | null;
}

export interface RufParseContext {
  /** The attached message/rfc822 the failure is about, when the reporter sent one. */
  reportedMessageRaw?: Buffer | null;
  /** Message-ID of the mail the report arrived in. */
  reportMessageId?: string | null;
  /** From address of the mail the report arrived in. */
  reporterEmail?: string | null;
  /** Authentication-Results header of the enclosing mail, when present. */
  reportAuthenticationResults?: string | null;
  storeRawFeedback?: boolean;
  storeFullHeaders?: boolean;
  storeReportedMessage?: boolean;
  /** Hard cap on stored reported-message body size. */
  maxStoredBodyBytes?: number;
}

const DEFAULT_MAX_BODY_BYTES = 64 * 1024;

/** Markers that must appear (at least two) before a body is treated as a feedback report. */
const FEEDBACK_MARKERS = [
  'Original-Mail-From',
  'Original-Rcpt-To',
  'Original-Envelope-Id',
  'Arrival-Date',
  'Source-IP',
  'Reported-Domain',
  'Reporting-MTA',
  'Authentication-Results',
  'DKIM-Domain',
];

function firstValue(fields: Map<string, string[]>, key: string): string | null {
  const values = fields.get(key.toLowerCase());
  if (!values || values.length === 0) {
    return null;
  }
  const value = values[0].trim();
  return value.length > 0 ? value : null;
}

function allValues(fields: Map<string, string[]>, key: string): string[] {
  return (fields.get(key.toLowerCase()) ?? []).map((v) => v.trim()).filter((v) => v.length > 0);
}

/** Strips the angle brackets ARF puts around addresses. */
function unwrapAddress(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const match = value.match(/<([^>]+)>/);
  return (match ? match[1] : value).trim() || null;
}

function domainOf(address: string | null): string | null {
  if (!address) {
    return null;
  }
  const at = address.lastIndexOf('@');
  if (at === -1 || at === address.length - 1) {
    return null;
  }
  return address.slice(at + 1).trim().toLowerCase() || null;
}

/** Arrival-Date is RFC 2822; unparsable values are dropped rather than invented. */
function parseDate(value: string | null): Date | null {
  if (!value) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function truncate(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) {
    return value;
  }
  const cut = Buffer.from(value, 'utf8').subarray(0, maxBytes).toString('utf8');
  return `${cut}\n\n[... truncated at ${maxBytes} bytes ...]`;
}

export class RufParser {
  /**
   * Parses `Key: value` lines, unfolding RFC 5322 continuation lines (which ARF
   * reporters do use - Authentication-Results is routinely wrapped).
   */
  static parseFields(text: string): Map<string, string[]> {
    const fields = new Map<string, string[]>();
    let lastKey: string | null = null;

    for (const rawLine of text.split(/\r?\n/)) {
      if (/^[ \t]/.test(rawLine) && lastKey) {
        const values = fields.get(lastKey);
        if (values && values.length > 0) {
          values[values.length - 1] = `${values[values.length - 1]} ${rawLine.trim()}`.trim();
        }
        continue;
      }

      const match = rawLine.match(/^([A-Za-z][A-Za-z0-9-]*):[ \t]*(.*)$/);
      if (!match) {
        lastKey = null;
        continue;
      }

      const key = match[1].toLowerCase();
      const value = match[2].trim();
      const existing = fields.get(key) ?? [];
      existing.push(value);
      fields.set(key, existing);
      lastKey = key;
    }

    return fields;
  }

  /**
   * True when the text is shaped like an ARF/DMARC failure report. Requires a
   * Feedback-Type field plus two other markers, so a mail merely *quoting* a report
   * does not match.
   */
  static looksLikeFeedbackReport(text: string | null | undefined): boolean {
    if (!text) {
      return false;
    }
    if (!/^[ \t]*Feedback-Type:/im.test(text)) {
      return false;
    }
    const markers = FEEDBACK_MARKERS.filter((marker) =>
      new RegExp(`^[ \t]*${marker}:`, 'im').test(text),
    );
    return markers.length >= 2;
  }

  static buildDedupKey(input: {
    reportMessageId?: string | null;
    domain: string;
    sourceIp: string | null;
    arrivalDate: Date | null;
    originalMailFrom: string | null;
    originalRcptTo: string | null;
    dkimSelector: string | null;
    reporter: string | null;
  }): string {
    if (input.reportMessageId && input.reportMessageId.trim().length > 0) {
      return `msgid:${input.reportMessageId.replace(/[<>\s]/g, '').toLowerCase()}`;
    }

    const parts = [
      input.domain,
      input.sourceIp ?? '',
      input.arrivalDate ? input.arrivalDate.toISOString() : '',
      input.originalMailFrom ?? '',
      input.originalRcptTo ?? '',
      input.dkimSelector ?? '',
      input.reporter ?? '',
    ];
    return `hash:${createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 32)}`;
  }

  /**
   * Summarises one mechanism's result out of an Authentication-Results header.
   * A single failure dominates, so `dkim=fail ... dkim=pass` reads as `fail`.
   */
  private extractAuthResult(raw: string | null, mechanism: 'spf' | 'dkim' | 'dmarc'): string | null {
    if (!raw) {
      return null;
    }

    const matches = [...raw.matchAll(new RegExp(`(?:^|[;,\\s])${mechanism}=([a-zA-Z]+)`, 'gi'))].map(
      (m) => m[1].toLowerCase(),
    );

    if (matches.length === 0) {
      return null;
    }
    if (matches.includes('fail')) {
      return 'fail';
    }
    if (matches.includes('pass')) {
      return 'pass';
    }
    return matches[0];
  }

  /**
   * Authentication-Results may only carry a verified `dkim=`/`dmarc=` verdict when the
   * receiving MTA added it; without the header the report is unverified.
   */
  private assessReportAuthenticity(authResultsHeader: string | null | undefined): {
    authenticated: boolean;
    detail: string | null;
  } {
    if (!authResultsHeader || authResultsHeader.trim().length === 0) {
      return {
        authenticated: false,
        detail: 'no Authentication-Results header on the report mail (unverified sender)',
      };
    }

    const verdict = authResultsHeader.trim();
    const passed = /(?:^|[;,\s])(?:dkim|dmarc)=pass/i.test(verdict);
    return {
      authenticated: passed,
      detail: passed
        ? `report mail authenticated: ${verdict.slice(0, 500)}`
        : `report mail did not authenticate: ${verdict.slice(0, 500)}`,
    };
  }

  /** Header block = everything before the first empty line. */
  private extractHeaderBlock(raw: Buffer): string {
    const text = raw.toString('utf8');
    const separator = text.search(/\r?\n\r?\n/);
    return (separator === -1 ? text : text.slice(0, separator)).trim();
  }

  private parseHeaderBlockFallback(headerBlock: string): Map<string, string> {
    const headers = new Map<string, string>();
    let lastKey: string | null = null;

    for (const line of headerBlock.split(/\r?\n/)) {
      if (/^[ \t]/.test(line) && lastKey) {
        headers.set(lastKey, `${headers.get(lastKey)} ${line.trim()}`.trim());
        continue;
      }
      const match = line.match(/^([^:]+):[ \t]*(.*)$/);
      if (!match) {
        continue;
      }
      lastKey = match[1].trim().toLowerCase();
      headers.set(lastKey, match[2].trim());
    }

    return headers;
  }

  private async parseReportedMessage(
    raw: Buffer | null | undefined,
    context: RufParseContext,
  ): Promise<ReportedMessage | null> {
    if (!raw || raw.length === 0) {
      return null;
    }

    const maxBodyBytes = context.maxStoredBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    const headerBlock = this.extractHeaderBlock(raw);

    try {
      const parsed = await simpleParser(raw);
      const text = typeof parsed.text === 'string' ? parsed.text : '';
      return {
        from: parsed.from?.text ?? null,
        to: parsed.to
          ? Array.isArray(parsed.to)
            ? parsed.to.map((t) => t.text).join(', ')
            : parsed.to.text
          : null,
        subject: parsed.subject ?? null,
        date: parsed.date instanceof Date ? parsed.date : null,
        messageId: parsed.messageId ?? null,
        headerBlock: context.storeFullHeaders ? headerBlock : null,
        body: context.storeReportedMessage && text.length > 0 ? truncate(text, maxBodyBytes) : null,
      };
    } catch (error) {
      // Attacker-controlled input: fall back to a plain header scan rather than failing.
      console.warn('⚠️ Reported message could not be parsed with mailparser, using fallback:', error);
      const headers = this.parseHeaderBlockFallback(headerBlock);
      return {
        from: headers.get('from') ?? null,
        to: headers.get('to') ?? null,
        subject: headers.get('subject') ?? null,
        date: parseDate(headers.get('date') ?? null),
        messageId: headers.get('message-id') ?? null,
        headerBlock: context.storeFullHeaders ? headerBlock : null,
        body: null,
      };
    }
  }

  async parse(feedbackText: string, context: RufParseContext = {}): Promise<ForensicReportData> {
    if (!RufParser.looksLikeFeedbackReport(feedbackText)) {
      throw new Error('Input does not look like a DMARC forensic (auth-failure) report');
    }

    const fields = RufParser.parseFields(feedbackText);

    const feedbackType = firstValue(fields, 'feedback-type') ?? 'auth-failure';
    const reportedDomain = firstValue(fields, 'reported-domain');
    const originalMailFrom = unwrapAddress(firstValue(fields, 'original-mail-from'));
    const originalRcptTo = unwrapAddress(firstValue(fields, 'original-rcpt-to'));
    const dkimDomain = firstValue(fields, 'dkim-domain');

    // Reported-Domain is optional per RFC 7489 but is what we group on; fall back to
    // the forged envelope/header domain, which is what the receiver actually evaluated.
    const domain =
      reportedDomain ?? domainOf(originalMailFrom) ?? dkimDomain ?? domainOf(originalRcptTo);

    if (!domain) {
      throw new Error(
        'Forensic report has no Reported-Domain and no Original-Mail-From to derive one from',
      );
    }

    const authResults = allValues(fields, 'authentication-results').join('; ') || null;
    const reporterEmail = context.reporterEmail ?? null;
    const authenticity = this.assessReportAuthenticity(context.reportAuthenticationResults);

    const arrivalDate = parseDate(firstValue(fields, 'arrival-date'));
    const reportingMta = firstValue(fields, 'reporting-mta');
    const reporter =
      domainOf(reporterEmail) ?? (reportingMta ? reportingMta.split(';').pop()?.trim() ?? null : null);

    const data: ForensicReportData = {
      dedupKey: '',
      feedbackType,
      reportVersion: firstValue(fields, 'version'),
      userAgent: firstValue(fields, 'user-agent'),
      domain: domain.toLowerCase(),
      reportedDomain: reportedDomain ? reportedDomain.toLowerCase() : null,
      reportingMta,
      reporter,
      reporterEmail,
      sourceIp: firstValue(fields, 'source-ip'),
      arrivalDate,
      originalMailFrom,
      originalRcptTo,
      originalEnvelopeId: firstValue(fields, 'original-envelope-id'),
      incidents: firstValue(fields, 'incidents'),
      authResults,
      spfResult: this.extractAuthResult(authResults, 'spf'),
      dkimResult: this.extractAuthResult(authResults, 'dkim'),
      dmarcResult: this.extractAuthResult(authResults, 'dmarc'),
      dkimDomain,
      dkimIdentity: firstValue(fields, 'dkim-identity'),
      dkimSelector: firstValue(fields, 'dkim-selector'),
      identityAlignment: firstValue(fields, 'identity-alignment'),
      // DKIM-Canonicalized-* values can be whole message bodies, so the raw block is opt-in.
      rawFeedback: context.storeRawFeedback ? truncate(feedbackText.trim(), DEFAULT_MAX_BODY_BYTES) : null,
      reported: await this.parseReportedMessage(context.reportedMessageRaw, context),
      reportMessageId: context.reportMessageId ?? null,
      reportAuthenticated: authenticity.authenticated,
      reportAuthDetail: authenticity.detail,
    };

    data.dedupKey = RufParser.buildDedupKey({
      reportMessageId: data.reportMessageId,
      domain: data.domain,
      sourceIp: data.sourceIp,
      arrivalDate: data.arrivalDate,
      originalMailFrom: data.originalMailFrom,
      originalRcptTo: data.originalRcptTo,
      dkimSelector: data.dkimSelector,
      reporter: data.reporter,
    });

    return data;
  }

  validate(data: ForensicReportData): void {
    if (!data.feedbackType) {
      throw new Error('Forensic report is missing Feedback-Type');
    }
    if (!data.domain) {
      throw new Error('Forensic report is missing a domain');
    }
    if (data.sourceIp && !/^[0-9a-fA-F:.]{3,45}$/.test(data.sourceIp)) {
      throw new Error(`Forensic report has an implausible Source-IP: ${data.sourceIp}`);
    }
  }

  async parseAndValidate(
    feedbackText: string,
    context: RufParseContext = {},
  ): Promise<ForensicReportData> {
    const data = await this.parse(feedbackText, context);
    this.validate(data);
    return data;
  }

  /** Maps parsed data onto the ForensicReport prisma model. */
  transformToDbFormat(data: ForensicReportData, sourceMessageUid?: number | null) {
    return {
      dedupKey: data.dedupKey,
      domain: data.domain,
      reportedDomain: data.reportedDomain,
      reporter: data.reporter,
      reporterEmail: data.reporterEmail,
      reportingMta: data.reportingMta,
      feedbackType: data.feedbackType,
      reportVersion: data.reportVersion,
      userAgent: data.userAgent,
      arrivalDate: data.arrivalDate,
      sourceIp: data.sourceIp,
      originalMailFrom: data.originalMailFrom,
      originalRcptTo: data.originalRcptTo,
      originalEnvelopeId: data.originalEnvelopeId,
      incidents: data.incidents,
      spfResult: data.spfResult,
      dkimResult: data.dkimResult,
      dmarcResult: data.dmarcResult,
      authResults: data.authResults,
      dkimDomain: data.dkimDomain,
      dkimIdentity: data.dkimIdentity,
      dkimSelector: data.dkimSelector,
      identityAlignment: data.identityAlignment,
      reportedFrom: data.reported?.from ?? null,
      reportedTo: data.reported?.to ?? null,
      reportedSubject: data.reported?.subject ?? null,
      reportedDate: data.reported?.date ?? null,
      reportedMessageId: data.reported?.messageId ?? null,
      reportedHeaders: data.reported?.headerBlock ?? null,
      reportedBody: data.reported?.body ?? null,
      rawFeedback: data.rawFeedback,
      reportAuthenticated: data.reportAuthenticated,
      reportAuthDetail: data.reportAuthDetail,
      sourceMessageId: data.reportMessageId,
      sourceMessageUid: sourceMessageUid ?? null,
    };
  }
}
