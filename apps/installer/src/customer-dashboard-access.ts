import * as v from 'valibot';
import { readCustomerGatewayOwnershipState, type CustomerGatewayOwnershipStorage } from './customer-gateway-ownership-state';
import { CustomerStage2DurableStatePort } from './customer-stage2-durable-state';
import { parseCustomerStage2Journal, type CustomerStage2Journal } from './customer-stage2-journal';
import { verifyStaticDeployPlanIntegrity } from './schema';

const identifier = v.pipe(v.string(), v.regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u));

interface DashboardEnvironment {
  CLOUDFLARE_ACCOUNT_ID: string; CLOUDFLARE_ZONE_ID: string; ANKKA_INSTALL_ID: string;
  ANKKA_WORKER_NAME: string; ANKKA_MANAGEMENT_HOSTNAME: string; CF_ACCESS_AUD: string;
}

/** Resolve only the dashboard application and policy recorded by this installation. */
export async function customerDashboardAccessTarget(storage: DurableObjectStorage & CustomerGatewayOwnershipStorage, env: DashboardEnvironment) {
  const ownership = await readCustomerGatewayOwnershipState(storage);
  if (!ownership.serializedPlan) return null;
  return dashboardAccessTargetFromReceipt(ownership.serializedPlan, await new CustomerStage2DurableStatePort(storage).read(), env);
}

export async function dashboardAccessTargetFromReceipt(serializedPlan: string, receipt: CustomerStage2Journal | null, env: DashboardEnvironment) {
  const plan = await verifyStaticDeployPlanIntegrity(JSON.parse(serializedPlan));
  const journal = parseCustomerStage2Journal(receipt);
  if (!journal || journal.identity.accountId !== env.CLOUDFLARE_ACCOUNT_ID ||
      journal.identity.zoneId !== env.CLOUDFLARE_ZONE_ID || journal.identity.installId !== env.ANKKA_INSTALL_ID ||
      journal.identity.workerName !== env.ANKKA_WORKER_NAME || journal.identity.planId !== plan.planId ||
      journal.identity.planHash !== plan.planHash || plan.managementOwnershipMarker !== env.ANKKA_INSTALL_ID ||
      plan.gatewayConfiguration.managementHostname !== env.ANKKA_MANAGEMENT_HOSTNAME) return null;
  const application = journal.actions.find(action => action.name === 'management_access_application');
  const policy = journal.actions.find(action => action.name === 'management_admin_policy');
  if (application?.phase !== 'verified' || policy?.phase !== 'verified') return null;
  const app = v.parse(v.strictObject({ applicationId: identifier, aud: v.string() }), application.locator);
  const rule = v.parse(v.strictObject({ policyId: identifier }), policy.locator);
  const appResource = plan.managementResources.find(resource => resource.kind === 'management_access_application');
  const policyResource = plan.managementResources.find(resource => resource.kind === 'management_access_policy');
  if (!appResource || !policyResource || app.aud !== env.CF_ACCESS_AUD) return null;
  return {
    applicationId: app.applicationId, policyId: rule.policyId, policyName: policyResource.name,
    applicationName: appResource.name, hostname: env.ANKKA_MANAGEMENT_HOSTNAME, aud: app.aud,
    allowedIdps: journal.identityProviderIds,
  };
}
