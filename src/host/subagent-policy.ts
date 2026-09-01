
import type { SubagentPoolPolicy } from "../engine/subagent.ts";
import {
    loadOptionalVeraConfig,
} from "../config.ts";
import { resolveModelAssignment } from "../config/model-assignments.ts";
import { effectiveCatalog, type EffectiveCatalogOptions } from "../model/catalog.ts";
import type { CatalogModel } from "../model/catalog-shape.ts";
import { isRelativeEffort } from "../model/effort-ladder.ts";
import {
    loadPoolFile,
    type LoadPoolFileOptions,
} from "../model/pool-file-loader.ts";
import {
    isCuratedPoolEntry,
    isVerifiedPoolEntry,
    type PoolFile,
    providerOf,
} from "../model/pool-file.ts";
import { resolvePoolRef } from "../model/pool-names.ts";
import {
    isSelectable,
    lookupModel,
    resolveTools,
} from "../model/pool-policy.ts";

export interface SubagentPolicyOptions
    extends LoadPoolFileOptions, EffectiveCatalogOptions {
    readonly configPath?: string;
}

export function subagentPoolPolicy(
    options: SubagentPolicyOptions = {},
): SubagentPoolPolicy {
    const file = loadPoolFile(options).merged;
    const families: Record<string, string> = {};
    for (const [id, entry] of Object.entries(file.models)) {
        if (entry.family !== undefined) {
            families[id] = entry.family;
        }
    }
    const selfEffort = file.defaults.subagentEffort;
    const subagentDefault = file.defaults.subagent === undefined
            || file.defaults.subagent === "self"
        ? file.defaults.subagent
        : resolvePoolRef(file, file.defaults.subagent) ?? file.defaults.subagent;
    const failsafe = failsafeCandidates(file);
    const tools = failsafeToolSupport(failsafe, file, options);
    const config = options.configPath === undefined
        ? options.userPath === undefined
            ? loadOptionalVeraConfig()
            : undefined
        : loadOptionalVeraConfig({ path: options.configPath });
    const assignment = config === undefined
        ? undefined
        : resolveModelAssignment(
            {
                models: config.models ?? [],
                model_routes: config.model_routes ?? {},
                reviewer_profiles: config.reviewer_profiles ?? {},
            },
            config.model_assignments ?? {},
            "subagents",
        );
    const assigned = assignment?.models
        .filter((entry) => {
            const id = `${entry.provider}/${entry.model}`;
            return file.models[id] !== undefined
                && isSelectable(id, file);
        })
        .map((entry) => ({
            provider: entry.provider,
            model: entry.model,
            ...(entry.reasoning_effort === undefined
                ? {}
                : { reasoningEffort: entry.reasoning_effort }),
        })) ?? [];
    return {
        ...(assigned.length === 0 ? {} : { assigned }),
        ...(config?.model_assignments?.subagents?.allow_self === true
            ? { allowSelf: true }
            : {}),
        ...(subagentDefault === undefined ? {} : { subagentDefault }),
        ...(Object.keys(tools).length === 0 ? {} : { tools }),
        ...(file.defaults.allow === undefined
            ? {}
            : { allow: file.defaults.allow }),
        ...(file.defaults.deny === undefined
            ? {}
            : { deny: file.defaults.deny }),
        ...(failsafe.length === 0 ? {} : { failsafe }),
        ...(Object.keys(families).length === 0 ? {} : { families }),
        // An unrecognised word is dropped rather than passed through: the self rung would otherwise ask for a level no ladder step can match, and the subagent nobody is watching would.
        ...(isRelativeEffort(selfEffort) ? { selfEffort } : {}),
    };
}

function failsafeCandidates(file: PoolFile): readonly string[] {
    return Object.entries(file.models)
        .filter(([, entry]) =>
            isCuratedPoolEntry(entry) && isVerifiedPoolEntry(entry))
        .map(([id]) => id);
}

function failsafeToolSupport(
    failsafe: readonly string[],
    file: PoolFile,
    options: EffectiveCatalogOptions,
): Record<string, boolean> {
    const catalogs = new Map<string, ReadonlyMap<string, CatalogModel>>();
    const tools: Record<string, boolean> = {};
    for (const id of failsafe) {
        const provider = providerOf(id);
        if (provider === undefined) {
            continue;
        }
        let catalog = catalogs.get(provider);
        if (catalog === undefined) {
            catalog = providerCatalog(provider, options);
            catalogs.set(provider, catalog);
        }
        const resolved = resolveTools(lookupModel(id, file, catalog));
        if (resolved.value !== undefined) {
            tools[id] = resolved.value;
        }
    }
    return tools;
}

function providerCatalog(
    provider: string,
    options: EffectiveCatalogOptions,
): ReadonlyMap<string, CatalogModel> {
    const models = new Map<string, CatalogModel>();
    for (const model of effectiveCatalog(provider, options).models) {
        models.set(`${provider}/${model.id}`, model);
    }
    return models;
}
