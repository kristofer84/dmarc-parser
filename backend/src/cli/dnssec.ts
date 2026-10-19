#!/usr/bin/env tsx
import {
  algorithmName,
  dsFromDnskey,
  inspectDnssec,
  type DnssecInspection,
} from '../services/dnssec.js';

/**
 * DNSSEC helper.
 *
 *   npx tsx src/cli/dnssec.ts <domain>          full inspection
 *   npx tsx src/cli/dnssec.ts <domain> --ds     only the DS lines to paste at the registrar
 *   npx tsx src/cli/dnssec.ts <domain> --json   machine-readable
 *
 * This exists because Node's stub resolver cannot ask for DS or DNSKEY, so answering "is this
 * domain signed, and does the registrar's DS match a key in the zone" otherwise means juggling
 * `dig +dnssec` and an SHA-256 of a hand-assembled record. It uses the same code path as the
 * domain check, so a discrepancy between the CLI and the console means a bug, not two
 * implementations.
 */

function formatKey(key: DnssecInspection['dnskey'][number]): string {
  const role = key.isKeySigningKey ? 'KSK' : 'ZSK';
  return `${role.padEnd(3)} ${String(key.flags).padStart(3)} 3 ${key.algorithm} (${algorithmName(key.algorithm)})  key tag ${key.keyTag}`;
}

function describe(inspection: DnssecInspection, domain: string): string[] {
  const lines: string[] = [];

  if (!inspection.queried) {
    return [`  could not query a validating resolver: ${inspection.error ?? 'unknown error'}`];
  }

  lines.push(`  resolver validated this data (AD): ${inspection.authenticated ? 'yes' : 'no'}`);

  if (inspection.dnskey.length === 0) {
    lines.push('  zone keys:   none - the zone is not signed');
  } else {
    lines.push(`  zone keys:   ${inspection.dnskey.length}`);
    for (const key of inspection.dnskey) {
      lines.push(`    ${formatKey(key)}`);
    }
  }

  if (inspection.ds.length === 0) {
    lines.push('  DS at parent: none - no chain of trust, so validators treat the domain as unsigned');
  } else {
    lines.push(`  DS at parent: ${inspection.ds.length}`);
    for (const match of inspection.matches) {
      const label = `${match.ds.keyTag} ${match.ds.algorithm} ${match.ds.digestType} ${match.ds.digest}`;
      lines.push(`    ${label}`);
      lines.push(
        match.key
          ? '      ✅ matches a DNSKEY in the zone'
          : '      ❌ matches NO key in the zone - validating resolvers will fail on this domain',
      );
    }
  }

  if (inspection.cds.length > 0) {
    lines.push(`  CDS published by the zone: ${inspection.cds.length} (RFC 8078 automated rollover)`);
  }

  // The calculator: what a registrar should hold for each signing key, whether or not a DS is
  // published yet. This is the value to paste when enabling DNSSEC or rotating the KSK.
  const signingKeys = inspection.dnskey.filter((key) => key.isKeySigningKey);
  const targets = signingKeys.length > 0 ? signingKeys : inspection.dnskey;
  if (targets.length > 0) {
    lines.push(`  DS records to publish for ${domain}:`);
    for (const key of targets) {
      const ds = dsFromDnskey(domain, key);
      const present = inspection.ds.some(
        (live) =>
          live.keyTag === ds.keyTag &&
          live.algorithm === ds.algorithm &&
          live.digestType === ds.digestType &&
          live.digest === ds.digest,
      );
      lines.push(`    ${ds.keyTag} ${ds.algorithm} ${ds.digestType} ${ds.digest}  ${present ? '(already live)' : '(NOT published)'}`);
    }
  }

  return lines;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const domain = args.find((arg) => !arg.startsWith('--'));
  const asJson = args.includes('--json');
  const dsOnly = args.includes('--ds');

  if (!domain) {
    console.error('usage: tsx src/cli/dnssec.ts <domain> [--ds|--json]');
    process.exit(2);
  }

  const inspection = await inspectDnssec(domain);

  if (asJson) {
    console.log(JSON.stringify({ domain, ...inspection }, null, 2));
    process.exit(inspection.queried ? 0 : 1);
  }

  if (dsOnly) {
    if (!inspection.queried) {
      console.error(`could not query a validating resolver: ${inspection.error}`);
      process.exit(1);
    }
    const keys = inspection.dnskey.filter((key) => key.isKeySigningKey);
    for (const key of keys.length > 0 ? keys : inspection.dnskey) {
      const ds = dsFromDnskey(domain, key);
      console.log(`${ds.keyTag} ${ds.algorithm} ${ds.digestType} ${ds.digest}`);
    }
    process.exit(0);
  }

  console.log(`\n${domain}\n${describe(inspection, domain).join('\n')}\n`);
  process.exit(inspection.queried ? 0 : 1);
}

void main();
