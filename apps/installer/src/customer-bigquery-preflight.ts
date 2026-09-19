import * as v from 'valibot';
import { createGoogleAuthorization } from '../../read-only-connectors/src/google-auth';
import { readBigQueryText } from './customer-bigquery-contract';

type FailureCode = 'bigquery_google_key_invalid' | 'bigquery_google_auth_unavailable' |
  'bigquery_google_auth_response_invalid' | `bigquery_google_auth_http_${number}` |
  'bigquery_google_query_unavailable' | `bigquery_google_query_http_${number}` |
  'bigquery_google_query_rejected' | 'bigquery_google_response_invalid' |
  'bigquery_runtime_unavailable' | 'bigquery_setup_failed';

/** Only server-authored codes and HTTP statuses may survive a credential check. */
export class BigQueryPreflightError extends Error {
  constructor(readonly code: FailureCode) { super(code); this.name = 'BigQueryPreflightError'; }
}

const googleResult = v.object({ result: v.object({ isError: v.optional(v.boolean()),
  content: v.array(v.object({ type: v.literal('text'), text: v.string() })),
}) });
const googleRpcError = v.object({ error: v.object({ code: v.pipe(v.number(), v.safeInteger()) }) });
const completedQuery = v.object({ jobComplete: v.literal(true),
  errors: v.optional(v.pipe(v.array(v.unknown()), v.maxLength(0))),
});

/** Check Google before provisioning. Provider text and credentials never become diagnostics. */
export async function checkBigQueryConnection(serviceAccountJson: string, queryProjectId: string, fetcher: typeof fetch) {
  let tokenRequested = false;
  let tokenStatus: number | null = null;
  let googleHeaders: Readonly<Record<string, string>>;
  try {
    const authorize = createGoogleAuthorization(serviceAccountJson, 'bigquery');
    googleHeaders = await authorize(async (input, init) => {
      tokenRequested = true;
      const response = await fetcher(input, init);
      tokenStatus = response.status;
      return response;
    });
  } catch {
    if (!tokenRequested) throw new BigQueryPreflightError('bigquery_google_key_invalid');
    if (tokenStatus === null) throw new BigQueryPreflightError('bigquery_google_auth_unavailable');
    if (tokenStatus !== 200) throw new BigQueryPreflightError(`bigquery_google_auth_http_${tokenStatus}`);
    throw new BigQueryPreflightError('bigquery_google_auth_response_invalid');
  }

  let response: Response;
  try {
    response = await fetcher('https://bigquery.googleapis.com/mcp', {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(8_000),
      headers: { ...googleHeaders, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
        name: 'execute_sql_readonly', arguments: { projectId: queryProjectId, query: 'SELECT 1 AS bridge_ok' },
      } }),
    });
  } catch { throw new BigQueryPreflightError('bigquery_google_query_unavailable'); }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new BigQueryPreflightError(`bigquery_google_query_http_${response.status}`);
  }

  let result: v.InferOutput<typeof googleResult>['result'];
  try {
    const reply: unknown = JSON.parse(await readBigQueryText(response.body, 512 * 1024));
    if (v.safeParse(googleRpcError, reply).success) throw new BigQueryPreflightError('bigquery_google_query_rejected');
    result = v.parse(googleResult, reply).result;
  } catch (error) {
    if (error instanceof BigQueryPreflightError) throw error;
    throw new BigQueryPreflightError('bigquery_google_response_invalid');
  }
  // MCP errors may contain plain text, so check isError before trying to parse a query result.
  if (result.isError) throw new BigQueryPreflightError('bigquery_google_query_rejected');
  let completed: v.SafeParseResult<typeof completedQuery>;
  try { completed = v.safeParse(completedQuery, JSON.parse(result.content.map((part) => part.text).join('\n'))); }
  catch { throw new BigQueryPreflightError('bigquery_google_response_invalid'); }
  if (!completed.success) throw new BigQueryPreflightError('bigquery_google_query_rejected');
}
