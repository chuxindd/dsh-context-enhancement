import { t as Schema } from "./lib-Bj3jGSND.js";
import "@deepseek-ai/cordis";
//#region node_modules/.pnpm/@deepseek-ai+dsh-storage@0._13129232fdd14e3261cd7a1616d68dd8/node_modules/@deepseek-ai/dsh-storage/lib/index.js
/**
* Backend-facing vocabulary of the storage hub: a backend owns one medium
* (a file-tree root, a database file) and exposes operation groups over it.
* This module defines the normative contract text for backend implementers; the shared
* conformance suite in `tests/contract.ts` checks every rule.
* @module @deepseek-ai/dsh-storage/src/backend
*/
/** Allowed format for unit and table names: safe as a file name and as a SQL identifier segment without escaping. */
const UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/;
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-storage-do_9f44d404e0b20c2f6e8599234336f27b/node_modules/@deepseek-ai/dsh-storage-domain/lib/index.js
/**
* Domain declaration vocabulary. A spec object is the single source of a
* domain's identity, layout, and record schemas: the owning package defines
* it once with {@link defineDomain} and both the type surface and the runtime
* (validation, descriptor projection) derive from it. Record schemas are zod
* (`z.infer` keeps types un-duplicated and the same schemas later project to
* RPC wire schemas); plugin `Config` stays schemastery.
* @module @deepseek-ai/dsh-storage-domain/src/spec
*/
/**
* Declare one table.
* @param schema - zod schema validating every stored record of this table.
* @returns the table declaration, key-typed by `K`.
*/
function domainTable(schema) {
	return { valueSchema: schema };
}
/**
* Identity helper that pins a spec's literal types and validates its fields.
* Misconfiguration fails loud at the owning package's module load, before any
* medium is touched: a domain or table name outside `UNIT_NAME_RE`, a version
* that is not a non-negative integer, or a global schema that accepts `null`
* all throw. The `null` rejection guards round-tripping: backends store the
* global as opaque JSON with `null` as the "never written" sentinel, so a
* nullable global would be indistinguishable from an absent one on reopen
* (a stored `null` silently reverts to `initial`).
* @param spec - The domain declaration.
* @returns the same spec, narrowed to its literal type.
*/
function defineDomain(spec) {
	if (!UNIT_NAME_RE.test(spec.name)) throw new Error(`domain name '${spec.name}' must match ${UNIT_NAME_RE}`);
	if (!Number.isInteger(spec.version) || spec.version < 0) throw new Error(`domain '${spec.name}' version must be a non-negative integer, got ${spec.version}`);
	for (const compat of spec.compatibleVersions ?? []) if (!Number.isInteger(compat) || compat < 0 || compat >= spec.version) throw new Error(`domain '${spec.name}' compatibleVersions entries must be non-negative integers below version ${spec.version}, got ${compat}`);
	if (spec.layout !== void 0) {
		const layout = spec.layout;
		if (layout !== "single" && layout !== "per-record") throw new Error(`domain '${spec.name}' layout must be 'single' or 'per-record', got ${layout}`);
	}
	if (spec.invalidRecords !== void 0) {
		const policy = spec.invalidRecords;
		if (policy !== "backup-and-skip") throw new Error(`domain '${spec.name}' invalidRecords must be 'backup-and-skip' when present, got ${policy}`);
	}
	for (const table of Object.keys(spec.tables)) if (!UNIT_NAME_RE.test(table)) throw new Error(`domain '${spec.name}' table name '${table}' must match ${UNIT_NAME_RE}`);
	if (spec.global !== void 0 && spec.global.schema.safeParse(null).success) throw new Error(`domain '${spec.name}' global schema must not accept null: null is the medium's "never written" sentinel, so a stored null could not round-trip`);
	return spec;
}
Schema.object({
	backend: Schema.string().required(),
	routes: Schema.dict(Schema.string()).default({})
});
//#endregion
export { domainTable as n, defineDomain as t };
