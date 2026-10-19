# NIS2 and this application

NIS2 is **Directive (EU) 2022/2555**. It is not a product standard and it does not certify
software: it obliges *organisations* to manage cyber risk, report incidents, and answer for it at
management-board level. Transposition was due by **17 October 2024** and is national (Germany's
NIS2UmsuCG, the Netherlands' Cyberbeveiligingswet, …), so the details that matter — registration
portal, authority, deadlines — are in your member state's law, not in the Directive.

## Is this project in scope?

| Question | Answer |
|---|---|
| Is `dmarc-parser` an in-scope entity? | **No.** It is self-hosted AGPL software; a tool is not an entity. |
| Are its users in scope? | **Usually yes.** Annex I/II cover 18 sectors, and the size rule is "medium and above" (≥50 staff or >€10 m turnover). A NIS2 entity's mail security is exactly what this tool observes. |
| Does hosting it change that? | **Yes, and this is the trap.** Offering it as a service can make *you* a "digital provider"/cloud computing service — a category in scope **regardless of size**. Self-hosting for your own organisation does not. |

So the honest framing for this repository is **supply chain**, not compliance: the code cannot make
its operator compliant, but it can either help them answer their auditor's questions or leave them
with nothing to show.

## Clause by clause (Art. 21(2))

`✔` = the code does this and you can point at the file. `—` = it does not, and no amount of
configuration will make it.

| Art. 21(2) | What this tree provides | Limit |
|---|---|---|
| (a) risk analysis and security policies | Nothing — an organisational artefact. | — |
| (b) incident handling | Forensic (ruf) ingestion and per-message failure evidence; processing logs; `/health` reports `unhealthy` when ingestion has actually stopped rather than answering 200 from an idle process. | It detects and records; it does not triage, escalate or open an incident. |
| (c) business continuity, backup, DR | `deploy/README.md` §6–§8: consistent SQLite snapshots (`.backup` / `VACUUM INTO`), restore, and a **restore drill** on a throwaway volume. | The drill is a runbook; executing it on a schedule is the operator's job. |
| (d) supply-chain security | `SECURITY.md`, `.github/dependabot.yml` (npm, actions, Docker), lockfiles, CI-gated publishing, GHCR provenance **and SBOM** attestations. | It covers this project's own dependencies. Your suppliers are still yours to assess. |
| (e) security in development/maintenance, vulnerability handling and disclosure | `SECURITY.md` with a private disclosure channel, scope, and best-effort response; Dependabot; `npm ci`; images published only from a commit that passed CI. | No paid SLA, no CVE team. "Best effort" is stated, not implied. |
| (f) assessing effectiveness of measures | CI type checks and tests on every push; `/health` (`/health/live` vs `/health`) for liveness vs ingestion. | No continuous control monitoring. |
| (g) cyber hygiene and training | Nothing — organisational. | — |
| (h) cryptography and encryption | TLS in transit (operator-terminated; `COOKIE_SECURE`), scrypt password hashing, opaque session tokens with only the hash stored, WebAuthn. | **No encryption at rest.** The SQLite file is plaintext — see the data inventory. |
| (i) HR security, access control, asset management | Per-domain scoping (404, not 403, for out-of-scope ids), admin/user roles, account lockout, session revocation on password change, passkey recovery that leaves the password intact. | No SCIM/provisioning lifecycle, no asset register. |
| (j) MFA, secured communications | **Passkeys** (WebAuthn, additive to passwords) and **OIDC** as a third way in. | MFA is available, not enforced; a password-only account can exist. |

Art. 20 (management approval and training) and Art. 27 (registration with the CSIRT/authority) are
entirely organisational. Art. 23's **24 h early warning / 72 h notification / 1-month final
report** is an obligation on the entity; this app can supply evidence for it (what arrived, from
which IPs, whether the mail authenticated) but it is not a reporting mechanism.

Fines, for context when budgeting: essential entities €10 m or 2 % of global turnover, important
entities €7 m or 1.4 % (Art. 34).

## Data inventory — what is stored, and for how long

All of it is in one SQLite file (`/app/data/data.db`). There is no object store, cache or second
config file.

| Table | Contents | Sensitivity | Retention |
|---|---|---|---|
| `reports`, `records` | Domain, reporting org, report window, **source IPs**, message counts, SPF/DKIM verdicts, dispositions, header From | Third-party IPs; network topology of your senders | `data.reportRetentionDays` (default: forever) |
| `forensic_reports` | Reported message's From/To/Subject/Date/Message-ID; optionally full headers, body and raw feedback; source IP | Can contain the phish itself and personal data | `data.forensicRetentionDays` (default: forever) |
| `users`, `sessions`, `webauthn_credentials` | Email, name, scrypt hash, lockout state, role; session token **hashes**, IP, user agent; passkey public keys and labels | Account data | Until the account is deleted |
| `auth_providers`, `user_identities` | Issuer, client id, **client secret in plaintext**, subject/email | Credential material | Until the provider is deleted |
| `settings` | Branding, retention policy, **mailbox password in plaintext** when entered in the UI | Credential material | Until changed |
| `audit_events` | Actor email, action, outcome, target, **IP**, user agent, redacted JSON detail | Behavioural data | `data.auditRetentionDays` (default: 365 days) |
| `tls_rpt_reports` | Per-domain SMTP TLS outcomes reported by senders: successes, failures, failing sender IPs, and the reporter's reason code; optionally the policy as published at the time | Third-party IPs; evidence about your own MX | `data.tlsRptRetentionDays` (default 365 days) |
| `processing_logs` | Attachment names, status, error detail, message UID; includes a row for any attachment the parsers did not recognise | Operational | Not pruned (small, and the evidence ingestion worked) |
| `domains`, `domain_checks` | Domain names and DNS check results | Low | Until the domain is removed |

Consequences worth stating plainly:

- **The file is the asset.** Protect the volume; enable disk/volume encryption at the host level,
  because the app does not encrypt at rest and stores two credentials in plaintext.
- Retention defaults are deliberately conservative: nothing that arrived in a report is deleted
  unless an administrator sets a number. `0` means forever everywhere.
- Pruning is irreversible, and a backup taken earlier still contains the rows — expire backups on
  the same schedule or the policy is cosmetic (§9 of `deploy/README.md`).

## Evidence an operator can hand an auditor

1. **Audit export** — *More → Audit log* (or `GET /api/audit/export?format=csv|json`). Each
   export carries `X-Audit-Digest: sha256:…` (JSON also embeds it, scoped to the `events` array).
   The digest proves the file was not altered after it left the database; it is not proof the
   database was never altered, which is why periodic export plus off-host storage is the point.
   Exporting is itself recorded as `audit.export`.
2. **Image attestation** —
   `gh attestation verify oci://ghcr.io/kristofer84/dmarc-parser:latest --repo kristofer84/dmarc-parser`,
   and `docker buildx imagetools inspect --format '{{json .SBOM}}' <image>` for the bill of
   materials.
3. **Backup and restore** — a snapshot verified with `PRAGMA integrity_check` and a completed
   restore drill (§8), not just a file that exists.
4. **TLS is measurable** — *TLS reports* shows SMTP TLS successes and failures per domain and MX, with the sender's reason for each failure. That is the input to an MTA-STS enforcement decision, and the first place to look when mail to your MX stops.
5. **Ingestion is alive** — `/health` returns 503 and `unhealthy` when cycles stop completing;
   `processing.lastCompletedAt` is the timestamp an auditor can read.
6. **Retention is applied** — *Settings → Data* previews exactly what a run would delete, per rule,
   before anything is deleted.

## What this project does **not** do

Say this before someone assumes otherwise:

- no log shipping, rotation policy, WORM storage or SIEM integration — the audit table is in the
  same database as the data it describes;
- no tamper evidence against an operator with the database file (the hash chain was deliberately
  not built; export digests are the substitute);
- no MFA enforcement, no password policy beyond the strength check, no SSO-driven role mapping;
- no encryption at rest, no field-level encryption, no secret manager integration;
- no incident workflow, notification templates, or 24 h/72 h deadline tracking;
- no asset inventory, vulnerability scanning of your estate, or supplier register;
- no certification of any kind. NIS2 does not create one either.

## If you are deploying this as a NIS2-relevant entity

Minimum defensible setup:

1. TLS in front, `COOKIE_SECURE=true`, `PUBLIC_ORIGIN` set to the exact public origin, API bound to
   loopback (the compose defaults already do this).
2. Every human account on a passkey or SSO; passwords kept only as the recovery path.
3. `data.auditRetentionDays` set to your evidence-retention period (not shorter than the national
   requirement), and a scheduled `GET /api/audit/export` copied off the host.
4. Backups per §6, and a restore drill you have actually run (§8).
5. Retention that matches your privacy policy — forensic reports first, because they hold
   third-party message content.
6. Keep the image tag pinned, and read `SECURITY.md` before deciding how to track releases.

This document describes the tree as of **2026-10-19**. If code and document disagree, the code is
right — and `docs/where-things-live.md` says where to check.
