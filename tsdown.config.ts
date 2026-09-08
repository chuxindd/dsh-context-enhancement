import { pathToFileURL } from 'node:url'

const { clientBundle } = await import(pathToFileURL(
  'C:/Users/chuxi/Documents/trae_projects/code/deepseek-harness-rc1-context/packages/client/tsdown.client.ts',
).href)

export default clientBundle('@deepseek-ai/dsh-client-ui-jobs', [
  'lib/types/index.js',
  'lib/types/task-state.js',
  'lib/types/task-state-basic.js',
  'lib/types/task-state-control.js',
  'lib/types/task-state-prompt.js',
  'lib/types/compaction-basic.js',
  'lib/types/tool-result-pruner.js',
])
