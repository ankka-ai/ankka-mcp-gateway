export function bigQueryPreflightGuidance(code: string): string {
  if (code === 'bigquery_google_key_invalid') return 'The Google service-account key could not be read or used to sign in. Choose the original JSON key downloaded from Google Cloud.'
  if (code === 'bigquery_google_auth_unavailable') return 'The gateway could not complete the request to Google’s sign-in service. Check Google service status before trying again.'
  if (code === 'bigquery_google_auth_response_invalid') return 'Google returned a sign-in response the gateway could not validate. Check the gateway release before trying again.'
  if (code.startsWith('bigquery_google_auth_http_')) {
    const status = code.slice(-3)
    return `Google service-account sign-in failed (HTTP ${status}). ${['400', '401', '403'].includes(status)
      ? 'Check that the service account and its key are active.' : 'Check Google service status before trying again.'}`
  }
  if (code.startsWith('bigquery_google_query_http_')) {
    const status = code.slice(-3)
    return `The BigQuery connection check failed (HTTP ${status}). ${['400', '401', '403', '404'].includes(status)
      ? 'Check the query project ID, enable the BigQuery API and MCP service, and grant the service account BigQuery Job User and MCP User in that project.'
      : 'Check Google service status and your project’s quotas before trying again.'}`
  }
  if (code === 'bigquery_google_query_rejected') return 'Google did not confirm the test query. Check the query project ID, enable the BigQuery API and MCP service, and grant the service account BigQuery Job User and MCP User in that project.'
  if (code === 'bigquery_google_query_unavailable') return 'The BigQuery connection check did not complete. Check Google service status before trying again.'
  if (code === 'bigquery_google_response_invalid') return 'Google returned a query response the gateway could not validate. Check the gateway release before trying again.'
  if (code === 'bigquery_runtime_unavailable') return 'This gateway could not load a valid BigQuery bridge deployment. Check the gateway release and configuration before trying again.'
  return 'The gateway could not start BigQuery bridge deployment. Check the gateway release and configuration before trying again.'
}
