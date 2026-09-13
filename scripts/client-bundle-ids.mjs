#!/usr/bin/env node
/**
 * Single source of truth for the two ids that meet inside a client bundle.
 *
 * A DSH UI plugin's browser artifact is a closure-factory bundle whose first
 * line is `window.__ModuleLoader__.load({ id: <plugin id>, ... })`. The Web host
 * serves that artifact under the *package name* in `dsh.profile.bundles`, so the
 * stamped id must equal `package.json.name` or the browser registers the plugin
 * under an id the host never asks for.
 *
 * The shared build preset (`packages/client/tsdown.client.ts` in the rc.1
 * reference checkout) derives a package's client externals from the DSH
 * workspace manifest of the id it is called with — `workspaceManifest(id)`
 * looks the name up in `packages/<group>/<name>/package.json` and throws when
 * the name is unknown. This repository is not a package inside that workspace,
 * so the preset must be called with a real DSH package name; that name is the
 * SCAFFOLD id and exists only to satisfy the manifest lookup. It is never the
 * id a shipped artifact may carry.
 *
 * PUBLISHED_CLIENT_ID therefore comes from `package.json.name` (one source, no
 * duplicated literal), and SCAFFOLD_CLIENT_ID is the one build-time constant
 * both `tsdown.config.ts` and `scripts/patch-client-id.mjs` share.
 */

import { readFileSync } from 'node:fs'

/**
 * Build-time-only package id handed to the shared client preset so its
 * workspace-manifest lookup resolves. Must name a package that exists in the
 * DSH reference checkout (see above); never ship an artifact that still
 * carries it.
 */
export const SCAFFOLD_CLIENT_ID = '@deepseek-ai/dsh-client-ui-jobs'

/** The Loader id a published bundle must carry: this package's own name. */
export const PUBLISHED_CLIENT_ID = (() => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const name = manifest.name
  if (typeof name !== 'string' || name === '') {
    throw new Error('package.json declares no name, so the published client id is unknown')
  }
  if (name === SCAFFOLD_CLIENT_ID) {
    throw new Error(`package.json.name must not be the build scaffold id ${SCAFFOLD_CLIENT_ID}`)
  }
  return name
})()
