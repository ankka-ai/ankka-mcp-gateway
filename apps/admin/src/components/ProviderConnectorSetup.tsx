import { Disclosure } from './Disclosure'
import type { NativeConnectorRecipe } from '../connectors/native-recipes'
import { NATIVE_RECIPE_STATUS_LABELS } from '../connectors/native-recipes'
import { StatusPill } from './StatusPill'

export function ProviderConnectorSetup({ recipe }: { recipe: NativeConnectorRecipe }) {
  return <article aria-label={`${recipe.displayName} connector requirements`}>
    <StatusPill tone="attention">{NATIVE_RECIPE_STATUS_LABELS[recipe.status]}</StatusPill>
    <p role="status" className="mt-3 text-sm leading-6 text-kumo-subtle">{recipe.status === 'manual_setup'
      ? 'This connector needs a sign-in method your gateway does not support yet.'
      : recipe.status === 'provider_permission_required'
        ? 'This connector needs permission from the provider before you can connect it through your gateway.'
        : 'This connector is not available to add yet. Compatibility and read-only access through your gateway still need verification.'}</p>
    <p className="mt-3 text-xs text-kumo-subtle">Provider endpoint</p>
    <code className="mt-1 block select-all break-all text-xs leading-5 text-kumo-default">{recipe.endpoint}</code>
    <div className="mt-4 grid gap-5 lg:grid-cols-2">
      <section aria-label="Required provider controls">
        <h3 className="text-xs font-semibold text-subheading">Required provider controls</h3>
        <ul className="mt-2 list-disc space-y-2 pl-4 text-xs leading-5 text-kumo-subtle">
          {recipe.upstreamControls.map((control) => <li key={control}>{control}</li>)}
        </ul>
        {recipe.requiredScopes.length ? (
          <p className="mt-3 break-words text-xs leading-5 text-kumo-default">Scopes: {recipe.requiredScopes.join(', ')}</p>
        ) : null}
        <p className="mt-2 text-xs leading-5 text-kumo-subtle">{recipe.scopeNote}</p>
      </section>
      <section aria-label="Before connecting">
        <h3 className="text-xs font-semibold text-subheading">Before connecting</h3>
        <ol className="mt-2 list-decimal space-y-2 pl-4 text-xs leading-5 text-kumo-subtle">
          {recipe.setupSteps.map((step) => <li key={step}>{step}</li>)}
        </ol>
      </section>
    </div>
    <Disclosure className="mt-4 text-xs leading-5 text-kumo-subtle" label="Remaining verification">
      <ul className="mt-2 list-disc space-y-1 pl-4">
        {recipe.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}
      </ul>
    </Disclosure>
    <div className="mt-4 flex flex-wrap gap-x-4 gap-y-2" aria-label="Provider documentation">
      {recipe.evidenceUrls.map((url, index) => (
        <a key={url} href={url} target="_blank" rel="noopener noreferrer" className="text-xs text-brand underline underline-offset-2">
          Provider reference {index + 1}
        </a>
      ))}
    </div>
  </article>
}
