# Add BigQuery

Open **Sources → Add connector → Connector library → BigQuery**
in a gateway release that includes this flow.
The bridge, its Google credential, and the Cloudflare connection belong to your
Cloudflare account. The hosted Ankka installer does not receive the Google key.

## Prepare Google

Create a dedicated service account with a JSON key and enable the BigQuery API
and BigQuery MCP service in the projects used for queries and metadata.

- Grant `roles/bigquery.jobUser` in the query/billing project.
- Grant `roles/mcp.toolUser` in the query project and each data project used for
  table discovery.
- Grant `roles/bigquery.dataViewer` on the selected datasets. Review inherited
  permissions and avoid broader data access, write roles, and destination write
  permissions.

The [Google authentication guide](BIGQUERY_GOOGLE_AUTH.md)
explains the IAM and read-only MCP boundaries. The dataset list limits metadata
discovery; Google IAM controls what SQL can read. The setup confirmation is an
operator acknowledgement, not an automated audit of effective IAM.

## Connect

1. Choose **Add connector → Connector library → BigQuery**, name the source,
   enter its query project, and list datasets as `project.dataset`, one per line.
2. Confirm that the dedicated Google identity and JSON key are ready. Continue
   to the fresh Cloudflare approval for this operation.
3. Back on your gateway, choose the JSON key file and select **Deploy and
   connect BigQuery**. The gateway checks Google with `SELECT 1 AS bridge_ok`,
   creates a protected bridge Worker, writes its key as a Worker secret, and
   configures the exact OAuth callback automatically.
4. In the source status card, open the recorded source in Cloudflare and
   authenticate it as the gateway operator. Keep **Require user auth** off.
   Once Cloudflare reports **Ready**, return to Sources and select **Renew
   consent and resume** to verify and attach the source to the Portal.
5. Grant the intended audience access in Cloudflare. See [Team access](TEAM_ACCESS.md).
   Source installation starts with nobody assigned.

The selected tools are `execute_sql_readonly`, `get_table_info`, and
`list_table_ids`. Queries run in the chosen query project. There is no required
query cost ceiling; normal Google query billing and quotas apply.

## Permissions and credential handling

The initial BigQuery operation uses `bigquery-add`: `zone-access.write`,
`mcp-portals.write`, `workers-scripts.write`, and `workers-routes.read`. Ordinary
source installation retains its existing two scopes. The final connection
resume uses ordinary source consent once the bridge is ready.
Bridge Access application checks, creation, and removal use the selected zone's
Access API, matching `zone-access.write`. Worker operations and MCP catalogue
sharing checks use the selected account.

The gateway exchanges the Cloudflare authorization code only after the
same-origin key upload. The grant remains in that callback's request memory,
is used for this operation, and is revoked/discarded afterward. The Google key
is never placed in a draft, cookie, Durable Object record, URL, or response. Its
only outbound destinations are the fixed Google authentication flow (a signed
assertion) and the exact child Worker's secret upload in the selected account.

Bridge code is embedded in the signed gateway release. The deployment disables
Worker logs, workers.dev, and previews before attaching its protected custom
domain. Managed OAuth allows only the recorded Cloudflare MCP server callback;
the bridge login policy admits the operator who prepared the action.

## Interrupted setup

If the initial Google check fails before bridge deployment, Sources shows
**BigQuery setup failed**, a fixed error code, and the next step. The failed
action is saved, so refreshing or reopening Sources preserves the explanation.
It is no longer shown as waiting for Cloudflare. No bridge resources were
created by that attempt. After correcting the issue, choose **Continue BigQuery
setup** for a new approval and key upload.

| Error code | What to check |
| --- | --- |
| `bigquery_google_key_invalid` | Use the original JSON key for an active, dedicated Google service account. The file or signing key could not be used. |
| `bigquery_google_auth_http_<status>` | Google refused the token request. For HTTP 400, 401, or 403, check that the service account and key are active. |
| `bigquery_google_query_http_<status>` | The BigQuery test request failed. For HTTP 400, 401, 403, or 404, check the query project ID, API/MCP enablement, and its BigQuery Job User and MCP User grants. |
| `bigquery_google_query_rejected` | Google returned an MCP error or did not confirm the test query. Check the query project and permissions. |
| `bigquery_google_auth_unavailable`, `bigquery_google_query_unavailable` | The request could not complete. Check Google service status before retrying. |
| `bigquery_google_auth_response_invalid`, `bigquery_google_response_invalid` | Google's response could not be validated. Check the gateway release; this code does not establish a permissions failure. |
| `bigquery_runtime_unavailable`, `bigquery_setup_failed` | The gateway could not start the bridge deployment. Check its release and configuration. |

Only fixed stage/error words and HTTP statuses are retained, never Google's
response text, the key, an access token, or exception details. Failures recorded
by older releases without these diagnostics cannot be reconstructed; a new
attempt on a release containing this change is needed to obtain the error code.

Use **Continue BigQuery setup** for an unstarted attempt, or the recorded resume
action after a failed deployment. A fresh approval is required; saved resource
receipts identify what can be checked and resumed. A successful Worker upload
is not repeated and does not require another key upload when finishing the
source connection.

To discard a setup that has not begun provisioning, choose **Remove source** on
its installation card or in its source details. This also works after a Google
connection check fails, after authorization expires, or after cancellation.
Removal needs no Cloudflare approval or management token: it atomically clears
the draft, its action history and its empty bridge record inside your gateway.
An unused approval can only be removed by the administrator who started it.
Old callbacks and resume links are rejected, including after you add the same
configuration again. You can also remove ordinary unused source drafts this way.

If a create request has an uncertain outcome, setup stops with its pending
receipt. Do not start another bridge with the same configuration or adopt a
resource based only on its name. Review the exact account resources before
reconciliation. An unknown create cannot be automatically resumed or removed;
keep the gateway's recovery state until the resources have been reconciled.
Rollback below the setup runtime remains blocked to preserve its receipts.

The source card identifies the pending resource when that detail is available.
Cloudflare request failures retain only the resource stage and HTTP status, or
an indication that no response was confirmed. Provider response bodies, request
URLs, and exception text are not retained in these diagnostics. This detail
does not clear an uncertain create or permit another attempt.

## Remove a failed setup

**Remove source** remains available on an unused failed draft even while another
source needs recovery. Removing that draft preserves the other source's action
and saved receipts.

If a BigQuery bridge was deployed but source discovery failed before attaching
it, **Remove source** starts one `bigquery-remove` Cloudflare approval with the
same scopes listed above. No Google key upload is needed. The management token
cannot delete Workers, so this cleanup needs the separate temporary grant.
The gateway verifies the saved ownership records, removes the domain and
secret-bearing Worker, then removes Access protection and the saved source.

An interrupted deletion retains its receipts: use **Continue removal** with
fresh consent. The old setup action cannot resume installation after cleanup
starts. An uncertain create or an already-attached source is outside this
failed-setup removal path and keeps its recovery records.

## Remove the gateway and its bridges

In a release with managed bridge removal, **Settings → Remove gateway** includes
BigQuery bridges in the first, gateway-hosted removal phase. The fresh approval
includes Workers permissions to verify each bridge's saved Worker version and
custom domain, including proving Worker absence for an application-only setup.
The gateway first verifies the full graph and refuses changed resources or a
bridge referenced by another MCP source.

Removal runs in bounded steps so multiple sources fit the
[Workers Free request limits](https://developers.cloudflare.com/workers/platform/limits/#subrequests).
The callback keeps its temporary grant only in memory and sends each signed
step to the same gateway. Saved progress contains no grant. Each fresh approval
rechecks the complete graph against its current receipts and configuration;
expired approval, an uncertain response, repeated progress, or an inventory
outside the bounded scan stops removal and withholds the final gateway handoff.

After removing the Portal and its owned sources, the gateway detaches each
bridge domain, deletes the Worker containing its Google key, and then removes
the bridge's Access application. Access stays in place until the Worker and
domain are confirmed absent. Only then can it issue the separate approval to
remove the gateway itself.

Known partial source receipts and interrupted Portal updates use the same
removal flow. An interrupted deletion keeps its exact receipt and progress;
return to Settings for fresh consent and resume. A lost create response without
a provider identity still requires manual reconciliation. Older releases that
cannot interpret bridge cleanup keep automatic gateway removal blocked.

Removing the bridge deletes its copy of the Google key. It does not revoke
the service-account key in Google; revoke that key there when you no longer need
it. Manually deployed bridges remain separate resources that you manage.

The manual deployment instructions remain available for older gateways. The
availability of **BigQuery** in the **Connector library** indicates that the installed
release contains the flow; main-branch documentation alone does not establish live availability.
