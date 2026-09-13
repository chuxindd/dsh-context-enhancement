/**
 * E-probe: a minimal vitest config that lives INSIDE the experiment tree.
 *
 * The workspace vitest.config.ts pins its include list to tests/&#42;&#42;/*.spec.ts and
 * the task forbids modifying it, so specs that must stay in
 * `审计资料/实验结果/<experiment>/` cannot be collected by the workspace config.
 * This config is experiment-local, never referenced by package.json, and
 * carries the same Standard-decorator transform as the workspace config
 * (TypeScript source under `src/` uses standard decorators).
 */

import { defineConfig } from 'vitest/config'
import ts from 'typescript'

const decoratorSyntax = /^\s*@[A-Za-z_$][\w$]*/m

function standardDecoratorPlugin() {
  return {
    name: 'dsh-standard-decorators',
    enforce: 'pre' as const,
    transform(code: string, id: string) {
      const file = id.split('?', 1)[0]!
      if (!/\.[cm]?tsx?$/.test(file) || !decoratorSyntax.test(code)) return
      const result = ts.transpileModule(code, {
        fileName: file,
        compilerOptions: {
          target: ts.ScriptTarget.ES2024,
          module: ts.ModuleKind.ESNext,
          jsx: file.endsWith('x') ? ts.JsxEmit.ReactJSX : undefined,
          sourceMap: true,
        },
      })
      return {
        code: result.outputText.replace(/\n?\/\/# sourceMappingURL=.*$/u, '\n'),
        map: result.sourceMapText,
      }
    },
  }
}

export default defineConfig({
  root: process.cwd(),
  plugins: [standardDecoratorPlugin()],
  test: {
    include: ['审计资料/实验结果/**/*.spec.ts'],
    environment: 'node',
    maxWorkers: 1,
    minWorkers: 1,
  },
})
