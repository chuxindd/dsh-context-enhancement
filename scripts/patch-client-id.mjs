import { readFile, writeFile } from 'node:fs/promises'

const path = new URL('../lib/client.js', import.meta.url)
const source = await readFile(path, 'utf8')
const from = '@deepseek-ai/dsh-client-ui-jobs'
const to = 'dsh-context-enhancement'
if (!source.includes(`id: "${from}"`)) throw new Error(`client bundle does not contain expected module id ${from}`)
await writeFile(path, source.replace(`id: "${from}"`, `id: "${to}"`))
