# Meta Ads

Connect Meta's official MCP server to read Facebook and Instagram advertising
reports through your self-hosted gateway. The connection is shared with the
team members you assign to this source, so connect an identity with access only
to the ad accounts you intend to share.

> Implementation reviewed 2026-09-24. Synthetic tests cover the OAuth policy,
> permission checks, credential custody, and SQLite callback replay protection.
> Meta's advertised dynamic registration rejects custom clients. Use your own
> Meta developer app and its public App ID. An authenticated Meta/Cloudflare
> canary is still required to qualify consent, reporting, token refresh,
> revocation, and upstream mutation denial. This is not a released Source Catalog preset.

## Connect a test account

1. Create or reuse your [Meta developer app](https://developers.facebook.com/apps)
   and add the **Create & manage ads with ads MCP server** use case. Confirm that
   your app and test identity are eligible for Ads MCP access.
2. Open **Add connector → Custom**. Name it **Meta Ads** and use the exact URL
   `https://mcp.facebook.com/ads`.
3. Inspect it, save the OAuth draft, and install it. Nothing is enabled or
   assigned while you connect.
4. In your app's **Facebook Login for Business** settings, register the exact
   callback shown on the connector:
   `https://<management-hostname>/__ankka/source-oauth/callback`.
   Enter the app's public numeric **Meta App ID** in the gateway. No app secret
   or access token is accepted. The App ID is not saved in the connector draft;
   it is bound to the short-lived authorization attempt and imported with the
   connection metadata only after consent and permission verification.
5. Choose **Authorize connector** and complete Meta's consent flow. The gateway
   requests only `ads_mcp_management` and `ads_read`.
6. Return to the gateway and check the connection. Review the actual synced
   tools and enable only the reporting tools you need. Documented candidates
   include `ads_get_ad_entities`, `ads_get_opportunity_score`, and
   `ads_insights_performance_trend`; their actual availability and permissions
   must be checked on your account.
7. Qualify the connection in the test account before assigning it to your team.

The `undefined: failed to register oauth client` error in Cloudflare's automatic
setup does not indicate a missing Ankka client secret. Meta's advertised
registration endpoint returns `invalid_client_metadata` and “Dynamic registration
is not available for this client” for custom-client requests. The gateway uses
your pre-registered App ID and skips that endpoint. Cloudflare's automatic setup
cannot configure your Meta app or register your gateway callback for you.

No Meta app secret, manually supplied bearer token, or provider credential is
entered into Ankka's hosted installer. Source authorization and permission
inspection run in your gateway Worker, and accepted credentials are imported
directly into your Cloudflare account. Source removal follows the existing
receipt-owned lifecycle. Remove the provider app grant in Meta as well if you
want to revoke it at the provider; gateway removal does not revoke that grant.

## Read-only enforcement

Meta requires `ads_mcp_management` and either `ads_read` or `ads_management`.
The gateway selects the read combination. It does not request
`ads_management`, `catalog_management`, `business_management`, or page/Instagram
management permissions. Tool selection remains an exact allowlist; new tools
are never enabled automatically.

Before importing a token, the gateway checks any scope reported in the token
response and makes a bounded GET to
`https://graph.facebook.com/v26.0/me/permissions`, with the token in the
Authorization header. This check also covers responses that omit OAuth scope
and app grants left over from an earlier login. The response must confirm both
required permissions and no additional granted permission except Facebook's
default `public_profile` identity permission. Declined or expired permissions
do not grant authority. Missing, duplicate, malformed, paginated, oversized or
unavailable evidence fails closed. The gateway follows no redirects or pages.

If a previous connection granted write permissions, remove that grant in Meta
and authorize again with the restricted permission set. Do not bypass a refused
grant by manually importing a broader token in Cloudflare. A denied connection
does not revoke the Meta consent you just completed; you can remove it in Meta.

The provider permission check runs at connection time. Cloudflare subsequently
owns token refresh. A live canary must establish that renewal preserves the
restricted grant; the gateway does not continuously re-audit Meta permissions.
Changing provider grants outside this flow requires renewed review.

## Reviewed OAuth boundary

Meta's public discovery advertises public-client dynamic registration, PKCE
S256, authorization-code and refresh-token grants. Advertising registration does
not make it available to arbitrary clients: two synthetic probes on 2026-09-24,
including a minimal registration request, were refused. The gateway accepts only
this issuer and these exact endpoints for the exact Meta Ads resource:

| Purpose | URL |
| --- | --- |
| Issuer | `https://www.facebook.com/ads` |
| Authorization | `https://www.facebook.com/v26.0/dialog/oauth` |
| Token exchange | `https://graph.facebook.com/v26.0/oauth/access_token` |
| Registration | `https://mcp.facebook.com/.well-known/register/ads` |

Endpoint or API-version changes require review and an update. This exception
does not permit other providers to send credentials across arbitrary origins.
The registration endpoint is checked as metadata but never called for Meta.
Other providers retain their existing dynamic-registration flow; the Meta App
ID parameter is rejected for them. Tokens and permission responses are never
saved in Durable Object state or logged. Callback attempts are consumed before token exchange and cannot be
replayed after a process restart.

Meta also documents Employee-role system-user tokens. Those are not a
credential-entry mode in this gateway flow. Account eligibility and your app's
public-client PKCE and refresh compatibility still need live proof.
Meta's optional MCP action rules are in limited availability; they can reinforce
read-only access but are not assumed to exist for every team.

## Evidence and validation

- [Official Meta setup and permissions](https://developers.facebook.com/documentation/ads-commerce/ads-ai-connectors/ads-mcp-server/ads-mcp-server-get-started)
- [Reporting tools](https://developers.facebook.com/documentation/ads-commerce/ads-ai-connectors/ads-mcp-server/ads-mcp-server-tools-comprehensive-reporting)
- [Inspecting granted Facebook permissions](https://developers.facebook.com/documentation/facebook-login/guides/permissions/request-revoke)
- [Meta MCP rules and availability](https://developers.facebook.com/documentation/ads-commerce/ads-ai-connectors/ads-mcp-server/ads-mcp-server-rules-best-practices)
- [Protected resource metadata](https://mcp.facebook.com/.well-known/oauth-protected-resource/ads)
- [Authorization server metadata](https://www.facebook.com/.well-known/oauth-authorization-server/ads)

Focused checks: `node --test test/worker-meta-ads-oauth.test.mjs` and
`node --test apps/installer/test-runtime/source-oauth.test.mjs`. Run
`npm run check:fast` for the development gate and the full `npm run check` in CI
before merge. No real account data or provider credentials belong in fixtures.
