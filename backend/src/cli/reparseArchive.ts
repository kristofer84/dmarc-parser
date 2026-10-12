#!/usr/bin/env node

import { setupLogging } from '../utils/logger.js';
import { EmailProcessor } from '../services/emailProcessor.js';
import { connectDatabase, disconnectDatabase } from '../db/prisma.js';

/**
 * Reparses already-ingested mail out of the archive, without touching the mailbox.
 *
 * Use it after switching on an option that stores more of a report (full headers, the
 * reported body, the raw feedback block) or after fixing the parser: reports that are
 * already in the database are skipped by their dedup key, so running it twice is safe.
 *
 *   docker compose exec backend node dist/cli/reparseArchive.js
 *   docker compose exec backend node dist/cli/reparseArchive.js --mailbox INBOX
 *
 * The mailbox defaults to dmarc-archive, where processed mail is moved.
 */

setupLogging();

function readMailboxArgument(): string {
  const index = process.argv.indexOf('--mailbox');
  if (index === -1) {
    return 'dmarc-archive';
  }

  const value = process.argv[index + 1];
  if (!value) {
    throw new Error('--mailbox needs a mailbox name');
  }
  return value;
}

async function main() {
  const mailbox = readMailboxArgument();

  console.log('🔄 DMARC archive reparse');
  console.log('========================');

  await connectDatabase();

  try {
    const processor = new EmailProcessor();
    const result = await processor.reparseArchivedMessages(mailbox);

    console.log('\n📊 Reparse results:');
    console.log(`   new aggregate reports: ${result.processed}`);
    console.log(`   new forensic reports:  ${result.forensic}`);
    console.log(`   already stored:        ${result.skipped}`);
    console.log(`   errors:                ${result.errors}`);

    if (result.processed === 0 && result.forensic === 0) {
      console.log(
        '\n💡 Nothing new was stored. That means every report in the mailbox is already in\n' +
          '   the database - not that the mailbox is empty. Run with --mailbox INBOX to look\n' +
          '   at mail that has not been ingested yet.',
      );
    }

    process.exit(result.errors > 0 ? 1 : 0);
  } finally {
    await disconnectDatabase();
  }
}

main().catch(async (error) => {
  console.error('❌ Reparse failed:', error);
  await disconnectDatabase().catch(() => undefined);
  process.exit(1);
});
