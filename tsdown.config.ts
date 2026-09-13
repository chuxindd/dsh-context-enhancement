import { pathToFileURL } from 'node:url'
import { PUBLISHED_CLIENT_ID, SCAFFOLD_CLIENT_ID } from './scripts/client-bundle-ids.mjs'

const { clientBundle } = await import(pathToFileURL(
  'C:/Users/chuxi/Documents/trae_projects/code/deepseek-harness-rc1-context/packages/client/tsdown.client.ts',
).href)

const libEntries = [
  'lib/types/index.js',
  'lib/types/task-state.js',
  'lib/types/task-state-basic.js',
  'lib/types/task-state-control.js',
  'lib/types/task-state-prompt.js',
  'lib/types/compaction-basic.js',
  'lib/types/tool-result-pruner.js',
]

const buildFaceConfig = clientBundle(SCAFFOLD_CLIENT_ID, libEntries)

/**
 * Stamp the published Loader id into the client bundle at generation time.
 *
 * The preset call above must use {@link SCAFFOLD_CLIENT_ID} because the preset
 * resolves this package's client externals through the DSH workspace manifest
 * of the id it is given, and this repository is not a package in that
 * workspace (see `scripts/client-bundle-ids.mjs`). The preset then writes that
 * scaffold id into the bundle's `__ModuleLoader__.load({ id })` banner, so a
 * build that stops after tsdown would emit an artifact the Web host never
 * loads. Rewriting the banner here — instead of only in a later patch step —
 * makes the emitted client.js correct by construction, so no build path can
 * leave a scaffold id in the banner.
 *
 * The patch step stays in the build chain for the rest of the artifact: the
 * preset also stamps its `id` argument into any inlined CSS style injector
 * (`tag.dataset.plugin`), which lives in the bundle body and therefore cannot
 * be reached from here.
 *
 * @param config - one config returned by the shared preset.
 * @returns the config with the published id in its banner, or the config as-is.
 * @throws {Error} when the client config's banner no longer carries the
 * scaffold id, so preset drift cannot silently ship an unidentifiable bundle.
 */
function stampPublishedClientId(config: Record<string, unknown>): Record<string, unknown> {
  if (config['name'] !== `${SCAFFOLD_CLIENT_ID}/client`) return config
  const outputOptions = (config['outputOptions'] ?? {}) as Record<string, unknown>
  const banner = outputOptions['banner']
  if (typeof banner !== 'string' || !banner.includes(SCAFFOLD_CLIENT_ID)) {
    throw new Error(
      `tsdown: the client config no longer carries the ${SCAFFOLD_CLIENT_ID} banner, `
      + `so the published Loader id ${PUBLISHED_CLIENT_ID} cannot be stamped`,
    )
  }
  return {
    ...config,
    outputOptions: { ...outputOptions, banner: banner.replaceAll(SCAFFOLD_CLIENT_ID, PUBLISHED_CLIENT_ID) },
  }
}

export default ({ env }: { env?: Record<string, unknown> }) =>
  buildFaceConfig({ env } as Parameters<typeof buildFaceConfig>[0]).map(stampPublishedClientId)
