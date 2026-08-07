/**
 * Resolving a model ref that may be a pool name.
 *
 * A ref is a name or a `provider/model` id, told apart by the slash: names
 * cannot contain one. Names belong to curated entries only, so resolving one
 * can never reach a model the user did not pool.
 */

import {
    POOL_NAME_PATTERN,
    isCuratedPoolEntry,
    type PoolFile,
    type PoolFileModel,
} from "./pool-file.ts";

/**
 * A name does not admit a model. It is dropped before the curated test so a
 * learned-only entry that carries one stays learned-only.
 */
function isNamedCurated(entry: PoolFileModel): boolean {
    const { name: _name, ...rest } = entry;
    return isCuratedPoolEntry(rest);
}

export interface NamedPoolEntry {
    readonly id: string;
    readonly name: string;
}

/** Every usable name in the file, in file order. Duplicates are dropped. */
export function poolNames(file: PoolFile): readonly NamedPoolEntry[] {
    const seen = new Map<string, string | undefined>();
    for (const [id, entry] of Object.entries(file.models)) {
        if (entry.name === undefined || !isNamedCurated(entry)) {
            continue;
        }
        // A repeated name resolves to nothing, so the first claim is dropped
        // rather than being handed the ref by arrival order.
        seen.set(entry.name, seen.has(entry.name) ? undefined : id);
    }
    const named: NamedPoolEntry[] = [];
    for (const [name, id] of seen) {
        if (id !== undefined) {
            named.push({ id, name });
        }
    }
    return named;
}

/** The model id a ref means, or undefined when the pool does not have it. */
export function resolvePoolRef(
    file: PoolFile,
    ref: string,
): string | undefined {
    if (ref.includes("/")) {
        const entry = file.models[ref];
        return entry !== undefined && isNamedCurated(entry)
            ? ref
            : undefined;
    }
    return poolNames(file).find((entry) => entry.name === ref)?.id;
}

/** The name to show for a model id, when it has one. */
export function poolNameOf(
    file: PoolFile,
    modelId: string,
): string | undefined {
    const entry = file.models[modelId];
    return entry === undefined || !isNamedCurated(entry)
        ? undefined
        : poolNames(file).find((named) => named.id === modelId)?.name;
}

export type PoolNameRefusal = "malformed" | "taken" | "not_pooled";

/**
 * Why a name cannot be given to an entry, or undefined when it can. A name
 * can never be read as an id: ids carry a slash and the name pattern forbids
 * one, which is what keeps the two ref forms apart.
 */
export function poolNameRefusal(
    file: PoolFile,
    modelId: string,
    name: string,
): PoolNameRefusal | undefined {
    if (!POOL_NAME_PATTERN.test(name)) {
        return "malformed";
    }
    const entry: PoolFileModel | undefined = file.models[modelId];
    if (entry === undefined || !isNamedCurated(entry)) {
        return "not_pooled";
    }
    const owner = poolNames(file).find((named) => named.name === name);
    return owner === undefined || owner.id === modelId ? undefined : "taken";
}
