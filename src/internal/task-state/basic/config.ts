/**
 * Load-time validation and detachment of the task-state-basic deployment
 * policy. Every field is explicit and required from the composition; no
 * repository default hardcodes a deployment choice.
 *
 * The Loader-facing schema lives inline on the service class (`static Config`)
 * so the config catalog's static walker can enumerate every validated key;
 * this module owns the raw-key set and the direct-construction validation used
 * when a caller mounts the plugin without Loader normalization.
 * @module dsh-context-enhancement/internal/task-state/basic/config
 */

import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type { TaskStateBasicConfig } from './types.ts'

/** Complete configuration key set. */
const CONFIG_KEYS: ReadonlySet<string> = new Set([
  'provider',
  'model',
  'minEvents',
  'maxEvents',
  'maxInputBytes',
  'maxOutputTokens',
  'timeoutMs',
  'maxInfraRetries',
  'maxEntriesPerKind',
  'maxEntryBytes',
  'maxListItems',
])

function assertSafeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`task-state-basic: ${name} must be a positive safe integer`)
  }
}

/**
 * Validate and detach one task-state-basic configuration object (used when a
 * caller constructs the plugin directly without Loader schema normalization).
 * @param config - raw deployment configuration.
 * @returns a detached immutable policy.
 */
export function resolveTaskStateBasicConfig(config: TaskStateBasicConfig): Readonly<TaskStateBasicConfig> {
  const value: unknown = config
  if (value === null || typeof value !== 'object') {
    throw new Error('task-state-basic: configuration is required')
  }
  const record = value as TaskStateBasicConfig
  for (const key of Object.keys(record)) {
    if (!CONFIG_KEYS.has(key)) throw new Error(`task-state-basic: unknown config key "${key}"`)
  }
  if (typeof record.provider !== 'string' || record.provider.length === 0
    || typeof record.model !== 'string' || record.model.length === 0) {
    throw new Error('task-state-basic: provider and model must be non-empty strings')
  }
  assertSafeInteger('minEvents', record.minEvents)
  assertSafeInteger('maxEvents', record.maxEvents)
  assertSafeInteger('maxInputBytes', record.maxInputBytes)
  assertSafeInteger('maxOutputTokens', record.maxOutputTokens)
  if (!Number.isSafeInteger(record.timeoutMs) || record.timeoutMs <= 0 || record.timeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`task-state-basic: timeoutMs must be a positive safe integer no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  if (!Number.isSafeInteger(record.maxInfraRetries) || record.maxInfraRetries < 0) {
    throw new Error('task-state-basic: maxInfraRetries must be a non-negative safe integer')
  }
  assertSafeInteger('maxEntriesPerKind', record.maxEntriesPerKind)
  assertSafeInteger('maxEntryBytes', record.maxEntryBytes)
  assertSafeInteger('maxListItems', record.maxListItems)
  if (record.maxEvents < record.minEvents) {
    throw new Error('task-state-basic: maxEvents must be greater than or equal to minEvents')
  }
  return Object.freeze({ ...record })
}
