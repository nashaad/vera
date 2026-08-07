/**
 * Admitting a model to the pool: the catalog copy, with no call on the wire.
 *
 * Adding a model never waits on a provider. A model the catalog describes
 * enters with that description copied into its entry; a model the catalog has
 * never heard of enters with safe defaults. Either way it is usable straight
 * away and carries no learned facts, which is what marks it unverified. The
 * probe is the escalation tool (verify on demand, or lazily on the first
 * capability error), not the gate.
 *
 * The copied map lands in the declared half of the entry, because the user
 * asked for this model and the catalog is what Vera knows about it. Only
 * probes and live rejections write `learned`.
 */

import type { CatalogModel } from "./catalog-shape.ts";
import { effectiveCatalog } from "./catalog.ts";
import { isEffortLevel } from "./effort-ladder.ts";
import { admitModel } from "./admission.ts";
import type { PoolFileModel } from "./pool-file.ts";
import type { ModelAdapter } from "./types.ts";
import {
    addPoolModel,
    recordLearned,
    PoolFileWriteRefusedError,
} from "./pool-file-store.ts";

export type PoolAdmissionVerdict =
    | "added"
    | "incompatible"
    | "unavailable"
    | "pool_write_refused";

export interface PoolAdmissionEntry {
    readonly provider: string;
    readonly model: string;
}

export interface PoolAdmissionStep {
    readonly step: string;
    readonly label: string;
    readonly status: "running" | "passed" | "failed" | "skipped";
    readonly detail?: string;
}

export interface PoolAdmissionOptions {
    readonly verify?: boolean;
    readonly onWriteRefused?: (error: PoolFileWriteRefusedError) => void;
    readonly createAdapter?: (provider: string) => ModelAdapter;
}

export interface PoolAdmissionOutcome {
    readonly verdict: PoolAdmissionVerdict;
    readonly reason?: string;
    readonly statusCode?: number;
}

export async function admitToPool(
    entry: PoolAdmissionEntry,
    onStep: (step: PoolAdmissionStep) => void = () => {},
    options: PoolAdmissionOptions = {},
): Promise<PoolAdmissionOutcome> {
    const id = `${entry.provider}/${entry.model}`;
    const catalogModel = effectiveCatalog(entry.provider)
        .models.find((candidate) => candidate.id === entry.model);
    if (options.verify !== true) {
        // Nothing on the wire: the catalog copy is what the user gets to use
        // immediately, and it carries no learned facts, which is what leaves
        // the entry unverified.
        const refused = refusedPoolWrite(() => {
            addPoolModel(id, declaredPoolEntry(catalogModel));
        }, options);
        return refused ?? { verdict: "added" };
    }
    let adapter;
    try {
        if (options.createAdapter === undefined) {
            return {
                verdict: "unavailable",
                reason: "provider is not configured",
            };
        }
        adapter = options.createAdapter(entry.provider);
    } catch (error) {
        return {
            verdict: "unavailable",
            reason: error instanceof Error
                ? error.message
                : "provider is not configured",
        };
    }
    const verdict = await admitModel({
        adapter,
        provider: entry.provider,
        model: entry.model,
        ...(catalogModel === undefined ? {} : { catalogModel }),
        onStep,
    });
    if (verdict.status === "added") {
        // Two writes because they are two different claims: the user asked for
        // this model, and the probe found these facts.
        const refused = refusedPoolWrite(() => {
            addPoolModel(id, declaredPoolEntry(catalogModel));
            recordLearned(id, verdict.learned);
        }, options);
        return refused ?? { verdict: "added" };
    }
    return {
        verdict: verdict.status,
        reason: verdict.reason,
        ...(verdict.status === "incompatible" && verdict.statusCode !== undefined
            ? { statusCode: verdict.statusCode }
            : {}),
    };
}

function refusedPoolWrite(
    write: () => void,
    options: PoolAdmissionOptions,
): { readonly verdict: "pool_write_refused"; readonly reason: string } | undefined {
    try {
        write();
        return undefined;
    } catch (error) {
        if (!(error instanceof PoolFileWriteRefusedError)) {
            throw error;
        }
        options.onWriteRefused?.(error);
        return { verdict: "pool_write_refused", reason: error.message };
    }
}

/**
 * The declared entry a `pool_add` writes.
 *
 * Levels the ladder does not name are dropped rather than copied: a level
 * Vera cannot address is a level it can never ask for or coarsen through, and
 * carrying the word into the pool only lets it reach a provider unchecked.
 * `tools` is copied only when the catalog states it; absent means unknown, and
 * an unknown that reads as `false` would keep the model out of every ladder.
 */
export function declaredPoolEntry(
    catalogModel: CatalogModel | undefined,
): PoolFileModel {
    if (catalogModel === undefined) {
        return { added: true };
    }
    const efforts: Record<string, string> = {};
    for (const level of catalogModel.levels) {
        const rung = level.id === "none" ? "off" : level.id;
        if (isEffortLevel(rung)) {
            efforts[rung] = level.id;
        }
    }
    return {
        added: true,
        ...(catalogModel.tool_support === undefined
            ? {}
            : { tools: catalogModel.tool_support }),
        ...(catalogModel.context_window === undefined
            ? {}
            : { context: catalogModel.context_window }),
        ...(Object.keys(efforts).length === 0 ? {} : { efforts }),
    };
}
