# Single sign-on at SIRC (Keycloak)

QA-Board signs in with SIRC's Keycloak the way EMMA does (`EMMA_Client/docs/SSO.md`): OpenID Connect,
Authorization Code + PKCE, confidential client, handled by the backend. The generic docs are on the website:
[Sign-in and single sign-on](https://samsung.github.io/qaboard/docs/backend-admin/sign-in).

LDAP stays: the Keycloak realm is federated to the same Active Directory, so an SSO sign-in finds the user's existing
account by its sAMAccountName (`QABOARD_OIDC_MATCH_USERS=username`), and nobody gets a second account. The
password form stays on the sign-in page, below the SSO button.

## 1. Ask IT for the clients
Portal: <https://keycloak-selfservice.k8s.transchip.com> → **New Request** → **OpenID Connect**. Provisioning takes
1–3 business days. One request for production, one for staging (separate clients and secrets).

> Redirect URIs are immutable in Keycloak: changing one later is a Jira ticket. Get them right.

| Field | Value |
| --- | --- |
| Organization | SIRC — QA-Board (algorithm results) |
| Protocol | OpenID Connect |
| Client type | Confidential |
| Grant types | Authorization Code only, PKCE S256 |

| Mapper | Claim | Why |
| --- | --- | --- |
| Username | `preferred_username` | default |
| Email | `email` | default |
| **sAMAccountName** | `samaccountname` | **the join key**: QA-Board's user names are the sAMAccountNames of LDAP sign-ins |
| Groups | `groups` | recorded in the audit log, not used for access |

Ask for `samaccountname` **in the ID token** (not only in userinfo), as for EMMA.

| | Production | Staging |
| --- | --- | --- |
| Client name | `qaboard` | `qaboard-staging` |
| Redirect URIs | `https://qa/api/v1/auth/oidc/callback`<br>`https://qa/*` | `https://alginfra1/api/v1/auth/oidc/callback`<br>`https://alginfra1/*` |
| Web origins | `https://qa` | `https://alginfra1` |

**The redirect URI must be on the hostname users use**, the one of `QABOARD_URL` (`https://qa`): the sign-in's
handshake is in a cookie of that host. If some users open `https://qa.transchip.com`, they can still sign in with a
password, but SSO from there fails with "took too long or started elsewhere". Confirm the hostnames (and whether
staging is served over https) before submitting.

You get back: the **realm issuer URL** (e.g. `https://keycloak.transchip.com/realms/<realm>`), the client id and
the **client secret**. Ask for the issuer if the email doesn't have it.

## 2. Configure
In `deployments/sirc/sirc.yml` (`services.backend.environment`) and `deployments/sirc/values.yaml` (`config`):

```yaml
- QABOARD_OIDC_ISSUER=https://keycloak.transchip.com/realms/<realm>
- QABOARD_OIDC_CLIENT_ID=qaboard
- QABOARD_OIDC_USERNAME_CLAIM=samaccountname
- QABOARD_OIDC_MATCH_USERS=username
- QABOARD_OIDC_BUTTON_LABEL=Sign in with your Windows account
```

The secret goes in the `.env` of the host (or the chart's secret): `QABOARD_OIDC_CLIENT_SECRET=...`.
`docker-compose.yml` forwards it.

## 3. Check from the server
```bash
docker compose exec backend qaboard-admin check-sign-in
docker compose exec backend qaboard-admin check-sign-in --provider ldap --user arthurf
```

What usually breaks, in order:
1. **The backend can't reach Keycloak.** The image goes through `webproxy.transchip.com` (`PROXY_URL` in
   `sirc.yml`/`prod.yml`): add the Keycloak host to `NO_PROXY` there if the proxy refuses it. TLS errors: the
   image trusts the SIRC CA (`CA_CERT_URL`, and `REQUESTS_CA_BUNDLE` in `backend/Dockerfile`). Never disable TLS
   verification: the same connection fetches the keys that sign the ID tokens.
2. **The issuer doesn't match** the discovery document's (a trailing slash, the realm's name).
3. **The redirect URI isn't registered**: Keycloak's "Invalid parameter: redirect_uri". The check says which
   near-misses (http/https, a trailing slash) Keycloak accepts.

Then sign in on staging with SSO, and check in **Admin → Audit** that the `auth.login` event is for your existing
user (`provider: sso`), with your `groups`.

## Rollback
Remove `QABOARD_OIDC_ISSUER` (or set it empty) and redeploy: the SSO button disappears, LDAP sign-ins keep working,
and so do the sessions opened with SSO, until they expire.

## Break-glass
`arthurf` is an admin from `QABOARD_ADMINS`, whatever the database says. If both Keycloak and LDAP are down, create a
local admin from the host, and sign in at `https://qa/login?local=1`:

```bash
docker compose exec backend qaboard-admin create-admin qaboard-admin --password
```
