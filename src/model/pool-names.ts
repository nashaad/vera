
import {
    POOL_NAME_PATTERN,
    isCuratedPoolEntry,
    splitModelId,
    type PoolFile,
    type PoolFileModel,
} from "./pool-file.ts";

function isNamedCurated(entry: PoolFileModel): boolean {
    const { name: _name, ...rest } = entry;
    return isCuratedPoolEntry(rest);
}

export interface NamedPoolEntry {
    readonly id: string;
    readonly name: string;
}

export function poolNames(file: PoolFile): readonly NamedPoolEntry[] {
    const seen = new Map<string, string | undefined>();
    for (const [id, entry] of Object.entries(file.models)) {
        if (entry.name === undefined || !isNamedCurated(entry)) {
            continue;
        }
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

export function resolveBoundModelRef(
    file: PoolFile,
    ref: string,
): { readonly provider: string; readonly model: string } | undefined {
    const id = resolvePoolRef(file, ref);
    if (id === undefined) return undefined;
    return splitModelId(id);
}

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
