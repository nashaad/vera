import { admitModel } from "./admission.ts";
import type { CatalogModel } from "./catalog-shape.ts";
import { isCuratedPoolEntry, isVerifiedPoolEntry, type PoolFile } from "./pool-file.ts";
import { recordModelVerification, renameModelDisplay, setPoolMembership, type PoolStoreOptions } from "./pool-file-store.ts";
import type { ModelAdapter } from "./types.ts";

export interface ModelReference { readonly provider: string; readonly model: string; }
export interface ModelOperation {
    readonly operation: "keep" | "unkeep" | "verify" | "rename";
    readonly models: readonly ModelReference[];
    readonly displayName?: string;
}
export interface ModelOperationResult {
    readonly provider: string;
    readonly model: string;
    readonly status: "passed" | "failed";
    readonly reason?: string;
}
export interface ModelOperationOptions extends PoolStoreOptions {
    readonly discovered: readonly ModelReference[];
    readonly assignments: readonly { readonly label: string; readonly models: readonly ModelReference[] }[];
    readonly createAdapter: (provider: string) => ModelAdapter;
    readonly catalog?: (provider: string, model: string) => CatalogModel | undefined;
    readonly onResult?: (result: ModelOperationResult) => void;
}
const ref = (model: ModelReference): string => `${model.provider}/${model.model}`;

export function eligibleForDefault(file: PoolFile, model: ModelReference): boolean {
    const entry = file.models[ref(model)];
    return entry !== undefined && isCuratedPoolEntry(entry) && isVerifiedPoolEntry(entry);
}

export async function applyModelOperation(operation: ModelOperation, options: ModelOperationOptions): Promise<readonly ModelOperationResult[]> {
    const models = [...new Map(operation.models.map((model) => [ref(model), model])).values()];
    const results: ModelOperationResult[] = [];
    const result = (model: ModelReference, status: "passed" | "failed", reason?: string) => {
        const entry: ModelOperationResult = { ...model, status, ...(reason === undefined ? {} : { reason }) };
        results.push(entry);
        options.onResult?.(entry);
    };
    const discovered = new Set(options.discovered.map(ref));
    const missing = models.filter((model) => !discovered.has(ref(model)));
    if (operation.operation !== "unkeep" && missing.length > 0) {
        const reason = `Not discovered: ${missing.map(ref).join(", ")}. Refresh the provider catalog.`;
        for (const model of models) result(model, "failed", reason);
        return results;
    }
    if (operation.operation === "unkeep") {
        const affected = new Set(models.map(ref));
        const bound = options.assignments.filter((slot) => slot.models.some((model) => affected.has(ref(model))));
        if (bound.length > 0) {
            const reason = `Bound to ${bound.map((slot) => slot.label).join(", ")}. Reassign those slots or cancel.`;
            for (const model of models) result(model, "failed", reason);
            return results;
        }
    }
    if (operation.operation === "keep" || operation.operation === "unkeep") {
        setPoolMembership(models.map(ref), operation.operation === "keep", options);
        for (const model of models) result(model, "passed");
        return results;
    }
    if (operation.operation === "rename") {
        const name = operation.displayName?.trim();
        if (models.length !== 1 || !name || name.length > 120 || /[\u0000-\u001f\u007f]/u.test(name)) {
            for (const model of models) result(model, "failed", "Use a display name of 1–120 characters without control characters.");
            return results;
        }
        renameModelDisplay(ref(models[0]!), name, options);
        result(models[0]!, "passed", "Display name changed. Provider identity is untouched.");
        return results;
    }
    for (const model of models) {
        try {
            const verdict = await admitModel({ provider: model.provider, model: model.model,
                adapter: options.createAdapter(model.provider),
                catalogModel: options.catalog?.(model.provider, model.model) });
            if (verdict.status === "added") {
                recordModelVerification(ref(model), verdict.learned, options);
                result(model, "passed");
            } else {
                recordModelVerification(ref(model), { probe: { ok: false, seen: new Date().toISOString(), error: verdict.reason } }, options);
                result(model, "failed", verdict.reason);
            }
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            try {
                recordModelVerification(ref(model), { probe: { ok: false, seen: new Date().toISOString(), error: reason } }, options);
                result(model, "failed", reason);
            } catch (writeError) {
                result(model, "failed", `${reason}. Could not save verification: ${writeError instanceof Error ? writeError.message : String(writeError)}`);
            }
        }
    }
    return results;
}
