import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { simpleParser } from 'mailparser';
import { RufParser } from '../src/services/rufParser.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, 'fixtures');

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (error) {
    failed++;
    const message = error instanceof Error ? error.message : String(error);
    console.error(`  ❌ ${name}\n     ${message}`);
  }
}

async function loadFixture(name: string) {
  const raw = readFileSync(join(fixtures, name));
  const parsed = await simpleParser(raw);

  let feedback: string | null = null;
  let reportedMessageRaw: Buffer | null = null;

  for (const attachment of parsed.attachments) {
    if (attachment.contentType === 'message/feedback-report') {
      feedback = attachment.content.toString('utf8');
    }
    if (attachment.contentType === 'message/rfc822') {
      reportedMessageRaw = attachment.content;
    }
  }

  return { raw, parsed, feedback, reportedMessageRaw };
}

const parser = new RufParser();

console.log('\nRUF parser');

await test('conformant report: fields, folded Authentication-Results, embedded message', async () => {
  const { feedback, reportedMessageRaw } = await loadFixture('ruf-microsoft.eml');
  assert.ok(feedback, 'expected a message/feedback-report part');

  const data = await parser.parseAndValidate(feedback, {
    reportedMessageRaw,
    reportMessageId: '<report-1@outlook.com>',
    reporterEmail: 'postmaster@outlook.com',
    reportAuthenticationResults: 'mx.xcds.net; dkim=pass header.d=outlook.com',
  });

  assert.equal(data.feedbackType, 'auth-failure');
  assert.equal(data.userAgent, 'Microsoft-Outlook-Forensics/1.0');
  assert.equal(data.reportVersion, '1');
  assert.equal(data.domain, 'xcds.net');
  assert.equal(data.reportedDomain, 'xcds.net');
  assert.equal(data.sourceIp, '203.0.113.9');
  assert.equal(data.originalMailFrom, 'spammer@xcds.net');
  assert.equal(data.originalRcptTo, 'someone@example.com');
  assert.equal(data.originalEnvelopeId, 'ABC123');
  assert.equal(data.identityAlignment, 'none');
  assert.equal(data.dkimDomain, 'xcds.net');
  assert.equal(data.dkimSelector, 'mail');
  assert.equal(data.dkimIdentity, '@xcds.net');
  assert.equal(data.arrivalDate?.toISOString(), '2026-10-10T12:00:00.000Z');
  assert.equal(data.reporter, 'outlook.com');

  // The dkim=fail lived on a folded continuation line, so this proves unfolding.
  assert.equal(data.spfResult, 'fail');
  assert.equal(data.dkimResult, 'fail');
  assert.equal(data.dmarcResult, null);

  assert.ok(data.reported, 'expected the embedded message to be parsed');
  assert.equal(data.reported?.subject, 'Your invoice is ready');
  assert.equal(data.reported?.messageId, '<fake-123@xcds.net>');
  assert.match(data.reported?.from ?? '', /spammer@xcds\.net/);

  // Opt-in fields stay empty by default.
  assert.equal(data.reported?.headerBlock, null);
  assert.equal(data.reported?.body, null);
  assert.equal(data.rawFeedback, null);

  assert.equal(data.reportAuthenticated, true);
  assert.match(data.dedupKey, /^msgid:report-1@outlook\.com$/);
});

await test('opt-in fields: header block, message body, raw feedback', async () => {
  const { feedback, reportedMessageRaw } = await loadFixture('ruf-microsoft.eml');
  const data = await parser.parseAndValidate(feedback!, {
    reportedMessageRaw,
    storeFullHeaders: true,
    storeReportedMessage: true,
    storeRawFeedback: true,
  });

  assert.match(data.reported?.headerBlock ?? '', /^From: "Fake Person"/);
  assert.match(data.reported?.headerBlock ?? '', /X-Mailer: EvilMailer 1\.0/);
  assert.match(data.reported?.body ?? '', /Buy stuff at/);
  assert.match(data.rawFeedback ?? '', /^Feedback-Type: auth-failure/);
});

await test('minimal report: no embedded message, dkim=none', async () => {
  const { feedback, reportedMessageRaw } = await loadFixture('ruf-minimal.eml');
  assert.ok(feedback);
  assert.equal(reportedMessageRaw, null);

  const data = await parser.parseAndValidate(feedback, {
    reporterEmail: 'dmarc-reports@mail.ru',
  });

  assert.equal(data.reported, null);
  assert.equal(data.sourceIp, '198.51.100.7');
  assert.equal(data.spfResult, 'fail');
  assert.equal(data.dkimResult, 'none');
  assert.equal(data.reporter, 'mail.ru');
  assert.equal(data.arrivalDate?.toISOString(), '2026-10-11T05:30:00.000Z');
  assert.equal(data.reportAuthenticated, false);
  assert.match(data.reportAuthDetail ?? '', /unverified sender/);
  assert.match(data.dedupKey, /^hash:[0-9a-f]{32}$/);
});

await test('non-conformant report: fields in the top-level text body', async () => {
  const { parsed } = await loadFixture('ruf-inline-body.eml');
  assert.ok(parsed.text, 'expected a text body');
  assert.equal(RufParser.looksLikeFeedbackReport(parsed.text), true);

  const data = await parser.parseAndValidate(parsed.text);
  assert.equal(data.domain, 'xcds.net');
  assert.equal(data.sourceIp, '192.0.2.55');
  assert.equal(data.dmarcResult, 'fail');
  assert.equal(data.dkimResult, 'none');
  assert.equal(data.identityAlignment, 'spf(fail, not aligned)');
});

await test('aggregate report message is not mistaken for a forensic report', async () => {
  const { parsed } = await loadFixture('aggregate-google.eml');
  assert.equal(RufParser.looksLikeFeedbackReport(parsed.text ?? ''), false);
  assert.equal(
    parsed.attachments.some((a) => a.contentType === 'message/feedback-report'),
    false,
  );

  await assert.rejects(
    () => parser.parseAndValidate(parsed.text ?? ''),
    /does not look like a DMARC forensic/,
  );
});

await test('unverified sender is recorded as such', async () => {
  const { feedback } = await loadFixture('ruf-microsoft.eml');
  const data = await parser.parseAndValidate(feedback!, {
    reportAuthenticationResults: 'mx.xcds.net; dkim=fail header.d=outlook.com; spf=fail',
  });
  assert.equal(data.reportAuthenticated, false);
  assert.match(data.reportAuthDetail ?? '', /did not authenticate/);
});

await test('dedup key: message-id wins, otherwise a stable hash per failure', async () => {
  const { feedback } = await loadFixture('ruf-microsoft.eml');

  const a = await parser.parse(feedback!);
  const b = await parser.parse(feedback!);
  assert.equal(a.dedupKey, b.dedupKey, 'same report must dedup to one row');

  const withMessageId = await parser.parse(feedback!, { reportMessageId: '<m1@x>' });
  const withOtherMessageId = await parser.parse(feedback!, { reportMessageId: '<m2@x>' });
  assert.notEqual(withMessageId.dedupKey, withOtherMessageId.dedupKey);

  const differentIp = feedback!.replace('Source-IP: 203.0.113.9', 'Source-IP: 203.0.113.10');
  const other = await parser.parse(differentIp);
  assert.notEqual(a.dedupKey, other.dedupKey);
});

await test('hostile input: oversized content is truncated, not stored whole', async () => {
  const filler = 'A'.repeat(200 * 1024);
  const text = [
    'Feedback-Type: auth-failure',
    'Reported-Domain: xcds.net',
    'Source-IP: 192.0.2.1',
    'Authentication-Results: mx.example; spf=fail',
    `DKIM-Canonicalized-Body: ${filler}`,
  ].join('\n');

  const data = await parser.parseAndValidate(text, { storeRawFeedback: true });
  assert.ok((data.rawFeedback?.length ?? 0) < 70 * 1024, 'raw feedback must be capped');
  assert.match(data.rawFeedback ?? '', /truncated at 65536 bytes/);

  const embedded = Buffer.from(`From: a@b.c\nSubject: x\n\n${filler}`);
  const withMessage = await parser.parseAndValidate(text, {
    reportedMessageRaw: embedded,
    storeReportedMessage: true,
  });
  assert.ok((withMessage.reported?.body?.length ?? 0) < 70 * 1024);
  assert.match(withMessage.reported?.body ?? '', /truncated at 65536 bytes/);
});

await test('malformed reported message falls back to a header scan', async () => {
  const { feedback } = await loadFixture('ruf-minimal.eml');
  const broken = Buffer.from('From: forged@xcds.net\nSubject: \xff\xfe not utf8\n\nbody');

  const data = await parser.parseAndValidate(feedback!, {
    reportedMessageRaw: broken,
    storeFullHeaders: true,
  });

  assert.ok(data.reported, 'fallback should still yield a reported message');
  assert.equal(data.reported?.from, 'forged@xcds.net');
  assert.match(data.reported?.headerBlock ?? '', /Subject:/);
});

await test('validation rejects implausible source IPs and empty reports', async () => {
  const base = await loadFixture('ruf-minimal.eml');
  const badIp = base.feedback!.replace('198.51.100.7', 'not-an-ip');
  await assert.rejects(() => parser.parseAndValidate(badIp), /implausible Source-IP/);

  // Two markers pass the shape guard, but nothing identifies a domain.
  await assert.rejects(
    () =>
      parser.parseAndValidate(
        'Feedback-Type: auth-failure\nSource-IP: 192.0.2.1\nArrival-Date: Thu, 10 Oct 2026 12:00:00 +0000',
      ),
    /no Reported-Domain and no Original-Mail-From/,
  );

  // One marker is not enough to be treated as a report at all.
  await assert.rejects(
    () => parser.parseAndValidate('Feedback-Type: auth-failure\nOriginal-Rcpt-To: <x@example.com>'),
    /does not look like/,
  );

  await assert.rejects(() => parser.parseAndValidate('hello world'), /does not look like/);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  process.exit(1);
}
