import ahrefs from '../assets/connectors/ahrefs.svg'
import airtable from '../assets/connectors/airtable.svg'
import confluence from '../assets/connectors/confluence.svg'
import github from '../assets/connectors/github-light.svg'
import gitlab from '../assets/connectors/gitlab.svg'
import googledrive from '../assets/connectors/google-drive.svg'
import googlesheets from '../assets/connectors/google-sheets.svg'
import gorgias from '../assets/connectors/gorgias.png'
import hubspot from '../assets/connectors/hubspot.svg'
import intercom from '../assets/connectors/intercom.svg'
import jira from '../assets/connectors/jira.svg'
import linear from '../assets/connectors/linear.svg'
import meta from '../assets/connectors/meta.svg'
import notion from '../assets/connectors/notion-light.svg'
import salesforce from '../assets/connectors/salesforce.svg'
import sentry from '../assets/connectors/sentry-light.svg'
import slack from '../assets/connectors/slack.svg'
import stripe from '../assets/connectors/stripe.svg'

interface ProviderIconMap {
  readonly [providerId: string]: string
}

export const PROVIDER_ICONS: ProviderIconMap = {
  'ahrefs': ahrefs,
  'airtable': airtable,
  'confluence': confluence,
  'github': github,
  'gitlab': gitlab,
  'google-drive': googledrive,
  'google-sheets': googlesheets,
  'gorgias': gorgias,
  'hubspot': hubspot,
  'intercom-eu': intercom,
  'intercom-us': intercom,
  'jira': jira,
  'linear': linear,
  'meta-ads': meta,
  'notion': notion,
  'salesforce': salesforce,
  'sentry': sentry,
  'slack': slack,
  'stripe': stripe,
}
