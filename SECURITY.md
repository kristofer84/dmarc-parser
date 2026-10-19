# Security

This is a self-hosted application: it runs on your host, behind your TLS terminator, with
your report data in a SQLite file on your disk. That shapes what the project can promise.
Fixes are best effort, anything that depends on how you deployed it - TLS, proxy headers,
network exposure - is yours to get right, and the sections below say exactly what the code
does and does not enforce.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting:

<https://github.com/kristofer84/dmarc-parser/security/advisories/new>

That channel is private, gives us a draft advisory only the two of us can see, and is the
only place an exploitable issue should be described. A public issue that names a bypass is
a disclosure, not a report.

Useful in the report: the image tag or commit you are running, how it is deployed (plain
Docker, compose, proxy in front), the steps to reproduce, and what an attacker gains. If
the issue is only reachable with a non-default setting, say which.

## What to expect

Best effort. There is no on-call rotation and no SLA, and no guaranteed fix date.

- We aim to acknowledge within three working days and to say early whether the report is in
  scope.
- Severity comes from impact on a deployed instance, not from a scanner's label.
  Authentication bypass, scope escape and secret disclosure are handled first.
- Fixes land on `main` and in the next image published from it. Older tags are not patched.
- Reporters are credited in the advisory unless they ask not to be.
- A CVE or GitHub Security Advisory is requested for anything that affects a deployment.
  Not every report gets one: a hardening improvement or a defence-in-depth change is worth
  fixing, but it is not a vulnerability.

## Supported versions

`latest` and the current `main` branch receive fixes. Where a tagged minor release exists,
the most recent one is supported too. Older tags are not backported.

The project has not cut a stable release line yet, so today `latest` is the supported
version. Self-hosted users are expected to watch the repository and rebuild; the image is
multi-arch and self-contained, so that is a pull and a restart rather than a migration.

## Scope

In scope:

- Authentication or authorisation bypass, including passkey and OIDC flows.
- Per-domain access-scope escape: a non-admin reading another domain's aggregate or
  forensic reports, or data derived from them.
- Injection (SQL, command, template) reachable through report data, configuration or API
  input.
- Path traversal in archive or attachment handling.
- SSRF through the IMAP host, an OIDC issuer or a discovery URL.
- Disclosure of secrets: the IMAP password, an OIDC client secret, session tokens, password
  hashes.
- Privilege escalation, including a non-admin reaching admin-only routes.
- De-anonymisation of report data: report contents - source IPs especially - exposed to
  someone not scoped to that domain.

Out of scope:

- DMARC, SPF or DKIM misconfiguration on the reporting domain's own DNS. That is the
  reporter's configuration; this app displays what arrives.
- The contents of reports third parties send. We parse untrusted input carefully, but we do
  not control what a reporter puts in it.
- Self-XSS and paste-into-console tricks.
- Missing hardening headers on someone else's reverse proxy. TLS and headers are the
  operator's layer; see `deploy/README.md`.
- Dependency reports with no exploitable path in this application. Still welcome - open a
  normal issue or let Dependabot's PR stand - because a vulnerable transitive package is
  worth removing even when nothing reaches it.

## What the code already does

These are properties of the current tree, verified in the files named. They are not
promises about a future refactor.

- **Passkeys are an addition, never a replacement.** WebAuthn registration and sign-in live
  in `backend/src/services/webauthn.ts`; password login is untouched and stays available.
  Ceremony challenges are minted server-side, single-use and consumed before verification;
  origin and RP ID are checked against what the authenticator signed; a non-advancing sign
  counter is rejected as a possible cloned authenticator. An administrator can delete every
  credential on an account without touching its password (`routes/users.ts`,
  `removeAllCredentialsForUser`).
- **OIDC is identity-only.** `backend/src/services/oidc.ts` reads claims only after the
  library has validated the id_token against the provider's JWKS, issuer, audience, expiry
  and nonce. No claim confers a role or domain access: a provisioned account starts as
  `role: 'user'`, and linking an external identity to an existing account leaves that
  account's role and domains exactly as they were. Linking requires the provider to mark the
  email verified.
- **Passwords are hashed with scrypt** (`backend/src/services/auth.ts`): N=16384, r=8, p=1,
  a per-password salt, a versioned format string, and `timingSafeEqual` for the comparison.
  There is no fallback to a weaker hash.
- **Sessions are opaque and server-side.** `createSession` mints 32 random bytes; only the
  SHA-256 hash is stored (`session.tokenHash` in `backend/prisma/schema.prisma`), so a
  database leak does not hand over live sessions. The cookie is `HttpOnly`, `SameSite=Lax`,
  and `Secure` when the request is TLS or `COOKIE_SECURE=true`
  (`backend/src/services/sessionCookie.ts`).
- **Login is rate limited and accounts lock out.** `POST /api/auth/login` is capped at 10
  attempts per minute per IP (`backend/src/routes/auth.ts`), and repeated failures set
  `lockedUntil` for a configurable window (`authenticate()` in `services/auth.ts`). Failures
  return the same message whether or not the account exists.
- **Report queries are scoped per domain.** `getDomainScope()` in
  `backend/src/middleware/auth.ts` returns `null` for admins and the user's assigned domains
  otherwise; `routes/reports.ts`, `summary.ts`, `forensics.ts` and `processingLogs.ts` apply
  that scope in the query itself. A user with no assigned domains gets empty results, not an
  error.
- **Security-relevant events are recorded in the database, not only in stdout.** Routes set
  `req.audit` and one middleware (`backend/src/middleware/audit.ts`) writes the row when the
  response finishes, taking the outcome from the status code - so "success" cannot be recorded
  for a request that failed. Sign-ins (password, passkey and OIDC, failing ones included),
  lockouts, password changes, passkey registration and removal, and every user, domain,
  provider, setting and retention change are covered; unannotated state-changing routes fall
  back to `http.<verb> <route>` rather than going unrecorded. Credential-shaped detail keys are
  redacted at write time (`services/audit.ts`), and the table is append-only by application
  design. Administrators read and export it at `/admin/audit`; each export carries a SHA-256
  digest, and exporting is itself audited. Rows are pruned by
  `data.auditRetentionDays` (default 365; `0` keeps forever). What this is not: tamper-evident
  against someone holding the database file, and not shipped off the host. Export on a schedule
  if that matters to you - `docs/nis2.md` says why.

## Verifying a published image

Every published image has a signed build provenance statement binding the digest to this
repository, commit and workflow run:

```bash
gh attestation verify oci://ghcr.io/kristofer84/dmarc-parser:latest --repo kristofer84/dmarc-parser
```

The image also carries an SBOM attestation, so the dependency question can be answered from
the artifact rather than from this repository:

```bash
docker buildx imagetools inspect --format '{{json .SBOM}}' ghcr.io/kristofer84/dmarc-parser:latest
```

Both commands exit non-zero when the attestation is missing or does not match, which is what
makes them useful in a deployment check rather than a formality.

## Dependencies

- Lockfiles are committed (`backend/package-lock.json`, `frontend/package-lock.json`), and
  CI installs with `npm ci`.
- Dependabot watches npm in `backend/` and `frontend/`, plus the workflow actions and the
  Dockerfile, weekly. Minor and patch updates are grouped per ecosystem; major updates come
  as their own PR because they need a human.
- CI (`.github/workflows/ci.yml`) runs the backend type check and tests and the frontend
  type check and build. Publishing reuses that workflow, so an image is only built from a
  commit that passed it.
