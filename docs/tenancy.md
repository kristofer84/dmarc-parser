# Organisations, memberships and tenant scoping

The console is multi-tenant: an **organisation** owns domains, mailboxes and DNS accounts; a
user reaches an organisation through a **membership** with one of two roles; the **instance
superadmin** sees every organisation and manages instance-level settings.

All phases are implemented: schema/migration, scoping, per-organisation mailboxes and ingestion,
automatic domain claim, quarantine on cross-tenant collisions, org-owned DNS accounts, the
organisation admin UI and setting-gated org self-signup.

## Model

| Entity | Meaning |
|---|---|
| `Organization` | the tenant: `id`, `name`, `slug` |
| `Membership` | `(userId, orgId, role)` with `role ∈ {admin, viewer}`; unique per pair |
| `User.role` | `admin` = **instance superadmin**; `user` = ordinary account. Kept separate from org roles |
| `Domain.orgId` | the owning organisation; `null` means unowned (discovered but not yet claimed) |
| `Domain.dnsAccountId` | optional pin to one of the org's DNS accounts; null means auto |
| `OrgMailbox` | an IMAP mailbox owned by an organisation (one org can have several) |
| `DnsAccount` | named DNS credentials (`cloudflare` or `loopia`) owned by an organisation |
| `Report/ForensicReport/TlsRptReport/ProcessingLog.orgId` + `mailboxId` | the tenant and mailbox that ingested the row |
| `Alert.orgId`, `AuditEvent.orgId` | tenant scope; null for instance-level actions and legacy rows |

`UserDomain` is **not** dropped: it is the migration bridge for accounts that predate tenancy.
Once every account has a membership the fallback is unreachable.

## Roles and permissions

| Action | Viewer | Org admin | Superadmin |
|---|---|---|---|
| Read reports, sources, forensics, TLS-RPT, alerts, processing logs for the active org | yes | yes | yes (all orgs) |
| Edit domain settings (selectors, MX, notes, monitoring) | no | own org | any |
| Add/claim a domain for the org | no | yes | yes (may leave unowned) |
| Choose the domain's DNS account | no | own org | any |
| Apply DNS records / add `rua` | no | own org | any |
| Acknowledge alerts | no | yes | yes |
| Manage org members, mailboxes, DNS accounts | no | yes | yes |
| Instance settings, identity providers, users, audit export, retention, org creation from the admin UI | no | no | yes |

Write guards: `requireOrgAdmin` (superadmin **or** admin of the active org). Instance-only
guards stay `requireAdmin`. Cross-org resources answer **404**, never 403.

## Active organisation

- The SPA sends `X-Org-Id: <id>` on every request (persisted in `localStorage`).
- A regular user must have a membership in that organisation; otherwise `403 ORG_FORBIDDEN`.
  With no header the oldest membership is used.
- A superadmin may select any existing organisation; with no header they keep `organizationId`
  unset, which `getDomainScope()` interprets as **all organisations**.
- Switching organisation reloads the SPA; every view caches data for the previous tenant.

## Scoping invariant

`getDomainScope(req)` in `middleware/auth.ts` is the single read choke point:

```
superadmin, no active org   → null            (unrestricted)
active org                  → Domain.orgId = active org (names)
no membership (legacy)      → UserDomain rows (migration bridge)
otherwise                   → []              (nothing, never everything)
```

Every report-shaped route passes the result into its query. An organisation can only ever read
domains it owns; a domain has exactly one owner (`Domain.name` unique, one `orgId`).
Processing logs use `orgId` directly when an org is active, which is what makes a quarantined
row visible to the ingesting org without a linked report.

## Per-organisation mailboxes and ingestion

`OrgMailbox` rows carry label/host/port/user/password/verifyTls/enabled plus `lastRunAt` and
`lastError`. Credentials are write-only over the API. The scheduler (in `index.ts`) makes one
sequential pass over `resolveIngestMailboxes()`:

1. every enabled `OrgMailbox` row, joined with its organisation;
2. a **virtual legacy mailbox** for the `Default` organisation while it has **no enabled rows**
   and the pre-tenancy `IMAP_*`/settings mailbox is configured. The environment password is not
   copied into the database. Adding a real Default mailbox removes the virtual one.

`EmailProcessor.processMailbox()` stamps `orgId` and `mailboxId` on every `Report`,
`ForensicReport`, `TlsRptReport` and `ProcessingLog`. First-run detection is per mailbox
(`reports` counted by org+mailbox), so a newly added mailbox imports its readable history once.
A failing mailbox updates `lastError` and does not stop the others.

### Claim and quarantine

`claimOrCheckDomain(orgId, domain)` in `services/domainOwnership.ts` runs before storing an
aggregate report, forensic report or TLS-RPT policy entry:

- no `Domain` row → created with `orgId`, `claimedAt`, `claimSource: 'report'`;
- an unowned row → claimed with a compare-and-set (`updateMany where orgId: null`), re-read on a
  lost race;
- same org → proceed;
- **another org** → the report is **quarantined**: a `ProcessingLog` with status
  `quarantined`, the ingester's `orgId`/`mailboxId`, and no data row. Neither org can read the
  other's report; the ingesting org sees the quarantine in Processing Logs (filter
  `status=quarantined`).

This is why no DNS TXT proof is used: the security boundary is the mailbox an organisation
controls, and claiming a name you control no mail for yields no data. A domain can be claimed
once; a second manual claim answers `409 DOMAIN_OWNED`. A superadmin can move a domain with
`PATCH /api/domains/:id { orgId }` (`null` unowns it).

### Mailbox API

All routes are org-admin guarded and audit mutations (`org.mailbox.*` with `orgId`, never the
password):

```
GET    /api/organizations/:orgId/mailboxes
POST   /api/organizations/:orgId/mailboxes
PATCH  /api/organizations/:orgId/mailboxes/:id
DELETE /api/organizations/:orgId/mailboxes/:id
POST   /api/organizations/:orgId/mailboxes/:id/test
```

Serialized: `{ id, label, host, port, user, verifyTls, enabled, passwordSet, lastRunAt,
lastError, createdAt, updatedAt }`. `PATCH` with a blank/absent password keeps the stored one.
`test` returns `{ ok, message }` (200 even on failure) and performs one read-only IMAP connect.

## DNS accounts (org-owned)

DNS credentials belong to the organisation, not the domain. A domain may pin one account;
otherwise the plan tries the org's enabled accounts (Cloudflare first, then label) and uses the
one that holds the zone. The `Default` organisation without accounts falls back to the legacy
environment/settings credentials; other orgs get `409 DNS_NOT_CONFIGURED` rather than borrowing
another tenant's credentials. An assigned-but-disabled/missing account is an error, never a
silent fallthrough.

```
GET    /api/organizations/:orgId/dns-accounts
POST   /api/organizations/:orgId/dns-accounts
PATCH  /api/organizations/:orgId/dns-accounts/:id
DELETE /api/organizations/:orgId/dns-accounts/:id
POST   /api/organizations/:orgId/dns-accounts/:id/verify
```

Serialized: `{ id, label, provider, enabled, credentialSet, domainCount, createdAt, updatedAt }`.
Provider is immutable after creation; blank credentials keep the stored ones; `verify` makes one
read-only list call and returns `{ ok, message?, visible? }`. The plan response now carries
`account: { id, label, provider } | null` (null = legacy credentials) and the UI shows the label.
DMARC `rua` uses the domain org's first enabled mailbox user, falling back to the legacy mailbox
for `Default`; `409 MAILBOX_NOT_CONFIGURED` otherwise. See `docs/dns-apply.md`.

## Organisation and member API

| Method | Path | Who |
|---|---|---|
| `GET` | `/api/organizations` | own memberships; all organisations with counts for a superadmin |
| `POST` | `/api/organizations` | any signed-in user; creator becomes org admin |
| `GET` | `/api/organizations/:id/members` | org admin / superadmin |
| `POST` | `/api/organizations/:id/members` | org admin / superadmin; attaches an existing account or creates one with a password (`mustChangePassword`) |
| `PATCH` | `/api/organizations/:id/members/:userId` | change `role`; the last admin cannot be demoted |
| `DELETE` | `/api/organizations/:id/members/:userId` | remove the membership only; the last admin cannot be removed |
| `GET` | `/api/organizations/:id/role` | the caller's role in that org |

Public self-signup is `POST /api/auth/signup-org`, gated by `auth.orgSignupOpen` (default
**false**). It creates the account **and** organisation atomically; an existing email gets 409 and
must sign in. `GET /api/auth/session-policy` reports `orgSignupOpen`; the login page shows the
form only when it is true.

`GET /api/auth/me` returns `organizations`, `activeOrganizationId`, `orgRole` and
`isSuperAdmin` in addition to `user` and `domains`.

## Migration

`ensureDefaultOrganization()` runs on every start, and is a no-op once any organisation exists:

1. create `Default` / `default`;
2. create a membership for every existing user (`admin` users → org admin, others → viewer);
3. set `orgId` on every unowned domain (`claimSource: migration`) and every report, forensic
   report, TLS-RPT report, processing log and alert that has none.

`ensureSuperadminMembership()` then adds every superadmin to the Default organisation
(idempotent). Take a database snapshot before the first start after deploying a tenancy change;
the migration rewrites `orgId` once.

## Frontend

- Organisation switcher in the header when the account has more than one membership, or is a
  superadmin (who also gets "All organisations"). The axios interceptor attaches `X-Org-Id`.
- `/organisation` page for org admins: **Members**, **Mailboxes** (create/edit/test/delete, last
  run/error), **DNS accounts** (create/edit/verify/delete, secret placeholders).
- `/organisation` is guarded by `meta.orgAdmin` (superadmin or active-org admin).
- Domain panel: owner column, DNS-account select (Auto + org accounts), plan shows the account
  label. DNS apply is available to org admins now that the routes are `requireOrgAdmin`.
- Instance admin pages (settings, users, identity providers, audit) remain superadmin-only.

## Tests

- `backend/test/tenancy.test.ts` — 14 tests: migration, `/auth/me`, read isolation across
  reports/summary/sources/domains/alerts, cross-org `X-Org-Id` refusal, superadmin all-vs-one,
  domain permissions, claim uniqueness, member management and last-admin protection, alert acks,
  org creation.
- `backend/test/ingestion.test.ts` — 16 tests: claim/quarantine, context stamping, mailbox CRUD
  and secret handling, virtual legacy selection.
- `backend/test/dnsAccounts.test.ts` — 22 tests: account CRUD/secret redaction/provider
  immutability/cross-org 404; assigned vs auto account; disabled-account error; org mailbox
  `rua`; plan/apply without network.
- Existing suites (reports, sources, alerts, OIDC, DNS/Cloudflare/Loopia, parsers) pass
  unchanged through the legacy bridges.
