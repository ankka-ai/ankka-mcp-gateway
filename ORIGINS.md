# Source origins

This repository has a fresh public history. This file records the origin and
publication rights of material that was transferred or vendored rather than
written directly in this repository.

Future entries must identify the source, copyright owner, license, publication
approval, review date, and material modifications. Do not include private
repository revisions or internal paths.

## Anti-slop Oxlint plugin

The source under `tools/oxlint/anti-slop/` was copied on 2026-08-28 from the
public `dmmulroy/anti-slop` repository at revision
`6d538555cb151d4121ed51a27db81890eacf8ae9`. It is licensed under the MIT
License, Copyright (c) 2026 Dillon Mulroy. The upstream rule tests were not
copied. The required license is retained at
`tools/oxlint/anti-slop/LICENSE`.

## Hosted installer

The implementation under `apps/installer/` was transferred from Ankka's
private product codebase on 2026-08-24. The copyright owner approved publishing
and relicensing it under Apache-2.0 for this repository.

The public version was adapted to the documented self-hosted Cloudflare
boundary. It excludes private history, credentials, signing material, generated
release output, private data, and Cloudflare account or resource identifiers.

## Brand assets

The Ankka wordmark and visual-token references were transferred from Ankka's
private product codebase on 2026-08-26. The copyright owner approved their use
in this Apache-2.0 repository.

No private product implementation, font files, private theme values, or
generated build output were transferred.

The Ankka favicon SVG was supplied by the repository maintainer on 2026-08-31
for inclusion in the gateway dashboard and hosted installer. It is retained
unchanged in `apps/admin/src/assets/ankka-icon.svg` and the fingerprinted
installer asset. This request authorizes those product uses; no separate asset
license or broader trademark permission was supplied. The SVG was reviewed for
embedded scripts, external references, and private metadata; none were present.

## @cfworker/json-schema license fallback

The file
`third_party/licenses/cfworker-json-schema-4.1.1-LICENSE.md` was copied on
2026-08-29 from the public `cfworker/cfworker` repository at revision
`5409fdc2bd144f68e8b28c61c71fcb16600000a6`. It is the upstream MIT license,
Copyright (c) 2020 Jeremy Danyow. The published
`@cfworker/json-schema@4.1.1` npm tarball declares MIT but omits the repository
license file, so the release license generator uses this reviewed copy.

## BigQuery icon

`apps/admin/src/assets/google-bigquery.svg` was copied on 2026-09-21 from
[Simple Icons](https://github.com/simple-icons/simple-icons/blob/b86d5c9a0bdd4f3f5c30898a63654dd32f39fd76/icons/googlebigquery.svg),
revision `b86d5c9a0bdd4f3f5c30898a63654dd32f39fd76`. Simple Icons contributors
publish the artwork under CC0 1.0 Universal, which permits redistribution;
the license is retained in `third_party/licenses/simple-icons-CC0-1.0.md`.
The only modification is a blue fill. Reviewed on 2026-09-21 for scripts,
external references, and private metadata; none were present. Google owns the
BigQuery brand and trademark; the icon identifies the supported connector.

## Provider connector icons

The files in `apps/admin/src/assets/connectors/` were obtained and reviewed on
2026-09-21 to identify their respective providers in the connector library:

- Airtable, Confluence, GitHub, GitLab, Google Drive, Google Sheets, Jira,
  Notion, Salesforce, Sentry, Slack, and Stripe: the corresponding SVGs from
  [Dashboard Icons](https://github.com/homarr-labs/dashboard-icons/tree/cf87d9bbd47792b20893f090ff48763fe874b05d/svg),
  revision `cf87d9bbd47792b20893f090ff48763fe874b05d`, published by Homarr Labs
  and contributors under Apache-2.0. The license permits redistribution and is
  retained in `third_party/licenses/dashboard-icons-Apache-2.0.txt`. Google
  Sheets has an added viewBox for scaling; all other files are unchanged.
- HubSpot, Intercom, and Linear: SVGs from
  [Simple Icons](https://github.com/simple-icons/simple-icons/tree/b86d5c9a0bdd4f3f5c30898a63654dd32f39fd76/icons),
  revision `b86d5c9a0bdd4f3f5c30898a63654dd32f39fd76`, by Simple Icons
  contributors under CC0 1.0 Universal. The retained license is
  `third_party/licenses/simple-icons-CC0-1.0.md`. Only fills were added for color
  and contrast on the dark background. Both Intercom regions share one icon.
- Ahrefs: the unchanged SVG favicon linked from the official homepage,
  `https://static.ahrefs.com/favicon.svg?v=2`.
- Gorgias: the unchanged PNG favicon linked from its official homepage,
  `https://cdn.prod.website-files.com/5e4ff204e7b6f80e402d407a/655f0a6ab7ecc73b0e8cbcad_Favicon%201.png`.

The Ahrefs and Gorgias assets remain the property of their respective providers;
no separate asset license was supplied. Their inclusion was requested by the
repository maintainer for provider identification, not as a grant of broader
redistribution or trademark rights. All provider marks remain the property of
their owners. SVGs were reviewed for scripts, external references and private
metadata; none were present. Assets are served locally without provider requests.

## Other repository code

Material not listed above was written for this public repository. Published npm
dependencies are not vendored; their licenses are described in
`THIRD_PARTY_NOTICES.md` and the lockfile.
