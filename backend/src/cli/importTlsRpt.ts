#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { setupLogging } from '../utils/logger.js';
import { TlsRptParser } from '../services/tlsRptParser.js';
import { connectDatabase, disconnectDatabase, prisma } from '../db/prisma.js';

/**
 * Imports TLS-RPT report files that did not arrive by mail.
 *
 * TLS-RPT is published with two `rua` URIs: the mailbox this app reads, and an HTTPS collector
 * that keeps raw reports on the mail host (`/var/lib/tlsrpt/reports/`). The HTTPS path exists
 * so reports still arrive when mail to the MX is the thing that is broken - which is exactly
 * when the mailbox also cannot deliver them.
 *
 * This CLI is how those stored reports get in, and it is deliberately a *pull* driven from
 * outside the container: the SSH key for the mail host stays on the Pi, never in the app.
 * `home/scripts/tlsrpt-sync.sh` rsyncs new files here and calls this.
 *
 *   node dist/cli/importTlsRpt.js /var/spool/tlsrpt/incoming/*.json.gz
 *   node dist/cli/importTlsRpt.js --stdin < report.json.gz
 *
 * Dedup (report-id + policy domain + MX) makes re-importing the same file harmless, so a failed
 * sync run can simply be repeated.
 */

setupLogging();

function readInputs(): Buffer[] {
  const args = process.argv.slice(2);

  if (args.includes('--stdin')) {
    const stdin = readFileSync(0);
    return stdin.length > 0 ? [stdin] : [];
  }

  const files = args.filter((arg) => !arg.startsWith('--'));
  if (files.length === 0) {
    throw new Error('usage: importTlsRpt <file...> | --stdin');
  }

  return files.map((file) => readFileSync(file));
}

async function main(): Promise<void> {
  let stored = 0;
  let duplicates = 0;
  let failed = 0;

  const inputs = readInputs();
  if (inputs.length === 0) {
    console.log('nothing to import');
    await disconnectDatabase();
    return;
  }

  await connectDatabase();

  for (const content of inputs) {
    let entries;
    try {
      entries = TlsRptParser.parse(content, { filename: 'import' });
    } catch (error) {
      failed++;
      console.error(`❌ ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }

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
      console.log(
        `✅ ${entry.policyDomain} ${entry.dateBegin.toISOString().slice(0, 10)} ` +
          `ok=${entry.successfulCount} fail=${entry.failureCount}`,
      );
    }
  }

  console.log(`\nimported ${stored}, already present ${duplicates}, unreadable ${failed}`);
  await disconnectDatabase();

  // A file that could not be parsed is worth a non-zero exit so the caller keeps it and someone
  // looks; duplicates are the normal case and must not look like a failure.
  if (failed > 0) {
    process.exit(1);
  }
}

void main().catch(async (error) => {
  console.error('❌ TLS-RPT import failed:', error);
  await disconnectDatabase().catch(() => {});
  process.exit(1);
});
