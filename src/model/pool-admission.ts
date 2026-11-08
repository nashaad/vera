
import type { CatalogModel } from "./catalog-shape.ts";
import { effectiveCatalog } from "./catalog.ts";
import { isEffortLevel } from "./effort-ladder.ts";
import { admitModel } from "./admission.ts";
import { feedLearnedFacts, type FeedRowReader } from "./feed-cache.ts";
import type { ModelFeedRow } from "./feed-shape.ts";
import type { LearnedFacts, PoolFileModel } from "./pool-file.ts";
import type { ModelAdapter } from "./types.ts";
import {
    addPoolModel,
    clearLearned,
    recordLearned,
    PoolFileWriteRefusedError,
} from "./pool-file-store.ts";

const FEED_STEP_LABEL = "In Vera's verified models";

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
    readonly readFeedRow?: FeedRowReader;
    readonly path?: string;
    readonly commit?: (id: string, declared: PoolFileModel, learned?: LearnedFacts) => Promise<void>;
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
        const refused = await commitPool(id, declaredPoolEntry(catalogModel), undefined, options);
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
    const feedRow = await freshRowOrUndefined(entry, options);
    if (feedRow !== undefined) {
        onStep({
            step: "feed",
            label: FEED_STEP_LABEL,
            status: "running",
        });
        const refused = await commitPool(id, declaredPoolEntry(catalogModel), feedLearnedFacts(feedRow), options);
        onStep({
            step: "feed",
            label: FEED_STEP_LABEL,
            status: refused === undefined ? "passed" : "failed",
            detail: refused === undefined
                ? `provider configured, verified ${feedRow.verified_at}`
                : refused.reason,
        });
        return refused ?? { verdict: "added" };
    }
    const verdict = await admitModel({
        adapter,
        provider: entry.provider,
        model: entry.model,
        ...(catalogModel === undefined ? {} : { catalogModel }),
        onStep,
    });
    if (verdict.status === "added") {
        // Two writes because they are two different claims: the user asked for this model, and the probe found these facts.
        const refused = await commitPool(id, declaredPoolEntry(catalogModel), verdict.learned, options);
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

async function freshRowOrUndefined(
    entry: PoolAdmissionEntry,
    options: PoolAdmissionOptions,
): Promise<ModelFeedRow | undefined> {
    if (options.readFeedRow === undefined) {
        return undefined;
    }
    try {
        return await options.readFeedRow(entry.provider, entry.model);
    } catch {
        return undefined;
    }
}

async function commitPool(
    id: string,
    declared: PoolFileModel,
    learned: LearnedFacts | undefined,
    options: PoolAdmissionOptions,
): Promise<{ readonly verdict: "pool_write_refused"; readonly reason: string } | undefined> {
    try {
        if (options.commit !== undefined) {
            await options.commit(id, declared, learned);
        } else {
            const storeOptions = options.path === undefined ? {} : { path: options.path };
            addPoolModel(id, declared, storeOptions);
            if (learned !== undefined) {
                clearLearned(id, undefined, storeOptions);
                recordLearned(id, learned, storeOptions);
            }
        }
        return undefined;
    } catch (error) {
        if (!(error instanceof PoolFileWriteRefusedError)
            && !(error instanceof Error && error.name === "PoolFileWriteRefusedError")) {
            throw error;
        }
        options.onWriteRefused?.(error as PoolFileWriteRefusedError);
        return { verdict: "pool_write_refused", reason: (error as Error).message };
    }
}

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
