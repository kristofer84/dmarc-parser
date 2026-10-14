/**
 * Setup presets for the identity providers an operator is most likely to add.
 *
 * A preset exists to replace four fields typed from memory with one pick and one paste, so every
 * entry has to be true, not merely plausible. Two rules keep it that way:
 *
 *  - Only providers that publish an OpenID Connect **discovery document** belong here. The server
 *    fetches `<issuer>/.well-known/openid-configuration` and reads the endpoints out of it, so a
 *    provider without one cannot be configured at all. **GitHub is deliberately absent** and must
 *    stay out: it is plain OAuth 2.0 with no `id_token` and no discovery document, and the server
 *    requires an `id_token` (`idTokenExpected: true`) before it will even read the claims. Adding
 *    it "helpfully" would produce a provider that discovery can never resolve.
 *  - `issuerTemplate` is copied from the provider's own discovery document (`issuer`), not from
 *    the URL of a login page. Anything that cannot be stated that precisely is not listed.
 *
 * A `{placeholder}` is left in place in the form on purpose: the operator replaces it with the
 * value their deployment actually uses, and the form refuses to save while any braces remain.
 */
export interface IdpPreset {
  id: string;
  label: string;
  /** May contain one or more `{placeholder}` tokens, all of which need a value. */
  issuerTemplate: string;
  /** What the operator replaces the placeholder with - shown next to the issuer field. */
  placeholderHint?: string;
  scopes: string;
  /** Where the client, its secret and its redirect URI are created. */
  consoleUrl: string;
  consoleLabel: string;
  /** Only the things that cost time: issuer shape, console path, provider-specific traps. */
  notes: string[];
}

export const IDP_PRESETS: IdpPreset[] = [
  {
    id: 'google',
    label: 'Google',
    issuerTemplate: 'https://accounts.google.com',
    scopes: 'openid email profile',
    consoleUrl: 'https://console.cloud.google.com/apis/credentials',
    consoleLabel: 'Google Cloud console -> APIs & Services -> Credentials',
    notes: [
      'Create an OAuth client ID of type Web application, then add the callback URL under ' +
        'Authorized redirect URIs. It is matched exactly - scheme, host, path and all.',
      'The issuer is exactly https://accounts.google.com: no trailing slash and no path, even ' +
        'though the authorization endpoint lives under /o/oauth2/v2/auth.',
      'A consent screen still in Testing admits only the accounts listed as test users; everyone ' +
        'else is refused with access_denied. Publish the app, or add the account as a test user.',
    ],
  },
  {
    id: 'entra',
    label: 'Microsoft Entra ID',
    issuerTemplate: 'https://login.microsoftonline.com/{tenant}/v2.0',
    placeholderHint: 'your directory (tenant) ID or a verified domain name, not the client ID',
    scopes: 'openid email profile',
    consoleUrl: 'https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade',
    consoleLabel: 'Entra admin center -> App registrations',
    notes: [
      'Tenant-scoped on purpose: `common` (and `organizations`) lets any Entra tenant sign in, ' +
        'and the discovery document it returns reports the literal issuer template ' +
        'https://login.microsoftonline.com/{tenantid}/v2.0, so what the tokens carry depends on ' +
        'who signed in. Naming one directory keeps the issuer a single known value.',
      '{tenant} is the Directory (tenant) ID or a verified domain name. The Application (client) ' +
        'ID is a different value and does not belong in this URL.',
      'Register the callback URL under Authentication -> Add a platform -> Web. A redirect URI ' +
        'left on the SPA or Mobile platform is not used by a server-side code exchange.',
      'The v2.0 id_token has no email_verified claim, and this app links or provisions only from ' +
        'a verified email, so a first sign-in is refused with "has not verified this email ' +
        'address yet" even once discovery and the token exchange work.',
      'Client secrets are created under Certificates & secrets and expire (24 months at most). ' +
        'Logins then fail with AADSTS7000222 until a new secret is pasted here.',
    ],
  },
  {
    id: 'apple',
    label: 'Apple',
    issuerTemplate: 'https://appleid.apple.com',
    scopes: 'openid email name',
    consoleUrl: 'https://developer.apple.com/account/resources/identifiers/list/serviceId',
    consoleLabel: 'Apple Developer -> Certificates, Identifiers & Profiles -> Identifiers (Services IDs)',
    notes: [
      'The client secret is not a static string: it is a JWT you sign with the .p8 key (iss = Team ' +
        'ID, sub = Services ID, aud = https://appleid.apple.com) and Apple expires it, six months ' +
        'at the most. It has to be regenerated and rotated, so this provider needs more care than ' +
        'the others.',
      'Apple requires response_mode=form_post whenever a scope is requested, and then posts the ' +
        'authorization response; this app builds the authorize URL without it and its callback ' +
        'route answers GET only. Expect the flow to fail at the last step - test it before relying ' +
        'on it.',
      'The client ID is a Services ID, not the App ID, and the callback URL\'s domain has to be ' +
        'registered for Sign in with Apple on that identifier.',
      'Apple returns name and email only on the very first authorization; later sign-ins carry ' +
        'just the subject. A user who chose Hide My Email arrives as a @privaterelay.appleid.com ' +
        'address.',
    ],
  },
  {
    id: 'auth0',
    label: 'Auth0',
    issuerTemplate: 'https://{tenant}.auth0.com/',
    placeholderHint: 'your Auth0 tenant name, i.e. the *.auth0.com subdomain',
    scopes: 'openid profile email',
    consoleUrl: 'https://manage.auth0.com/#/applications',
    consoleLabel: 'Auth0 Dashboard -> Applications',
    notes: [
      'Keep the trailing slash. Auth0 reports its issuer with one and this app compares the two ' +
        'texts exactly, otherwise discovery fails with "discovered metadata issuer does not match ' +
        'the expected issuer".',
      'Create a Regular Web Application, not SPA or Native - those have no usable client secret - ' +
        'and put the callback URL under Allowed Callback URLs.',
      'On a custom domain the issuer is that domain, not the *.auth0.com tenant host.',
    ],
  },
  {
    id: 'okta',
    label: 'Okta',
    issuerTemplate: 'https://{org}.okta.com',
    placeholderHint: 'your Okta org subdomain, e.g. dev-123456 (or your custom domain)',
    scopes: 'openid profile email',
    consoleUrl: 'https://{org}-admin.okta.com/admin/apps/active',
    consoleLabel: 'Okta Admin Console -> Applications',
    notes: [
      'Two hostnames, and they differ: the OIDC issuer is <org>.okta.com while the admin console ' +
        'is <org>-admin.okta.com. Replace {org} in both. An EMEA cell ends in okta-emea.com, and ' +
        'a custom domain replaces both hosts.',
      'The bare org URL is the org authorization server, which cannot be customized. Custom ' +
        'scopes, claims or access policies need a custom authorization server, and its issuer ' +
        'gains a path: .../oauth2/<server id>, or the built-in .../oauth2/default.',
      'Add the callback URL to the application\'s Sign-in redirect URIs: Okta compares redirect ' +
        'URIs character for character and answers a 400 mismatch page otherwise.',
    ],
  },
  {
    id: 'authentik',
    label: 'Authentik',
    issuerTemplate: 'https://{host}/application/o/{slug}/',
    placeholderHint: 'your authentik hostname and the application slug, e.g. auth.example.com and console',
    scopes: 'openid profile email',
    consoleUrl: 'https://{host}/if/admin/#/core/providers',
    consoleLabel: 'authentik admin interface -> Applications -> Providers',
    notes: [
      'Two values to fill in: the authentik hostname and the application slug. The issuer ends ' +
        'with a slash, and the discovery document is served one level below it.',
      'Leave Issuer mode on the default per-provider setting. Global issuer mode reports the bare ' +
        'hostname as the issuer while still serving discovery under /application/o/<slug>/, so a ' +
        'client that appends /.well-known/ to the issuer gets a 404.',
      'Create the OAuth2/OpenID provider first, then an Application - the slug of that ' +
        'application is what appears in the issuer path. The callback URL goes into the ' +
        'provider\'s Redirect URIs and is matched strictly.',
    ],
  },
  {
    id: 'keycloak',
    label: 'Keycloak',
    issuerTemplate: 'https://{host}/realms/{realm}',
    placeholderHint: 'your Keycloak hostname and the realm name, e.g. sso.example.com and main',
    scopes: 'openid profile email',
    consoleUrl: 'https://{host}/admin/{realm}/console',
    consoleLabel: 'Keycloak admin console (that realm) -> Clients',
    notes: [
      'The issuer is the realm URL, never the server root: /realms/<realm>. Keycloak 17 and older ' +
        'served everything under /auth, so their issuers read https://<host>/auth/realms/<realm>.',
      'Turn Client authentication On so Keycloak issues a client secret. With it Off the client ' +
        'is public and the token endpoint rejects the secret this app sends.',
      'The callback URL needs an entry in that client\'s Valid redirect URIs; without one the ' +
        'sign-in stops with "Invalid parameter: redirect_uri" before anyone can log in.',
      'Keycloak reports email_verified: true only when an admin has ticked Email verified on the ' +
        'user, and this app links or provisions only from a verified address.',
    ],
  },
  {
    id: 'authelia',
    label: 'Authelia',
    issuerTemplate: 'https://{host}',
    placeholderHint: 'the hostname Authelia is served from with no path, e.g. auth.example.com',
    scopes: 'openid profile email',
    consoleUrl: 'https://www.authelia.com/configuration/identity-providers/openid-connect/clients/',
    consoleLabel: 'Authelia configuration.yml -> identity_providers.oidc.clients (documentation)',
    notes: [
      'There is no web console. The client is a block in configuration.yml and Authelia has to be ' +
        'restarted to read it, so the client exists before this form has anything to talk to.',
      'Set token_endpoint_auth_method: client_secret_post on the client. Authelia defaults to ' +
        'client_secret_basic, and this app authenticates by sending the secret in the request body.',
      'client_secret in the file is a hash of the secret, not the secret: generate it with ' +
        '`authelia crypto hash generate pbkdf2` and paste the plaintext into this form.',
      'The issuer is the hostname Authelia is reached on, with no trailing slash. A stray slash ' +
        'makes discovery report a different issuer and the login is refused.',
    ],
  },
  {
    id: 'pocket-id',
    label: 'Pocket ID',
    issuerTemplate: 'https://{host}',
    placeholderHint: 'the hostname Pocket ID is served from, its APP_URL, e.g. id.example.com',
    scopes: 'openid email profile',
    consoleUrl: 'https://{host}/settings/admin/oidc-clients',
    consoleLabel: 'Pocket ID -> Administration -> OIDC Clients',
    notes: [
      'The issuer is APP_URL exactly - no path, no trailing slash - and discovery echoes it back, ' +
        'so a slash here is refused as a mismatch.',
      'Create the client under Administration -> OIDC Clients and paste the callback URL into ' +
        'Callback URLs, where wildcards are allowed. The client secret is shown once.',
      'Pocket ID sends email_verified from the user\'s own record and this app links or provisions ' +
        'only from a verified address, so sign-in only works for a user whose email Pocket ID has ' +
        'verified.',
    ],
  },
  {
    id: 'clerk',
    label: 'Clerk',
    issuerTemplate: 'https://{instance}.clerk.accounts.dev',
    placeholderHint:
      'your Frontend API host: <slug> for development, or clerk.<your domain>.com in production',
    scopes: 'openid profile email',
    consoleUrl: 'https://dashboard.clerk.com/~/oauth-applications',
    consoleLabel: 'Clerk Dashboard -> OAuth applications',
    notes: [
      'The issuer is the instance\'s Frontend API URL: https://<slug>.clerk.accounts.dev in ' +
        'development, https://clerk.<your domain>.com in production. They are separate instances ' +
        'with separate credentials, so a development issuer and a production client do not mix.',
      'Create an OAuth application in the dashboard to get the Client ID and secret (shown once), ' +
        'and add the callback URL to its Redirect URIs.',
      'The host has to belong to an existing instance: the wrong publishable key or a typo in the ' +
        'slug answers host_invalid instead of a discovery document.',
    ],
  },
  {
    id: 'zitadel',
    label: 'ZITADEL',
    issuerTemplate: 'https://{host}',
    placeholderHint: 'your ZITADEL instance domain with no path, e.g. myinstance.zitadel.cloud',
    scopes: 'openid profile email',
    consoleUrl: 'https://{host}/ui/console',
    consoleLabel: 'ZITADEL Console -> Projects -> Applications',
    notes: [
      'The issuer is the instance domain and nothing else - no path. The console serves discovery ' +
        'at <issuer>/.well-known/openid-configuration.',
      'The application lives inside a project: Console -> Projects -> your project -> Applications ' +
        '-> New, type Web, and the callback URL goes into its Redirect URIs. With dev mode off ' +
        'they are matched exactly.',
      'Choose the Post authentication method (client secret in the request body), which is what ' +
        'this app sends. Basic or None leaves the token exchange unable to authenticate.',
      'The instance\'s custom domain is configured separately; until it is, tokens carry the ' +
        'default *.zitadel.cloud issuer rather than the domain you typed.',
    ],
  },
];
