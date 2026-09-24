# Meta Ads

Connect Meta's official MCP server to read Facebook and Instagram advertising
reports through your self-hosted gateway. The connection is shared with the
team members you assign to this source, so connect an identity with access only
to the ad accounts you intend to share.

> Implementation reviewed 2026-09-24. Synthetic tests cover the OAuth policy,
> permission checks, credential custody, and SQLite callback replay protection.
> An authenticated Meta/Cloudflare canary is still required to qualify dynamic
> registration, real reporting, token refresh, revocation, and upstream mutation
> denial. This is not a released Source Catalog preset.

## Connect a test account

1. Open **Add connector → Custom**. Name it **Meta Ads** and use the exact URL
   `https://mcp.facebook.com/ads`.
2. Inspect it, save the OAuth draft, and install it. Nothing is enabled or
   assigned while you connect.
3. Choose **Authorize connector** and complete Meta's consent flow. The gateway
   requests only `ads_mcp_management` and `ads_read`.
4. Return to the gateway and check the connection. Review the actual synced
   tools and enable only the reporting tools you need. Documented candidates
   include `ads_get_ad_entities`, `ads_get_opportunity_score`, and
   `ads_insights_performance_trend`; their actual availability and permissions
   must be checked on your account.
5. Qualify the connection in the test account before assigning it to your team.

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
S256, authorization-code and refresh-token grants. The gateway accepts only this
issuer and these exact endpoints for the exact Meta Ads resource:

| Purpose | URL |
| --- | --- |
| Issuer | `https://www.facebook.com/ads` |
| Authorization | `https://www.facebook.com/v26.0/dialog/oauth` |
| Token exchange | `https://graph.facebook.com/v26.0/oauth/access_token` |
| Registration | `https://mcp.facebook.com/.well-known/register/ads` |

Endpoint or API-version changes require review and an update. This exception
does not permit other providers to send credentials across arbitrary origins.
Tokens and permission responses are never saved in Durable Object state or
logged. Callback attempts are consumed before token exchange and cannot be
replayed after a process restart.

Meta also documents manually registered apps and Employee-role system-user
tokens. Those are not credential-entry modes in this gateway flow. Account
eligibility and registration response compatibility still need live proof.
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
