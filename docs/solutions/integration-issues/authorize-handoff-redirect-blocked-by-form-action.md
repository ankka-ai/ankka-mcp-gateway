---
title: The remote authorize page's redirect to the provider was blocked by its own form-action policy
date: 2026-10-24
module: gateway worker
problem_type: integration_issue
component: api_layer
severity: medium
symptoms:
  - "Continue to provider does nothing"
  - "Sending form data to '…/api/mcp/authorize/…' violates the following Content Security Policy directive: \"form-action 'self'\". The request has been blocked."
  - "diagnose_mcp_source shows authorization stage provider_consent, status waiting"
root_cause: config_error
resolution_type: code_fix
applies_when:
  - a gateway page posts a form whose answer navigates to another origin
  - an agent hands a person the authorize_mcp_source URL and nothing happens after the click
tags: [oauth, csp, form-action, browser, authorize-handoff]
---

## Problem

From the `authorize_mcp_source` handoff page, selecting **Continue to provider**
left the browser on the same page. The gateway had already started the sign-in
(`diagnose_mcp_source` reported `provider_consent`), so the post itself
succeeded. The console showed the `form-action 'self'` violation above.

## Cause

The page is served with `form-action 'self'`, and the post answered with a 303
to the provider's authorization endpoint. Browsers apply `form-action` to
redirects that answer a form submission, so the cross-origin redirect was
dropped. The dashboard path was unaffected: it starts the sign-in with `fetch`
and navigates with `window.location`, which `form-action` does not govern.

## Fix

The post now answers with a page under the same policy that continues to the
provider through a `<meta http-equiv="refresh">` and a fallback link. Neither
is a form submission, so the strict policy stays in place. The
`management MCP hands provider consent to the browser` test asserts the page
continues to the provider rather than redirecting.

## Prevention

Do not answer a form on a `form-action 'self'` page with a redirect to another
origin. Answer with a page that links or refreshes to it, or widen
`form-action` deliberately.
