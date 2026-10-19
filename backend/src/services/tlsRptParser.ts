import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

/**
 * TLS-RPT (RFC 8460) aggregate reports.
 *
 * These arrive for `_smtp._tls.<domain>` and describe SMTP TLS sessions to the MX: how many
 * succeeded, how many failed, and - in `failure-details` - why (starttls-not-supported,
 * certificate-expired, tlsa-invalid, ...). That is the evidence behind "is it safe to move
 * MTA-STS from testing to enforce", which is why it is stored rather than logged.
 *
 * One report can cover several policy entries (a reporter batches domains), so parsing returns
 * an array. A resend has the same report-id, hence the dedup key.
 */

export interface TlsRptFailureDetail {
  resultType: string;
  count: number;
  sendingMtaIp?: string;
  receivingMxHostname?: string;
  failureReasonCode?: string;
  additionalInformation?: string;
}

export interface TlsRptPolicyEntry {
  dedupKey: string;
  reportId: string | null;
  orgName: string | null;
  contactInfo: string | null;
  dateBegin: Date;
  dateEnd: Date;
  policyDomain: string;
  policyType: string;
  mxHost: string;
  successfulCount: number;
  failureCount: number;
  failureDetails: TlsRptFailureDetail[];
  policyString: string | null;
  raw: string;
}

const MAX_RAW_BYTES = 128 * 1024;

/** gzip magic, or the base64 of it ("H4sI") when a reporter forgot to decode. */
function maybeDecompress(content: Buffer): Buffer {
  if (content.length > 2 && content[0] === 0x1f && content[1] === 0x8b) {
    return gunzipSync(content);
  }

  const head = content.subarray(0, 8).toString('ascii');
  if (head.startsWith('H4sI')) {
    return gunzipSync(Buffer.from(content.toString('utf8').trim(), 'base64'));
  }

  return content;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/**
 * `mx-host` is a JSON array in RFC 8460 and every real report we have seen (Google sends
 * ["mail.xcds.net"]). Reading it with `asString` silently stored "unknown" and put that in the
 * dedup key, so this accepts either shape and joins a multi-host list.
 */
function asHostList(value: unknown): string | null {
  if (Array.isArray(value)) {
    const hosts = value
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    return hosts.length > 0 ? hosts.join(',') : null;
  }
  return asString(value);
}

function asCount(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 0;
}

function asDate(value: unknown, fallback: Date): Date {
  if (typeof value !== 'string') {
    return fallback;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

function parseFailureDetails(list: unknown): TlsRptFailureDetail[] {
  if (!Array.isArray(list)) {
    return [];
  }

  const details: TlsRptFailureDetail[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const record = item as Record<string, unknown>;
    const resultType = asString(record['result-type']);
    if (!resultType) {
      continue;
    }
    details.push({
      resultType,
      count: asCount(record['failed-session-count']),
      ...(asString(record['sending-mta-ip'])
        ? { sendingMtaIp: asString(record['sending-mta-ip']) as string }
        : {}),
      ...(asString(record['receiving-mx-hostname'])
        ? { receivingMxHostname: asString(record['receiving-mx-hostname']) as string }
        : {}),
      ...(asString(record['failure-reason-code'])
        ? { failureReasonCode: asString(record['failure-reason-code']) as string }
        : {}),
      ...(asString(record['additional-information'])
        ? { additionalInformation: asString(record['additional-information']) as string }
        : {}),
    });
  }

  return details;
}

export class TlsRptParser {
  /**
   * Cheap classification, used before the (more expensive) JSON parse: the registered content
   * types, or a .json filename. A DMARC aggregate report is XML inside a zip, so the two
   * cannot collide on the extension.
   */
  static looksLikeTlsRpt(filename: string, contentType: string, content?: Buffer): boolean {
    const type = (contentType || '').toLowerCase();
    const name = (filename || '').toLowerCase();

    if (type.includes('tlsrpt')) {
      return true;
    }
    if (!/\.json(\.gz)?$/.test(name)) {
      return false;
    }
    if (!content || content.length === 0) {
      return true;
    }

    try {
      const text = maybeDecompress(content).subarray(0, 4096).toString('utf8').trimStart();
      return text.startsWith('{') && /"policies"\s*:/.test(text.slice(0, 4096));
    } catch {
      return false;
    }
  }

  /**
   * Parses a report into one entry per policy. Throws with a message that names the file, so
   * an unparseable report becomes a visible error in the processing log rather than a silent
   * skip.
   */
  static parse(content: Buffer, options: { fallbackDate?: Date; filename?: string } = {}): TlsRptPolicyEntry[] {
    const filename = options.filename ?? 'report';
    let report: Record<string, unknown>;

    try {
      report = JSON.parse(maybeDecompress(content).toString('utf8')) as Record<string, unknown>;
    } catch (error) {
      throw new Error(
        `Not a TLS-RPT JSON report (${filename}): ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const policies = report.policies;
    if (!Array.isArray(policies) || policies.length === 0) {
      throw new Error(`TLS-RPT report ${filename} has no policies[] entries`);
    }

    const fallbackDate = options.fallbackDate ?? new Date();
    const range = (report['date-range'] ?? {}) as Record<string, unknown>;
    const dateBegin = asDate(range['start-datetime'], fallbackDate);
    const dateEnd = asDate(range['end-datetime'], fallbackDate);

    const reportId = asString(report['report-id']);
    const orgName = asString(report['organization-name']);
    const contactInfo = asString(report['contact-info']);
    const raw = JSON.stringify(report).slice(0, MAX_RAW_BYTES);

    // Without a report-id there is nothing stable to dedupe on, so fall back to the content -
    // a resend of the same bytes collapses, a genuinely new report does not.
    const contentHash = createHash('sha256').update(content).digest('hex').slice(0, 32);

    return policies.map((entry, index) => {
      const record = (entry ?? {}) as Record<string, unknown>;
      const policy = (record.policy ?? {}) as Record<string, unknown>;
      const summary = (record.summary ?? {}) as Record<string, unknown>;

      const policyDomain = asString(policy['policy-domain']) ?? 'unknown';
      const mxHost = asHostList(policy['mx-host']) ?? 'unknown';
      const policyString = Array.isArray(policy['policy-string'])
        ? JSON.stringify(policy['policy-string'].filter((line): line is string => typeof line === 'string'))
        : asString(policy['policy-string'])
          ? JSON.stringify([asString(policy['policy-string'])])
          : null;

      return {
        dedupKey: `${reportId ?? `hash:${contentHash}`}|${policyDomain}|${mxHost}`,
        reportId,
        orgName,
        contactInfo,
        dateBegin,
        dateEnd,
        policyDomain,
        policyType: asString(policy['policy-type']) ?? 'sts',
        mxHost,
        successfulCount: asCount(summary['total-successful-session-count']),
        failureCount: asCount(summary['total-failure-session-count']),
        failureDetails: parseFailureDetails(record['failure-details']),
        policyString,
        // Keep the raw report once per entry index only when the report is small; the cap is
        // already applied above, so a pathological file cannot bloat the database.
        raw: index === 0 ? raw : raw,
      };
    });
  }
}
