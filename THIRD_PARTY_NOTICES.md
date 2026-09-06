# Third-Party Notices

This package includes source code copied and adapted from the
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
repository, release tag `dsh-v0.1.2-rc.1`
(commit `a66e4702047846cdaa10c66c9d3df3951f5ea70d`), which is distributed
under the MIT License. The copied modules carry a `SOURCE:` provenance header
naming their exact upstream file.

Copied/adapted sources also include the Card5/6 working-tree migration delta of
the same repository (the uncommitted region-aware compaction and tool-result
pruning changes reviewed against that tag; upstream file names are recorded in
the module `SOURCE:` headers).

## Copied DSH sources

| Official rc.1 source | Where used in this package | License |
| --- | --- | --- |
| `@deepseek-ai/dsh-compaction` `src/{tool-pairing,tool-segments,selection-guard}.ts` | `src/internal/compaction/{tool-pairing,tool-segments,selection-guard}.ts` | MIT |
| `@deepseek-ai/dsh-compaction-basic` `src/{config,region,summarizer,types,index}.ts` | `src/internal/compaction/{config,region,summarizer,types}.ts`, `src/compaction-basic.ts` | MIT |
| `@deepseek-ai/dsh-compaction-tool-result-pruner` `src/{config,index,types}.ts` | `src/internal/compaction/{pruner-config,pruner-types}.ts`, `src/tool-result-pruner.ts` | MIT |
| `@deepseek-ai/dsh-task-state` `src/{brand,index,spec,types,invariant}.ts` | `src/internal/task-state/contract/*` (audit-event stream re-architected into the provider-owned storage-domain audit table) | MIT |
| `@deepseek-ai/dsh-task-state-basic` `src/{batch,bytes,config,domain,filter,host,index,prompt,types,update,worker}.ts` | `src/internal/task-state/basic/*`, `src/task-state-basic.ts` | MIT |
| `@deepseek-ai/dsh-task-state-prompt` `src/{index,render,types}.ts` | `src/internal/task-state/prompt/*`, `src/task-state-prompt.ts` | MIT |
| Shipped `standard` agent preset (`presets/standard/agent.cordis.yml`, `preset.yml`) | `presets/contextual/agent.cordis.yml`, `preset.yml` (edited copy) | MIT |

MIT License text (DeepSeek Harness):

```
MIT License

Copyright (c) 2026 DeepSeek Harness contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Runtime dependencies

Runtime dependencies are installed from the npm registry and are not copied
into this package:

| Package | Version | License |
| --- | --- | --- |
| `zod` | 4.4.3 | MIT |

The same rc.1 packages are listed as exact peers for host compatibility and as
runtime dependencies so a GitHub Bundle install carries the loader-visible
closure. Their licenses belong to their publishers; this package does not copy
their source.
