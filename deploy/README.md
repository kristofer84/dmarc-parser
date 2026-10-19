# Deploying the console on dmarc.xcds.net

The app runs on **raspberrypi** as the `dmarc-parser` compose project. Only the frontend
container is published, and only on loopback: host nginx is the single public entry point.

```
internet ──443──> EdgeRouter ──> host nginx (TLS, dmarc.xcds.net)
                                   └─> 127.0.0.1:8097  frontend container (nginx + SPA)
                                                          └─> backend container :8096 (/api)
```

Follow the ordering rules in the home-config docs — **DNS → service → nginx → SSL**, the
cert only works after DNS resolves to this host. The generic runbook is
[new-address-setup.md](https://github.com/kristofer84/home-config/blob/main/new-address-setup.md);
this file records what is specific to this app.

## 1. DNS

`xcds.net` has a `*` wildcard pointing at another host (194.9.94.85), so an explicit
record is required and Loopia's DynDNS API cannot create one — use the XML-RPC recipe in
new-address-setup.md with `SUB = "dmarc"` and `IP = 94.137.115.203`.

For the address to keep following the line, copy the per-subdomain updater as well:

```bash
cd /media/storage/scripts/loopia
sed 's/^hostname=[^ ]*/hostname=dmarc.xcds.net/' loopiadns-hass.sh > loopiadns-dmarc.sh
chmod +x loopiadns-dmarc.sh
# then add "./loopiadns-dmarc.sh" to loopiadns.sh
```

Verify on both nameservers before touching certbot (Loopia's ns1/ns2 sync is uneven):

```bash
for ns in ns1.loopia.se ns2.loopia.se; do echo -n "$ns: "; dig +short @$ns dmarc.xcds.net A; done
```

## 2. Bind the app to loopback

In this repo's `docker-compose.yml` the frontend publishes `127.0.0.1:8097:80`. That
matters twice over: the API trusts `X-Forwarded-For` (so it must not be reachable
directly), and the DMARC data should not be on the LAN in plaintext.

`.env` needs, in addition to the IMAP values:

```bash
ADMIN_EMAIL=kristofer@xcds.net      # created once, when the users table is empty
ADMIN_PASSWORD=<long random string>
COOKIE_SECURE=true                  # force Secure cookies behind the proxy
PUBLIC_ORIGIN=https://dmarc.xcds.net
```

`ADMIN_PASSWORD` is only used to seed the first account — change it after signing in, or
leave it out and take the generated password from the logs once.

## 3. Host nginx

```bash
sudo mkdir -p /etc/ssl/dmarc
sudo openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -keyout /etc/ssl/dmarc/privkey.pem -out /etc/ssl/dmarc/fullchain.pem \
  -subj "/CN=dmarc.xcds.net"                      # self-signed bootstrap
sudo cp deploy/nginx/dmarc.xcds.net /etc/nginx/sites-available/dmarc.xcds.net
sudo ln -sf /etc/nginx/sites-available/dmarc.xcds.net /etc/nginx/sites-enabled/dmarc.xcds.net
sudo nginx -t && sudo systemctl reload nginx

curl -sk -o /dev/null -w '%{http_code}\n' --resolve dmarc.xcds.net:443:127.0.0.1 https://dmarc.xcds.net/
```

Expect `200` (the SPA shell) with the self-signed cert — the app itself then answers
`401` on `/api/*` until you sign in.

## 4. Certificate

This host does **not** have `python3-certbot-nginx` installed, so `certbot --nginx` fails
with "The requested nginx plugin does not appear to be installed". Use the webroot method
(the same one new-address-setup.md prescribes for moja) and repoint the two
`ssl_certificate` lines by hand:

```bash
sudo mkdir -p /var/www/html/root
sudo certbot certonly --webroot -w /var/www/html/root -d dmarc.xcds.net

sudo sed -i \
  -e 's#/etc/ssl/dmarc/fullchain.pem#/etc/letsencrypt/live/dmarc.xcds.net/fullchain.pem#' \
  -e 's#/etc/ssl/dmarc/privkey.pem#/etc/letsencrypt/live/dmarc.xcds.net/privkey.pem#' \
  /etc/nginx/sites-available/dmarc.xcds.net

sudo nginx -t && sudo systemctl reload nginx
sudo certbot renew --cert-name dmarc.xcds.net --dry-run
```

`certonly --webroot` validation reads the ACME challenge from port 80, which is why the
HTTP server block in the vhost (and not the redirect) owns that location. certbot installs
its own renewal timer, so nothing further is needed — but the redirect is *not* added by
certbot here; the vhost's port-80 block already returns 301.

## Notes that cost time if forgotten

- **The login page must be reachable over plain HTTP the first time.** `COOKIE_SECURE=true`
  belongs in `.env` from the start; before that, a `Secure` cookie over http is silently
  dropped and a login looks like it "did nothing".
- **`trust proxy` is on**, so the API must stay on loopback (see step 2). If it is ever
  published on an interface, set `TRUST_PROXY=false`, or client IPs — and therefore the
  login rate limiter — become spoofable.
- **/health stays public** because the container healthcheck uses it. It returns the
  verdict and counters to anonymous callers, and the failure text only to a signed-in one.
- A failed login is rate limited to 10/min per IP **per route**; dashboard polling no
  longer eats that budget (that was a bug this work fixed).

## 5. Sign-in options

Three ways in, all optional and additive: a password (always available), a passkey, and single
sign-on through an OIDC provider. Passkeys and SSO are configured in the UI, so this section is
about the parts that live outside it.

### Passkeys

Passkeys are bound to the **exact origin**: they work only on the hostname in `PUBLIC_ORIGIN`
(here `https://dmarc.xcds.net`). Reached by IP, over plain http, or through a second hostname,
they simply will not authenticate - and there is no useful error to show, because the browser
refuses before any request is sent. Renaming the hostname invalidates every registered passkey.
So settle the hostname before enrolling anything, and keep the password as the way in when a
device is lost: an administrator can clear a user's passkeys from the Users screen.

### Single sign-on (OIDC)

The provider must know the callback URL before it will hand back an authorization code, and that
is not friction to be worked around - it is what stops a code being delivered to someone else's
URL. Add the provider under *More -> Identity providers*, then copy the callback the form shows -
`https://<host>/api/auth/oidc/<provider id>/callback` - into the IdP. **Test connection** fetches
the discovery document and prints the endpoints it resolved, so a wrong issuer fails there rather
than at first login.

Dynamic client registration (RFC 7591, where the app registers itself) would remove the manual
step, but the IdPs that offer it want an initial access token first, and the common self-hosted
ones do not offer it at all - so it is manual registration, deliberately.

**For Google specifically:** issuer `https://accounts.google.com`, and in the Google Cloud
console the client is a *Web application* with that callback under Authorized redirect URIs, plus
the consent screen configured. While the consent screen is in **Testing**, only accounts you list
as test users can sign in; publishing it needs no review for the `openid email profile` scopes.

Google does allow unregistered redirect URIs for *native* clients - `http://127.0.0.1:<port>`
loopback - which is a desktop-app allowance and does not apply to a fixed hostname like this one.

### Identity, not authority

The IdP says *who* someone is; it never says what they may do. Only `sub`, `email` and
`email_verified` (plus a display name) are read from the token, and no claim is consulted for
authority - a token carrying any group, role or scope claim cannot make someone an administrator
or widen their access. Roles and domain assignments live in this app's own database and are
changed in the Users screen; the only other way in is the `ADMIN_EMAIL` / `ADMIN_PASSWORD`
bootstrap in step 2.

A user signed in through SSO therefore arrives as an ordinary user with **no domains**: they can
sign in and see nothing until an administrator assigns domains. The provider's `defaultDomains`
setting is the one convenience that pre-assigns domains to accounts the provider provisions - it
is configuration in this app, not a claim in the token.

Rules the server enforces whatever the provider: only a **verified** email may link to an existing
account (an unverified one is the account-takeover path, so it is refused); and an SSO session is
identical to a password login, so per-domain access and the audit trail are unchanged. With no
provider configured, nothing about the login page changes.

## 6. Backup

Everything the app knows is in the SQLite file: reports and records, forensic reports
(including any stored message bodies), users and password hashes, sessions, passkeys,
identity providers and their client secrets, per-domain assignments, branding, the mailbox
password when it was entered in the UI, and the audit log. There is no uploads directory,
cache or second config file to remember. `.env` is configuration, not state: keep a copy
with your secrets if `IMAP_PASSWORD` lives there, because then it is the only copy of that
secret.

**Do not `cp` or `tar` the live file.** A copy taken while a transaction is committing can
contain a page that was only half-written; in testing, copying a 19 MB database under
concurrent writes produced a file whose `PRAGMA integrity_check` failed with
`2nd reference to page ...`. It is not deterministic - two other copies of the same
database were fine - which makes it worse, not better. `sqlite3 .backup` and `VACUUM INTO`
take a consistent snapshot through SQLite itself, under the file lock.

The sqlite3 CLI has no busy timeout by default. Against a database being written to,
`.backup` failed with `Error: database is locked` and left a 0-byte file behind. Always
pass `-cmd '.timeout 10000'` and check the size of the result.

Volume (`compose.quickstart.yml`, `dmarc-data`):

```bash
docker run --rm \
  -v dmarc-data:/data \
  -v "$PWD":/backup \
  alpine sh -c 'apk add --no-cache sqlite >/dev/null && \
    sqlite3 -cmd ".timeout 10000" /data/data.db ".backup /backup/dmarc-$(date +%F).db"'
```

That installs the CLI into a throwaway container. Pin the alpine tag if you care about
reproducing it, and pre-pull the image so a backup does not depend on the network being up.
`.backup` copies page for page, including free pages; use
`VACUUM INTO '/backup/dmarc-$(date +%F).db'` instead to write a compacted snapshot (it
needs free space about the size of the database).

The app image itself has no sqlite3 binary, but Node 24 includes `node:sqlite`, so the same
snapshot can be taken without pulling anything:

```bash
docker compose -f compose.quickstart.yml exec dmarc-parser \
  node -e "const {DatabaseSync}=require('node:sqlite');new DatabaseSync('/app/data/data.db').exec(\"VACUUM INTO '/app/data/backup.db'\")"
docker compose -f compose.quickstart.yml cp dmarc-parser:/app/data/backup.db ./dmarc-$(date +%F).db
docker compose -f compose.quickstart.yml exec dmarc-parser rm /app/data/backup.db
```

Bind mount (`docker-compose.yml`, `./data`):

```bash
sqlite3 -cmd '.timeout 10000' ./data/data.db ".backup '/path/to/backups/dmarc-$(date +%F).db'"
# or, compacted:
sqlite3 -cmd '.timeout 10000' ./data/data.db "VACUUM INTO '/path/to/backups/dmarc-$(date +%F).db'"
```

Write the backup outside `./data`: a file sitting next to the database is inside the next
snapshot and inside whatever copies that directory.

Verify every backup, and keep the check in the cron job:

```bash
sqlite3 dmarc-2026-10-19.db "PRAGMA integrity_check;"
sqlite3 dmarc-2026-10-19.db "SELECT count(*) FROM reports;"
```

`ok` and a non-zero count, or the run failed. An empty file passes nothing.

Schedule: daily is enough here - the database is small (19 MB with 428 reports) and a day of
lost mail can be re-fetched from the mailbox if the report mail is still there. Run it at a
quiet hour, copy the result off the host, and keep a known-good older copy as well as the
latest: the failure you are protecting against may have happened days ago. A workable
default is 7 daily, 4 weekly and 12 monthly; set the numbers from your own policy rather
than from this sentence.

## 7. Restore

Stop the app, replace the file, start it. Do not use `docker compose down -v`: `-v`
deletes `dmarc-data`, which is the thing being restored.

Volume:

```bash
docker compose -f compose.quickstart.yml down
docker run --rm -v dmarc-data:/data -v "$PWD":/backup alpine sh -c \
  'rm -f /data/data.db /data/data.db-wal /data/data.db-journal && \
   cp /backup/dmarc-2026-10-19.db /data/data.db'
docker compose -f compose.quickstart.yml up -d
```

Bind mount: copy the backup over `data/data.db`, after saving the current file as
`data/data.db.before-restore`, and remove any `-wal`/`-journal` sidecars.

The app runs `npx prisma db push --accept-data-loss` on every start
(`backend/src/db/prisma.ts`), so a backup from an older release is carried forward to the
current schema automatically. The reverse does not work: an older image cannot read a
schema written by a newer one, and `db push` will not roll it back. Restore an old backup
with the image tag that wrote it, or restore a backup no newer image has touched. That is
also why you pin the tag (`...:1.2.3`, not `:latest`) before restoring, and keep the
previous image until the restored instance has run for a while.

Check the file before starting:

```bash
sqlite3 data/data.db "PRAGMA integrity_check;"
sqlite3 data/data.db "SELECT 'reports', count(*) FROM reports
  UNION ALL SELECT 'records', count(*) FROM records
  UNION ALL SELECT 'users', count(*) FROM users;"
```

`ok`, and non-zero for `reports`, `records` and `users` (an empty-looking database means the
copy did not land). `forensic_reports` may legitimately be zero. Then check the running app:

```bash
curl -fsS localhost:8096/health
```

`-f` turns the 503 into a failure, which is the point - the endpoint reports `unhealthy`
when ingestion is broken rather than answering 200 from a process that has stored nothing
for days. A 200 is necessary but not sufficient: read the body. `processing.mailboxConfigured:
false` means the app is healthy and will ingest nothing, and `processing.lastCompletedAt`
is the evidence that a cycle actually finished after the restore. `/health/live` only says
the process is up; it says nothing about the database.

## 8. Restore drill

A backup is not a backup until it has been restored once. Do this on a throwaway volume and
port so the live instance is never at risk:

```bash
docker volume create dmarc-restore-test
docker run --rm -v dmarc-restore-test:/data -v "$PWD":/backup alpine sh -c \
  'cp /backup/dmarc-2026-10-19.db /data/data.db'
docker run -d --rm --name dmarc-restore-test \
  -p 127.0.0.1:18096:8096 \
  -v dmarc-restore-test:/app/data \
  -e COOKIE_SECURE=false \
  ghcr.io/kristofer84/dmarc-parser:1.2.3
curl -fsS localhost:18096/health
docker stop dmarc-restore-test
docker volume rm dmarc-restore-test
```

Sign in on `http://localhost:18096`, open a report, and compare the UI counts with the
`sqlite3` counts above. If the tag the backup came from has been deleted from the registry,
the drill has failed: the backup is not restorable by you. Run the drill after every upgrade
and after changing the backup job.

## 9. Retention and backups

Three admin settings control how long data is kept: `data.reportRetentionDays` for aggregate
reports, `data.forensicRetentionDays` for forensic reports, and `data.auditRetentionDays` for
the audit log. `0` keeps forever for each. The forensic ones matter beyond disk: a forensic
report can contain the reported message's headers and body, so pruning them is the way to
stop holding third-party content you do not need. Pruning is irreversible - there is no undo
and no "deleted" view.

Retention and backups interact in two ways that surprise people:

- Deleting rows does not change a backup that already exists. A snapshot taken before the
  prune still contains the data, and so does every copy of that snapshot. If the point of
  the retention period is to stop retaining something, expire backups on the same schedule;
  otherwise the row survives in the archive.
- SQLite does not return freed pages to the filesystem by default. After a prune the file
  stays the same size and the space is reused by later rows. To actually shrink it, run
  `VACUUM` - which rewrites the whole file, needs free disk equal to the database size, and
  blocks writers for the duration. Do it in a maintenance window:

```bash
docker compose -f compose.quickstart.yml stop
sqlite3 data/data.db "VACUUM;"
docker compose -f compose.quickstart.yml start
```

`VACUUM INTO` during a backup compacts the copy without touching the live file, which is
usually the better trade: the live database keeps its free pages and the archive is small.
