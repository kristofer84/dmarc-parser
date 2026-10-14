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
the consent screen configured. Two consequences to know before starting:

- While the consent screen is in **Testing**, only accounts you list as test users can sign in.
  Publishing it needs no review for the `openid email profile` scopes.
- Google sends **no groups claim**, so `adminGroup` cannot match and nobody is promoted
  automatically: SSO users arrive as plain users with no domains, and you grant access afterwards.
  (Keycloak and similar can map groups, and then `adminGroup` works.)

Google does allow unregistered redirect URIs for *native* clients - `http://127.0.0.1:<port>`
loopback - which is a desktop-app allowance and does not apply to a fixed hostname like this one.

Rules the server enforces whatever the provider: only a **verified** email may link to an existing
account (an unverified one is the account-takeover path, so it is refused); a provisioned user
gets no domains unless the provider configures `defaultDomains`; and an SSO session is identical
to a password login, so per-domain access and the audit trail are unchanged. With no provider
configured, nothing about the login page changes.
