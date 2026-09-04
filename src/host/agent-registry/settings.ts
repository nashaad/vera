import { isVeraProviderId } from "../../config.ts";
import type { PoolAdmissionVerdict } from "../../engine/events.ts";
import { isModelReasoningEffort, publishedReasoningLevels, type ModelSettingsPatch, type ModelTurnSettings, type ReviewerModelDefault, type ReviewerSettingsPatch } from "../../engine/model-settings.ts";
import type { ToolReviewerSettings } from "../../engine/reviewer.ts";
import { admittedEffortIds } from "../../model/catalog-view.ts";
import { inferReasoningSelection } from "../../model/reasoning-effort.ts";
import type { SuggestedModel } from "../../model/supported-models.ts";
import type { ModelReasoningEffort } from "../../model/types.ts";
import type { SessionSettingOrigin } from "../../store/session-store.ts";
import type { ToolOutput } from "../../tools/types.ts";
import { delegationAllows, reviewerDefaultOf, settingsForClient } from "./helpers.ts";
import { samePair, type AgentRegistryOptions, type RegisteredAgentEntry } from "./support.ts";
import type { AgentRegistry } from "../agent-registry.ts";
import { OVERRIDE_KEYS, type OverrideKey } from "../../engine/override-rows.ts";
import type { OverrideSettingsPatch } from "../../engine/model-settings.ts";

/** A patch that returns every lever to its shipped default. */
function clearedOverrides(): OverrideSettingsPatch {
    const cleared: Record<OverrideKey, null> = {} as Record<OverrideKey, null>;
    for (const key of OVERRIDE_KEYS) {
        cleared[key] = null;
    }
    return cleared;
}

export function modelsForClient(reg: AgentRegistry): readonly SuggestedModel[] {
        const refreshed = reg.options.refreshAvailableModels?.();
        if (refreshed !== undefined) {
            reg.availableModels = refreshed;
        }
        return reg.availableModels;
    }

export function isKnownProvider(reg: AgentRegistry, provider: string): boolean {
        return isVeraProviderId(provider)
            || reg.options.customProviderIds?.().includes(provider) === true;
    }

export function readHostModelSettings(reg: AgentRegistry, workspace?: string): ModelTurnSettings {
        return settingsForClient(
            {
                provider: reg.defaultProvider,
                model: reg.defaultModel,
                ...(reg.defaultReasoningEffort === undefined
                    ? {}
                    : { reasoningEffort: reg.defaultReasoningEffort }),
            },
            reg.defaultProvider,
            reg.catalog,
            reg.modelsForClient(),
            reg.options.readPool?.(workspace),
            reg.options.subagentModel,
            undefined,
            reg.reviewerDefault(),
            reg.options.contextLimit?.(),
            reg.options.configuredOverrides?.(),
            workspace,
            reg.options.refreshableProviders?.(),
        );
    }

export function reviewerDefault(reg: AgentRegistry): ReviewerModelDefault {
        return reviewerDefaultOf(reg.readReviewer());
    }

export function readReviewer(reg: AgentRegistry): ToolReviewerSettings | undefined {
        return reg.options.readReviewer === undefined
            ? reg.reviewerSettings
            : reg.options.readReviewer();
    }

export function applyReviewerPatch(reg: AgentRegistry, patch: ReviewerSettingsPatch | null): boolean {
        if (patch === null) {
            reg.reviewerSettings = undefined;
            reg.options.writeReviewer?.(null);
            return true;
        }
        const carried = reg.readReviewer();
        const fallback = patch.fallback === undefined
            ? carried?.models[1]
            : patch.fallback === null
                ? undefined
                : patch.fallback;
        reg.reviewerSettings = {
            ...carried,
            models: [
                { ...patch.primary },
                ...(fallback === undefined ? [] : [{ ...fallback }]),
            ],
        };
        reg.options.writeReviewer?.(reg.reviewerSettings);
        return true;
    }

export function resolveModelPatch(reg: AgentRegistry, entry: RegisteredAgentEntry, patch: ModelSettingsPatch): {
        readonly settings: ModelTurnSettings;
        readonly requestedReasoningEffort?: ModelReasoningEffort;
    } | undefined {
        if (
            (patch.provider === undefined && patch.model === undefined && patch.reasoningEffort === undefined)
            || (patch.provider !== undefined && patch.provider.trim().length === 0)
            || (patch.provider !== undefined
                && !reg.isKnownProvider(patch.provider.trim()))
            || (patch.model !== undefined && patch.model.trim().length === 0)
            || (patch.reasoningEffort !== undefined
                && patch.reasoningEffort !== null
                && !isModelReasoningEffort(patch.reasoningEffort))
        ) {
            return undefined;
        }
        const provider = patch.provider?.trim()
            ?? entry.modelSettings.provider
            ?? reg.defaultProvider;
        const model = patch.model?.trim() ?? entry.modelSettings.model;
        if (
            entry.store.header.delegation !== undefined
            && !delegationAllows(entry.store.header.delegation, {
                provider,
                model,
            })
        ) {
            return undefined;
        }
        try {
            entry.adapter?.prepareProvider(provider);
        } catch {
            return undefined;
        }
        let reasoningEffort = patch.reasoningEffort === undefined
            ? entry.modelSettings.reasoningEffort
            : patch.reasoningEffort === null
                ? undefined
                : patch.reasoningEffort;
        const scope = {
            ...reg.catalog,
            projectRoot: entry.store.header.cwd,
        };
        const unnarrowed = publishedReasoningLevels(
            provider,
            model,
            reg.options.readPool?.(entry.store.header.cwd),
            reg.catalog,
        );
        const published = {
            ...unnarrowed,
            efforts: admittedEffortIds(
                provider,
                model,
                unnarrowed.efforts,
                scope,
            ),
        };
        let requestedReasoningEffort: ModelReasoningEffort | undefined;
        if (
            reasoningEffort !== undefined
            && !published.efforts.includes(reasoningEffort)
        ) {
            if (
                published.efforts.length === 0
                && patch.model === undefined
                && patch.provider === undefined
            ) {
                return undefined;
            }
            const requested = reasoningEffort;
            reasoningEffort = inferReasoningSelection(
                requested,
                published.efforts,
                published.defaultLevel,
            ).providerEffort;
            if (reasoningEffort !== undefined && reasoningEffort !== requested) {
                requestedReasoningEffort = requested;
            }
        }
        const settings: ModelTurnSettings = {
            provider,
            model,
            ...(reasoningEffort === undefined
                ? {}
                : { reasoningEffort }),
        };
        return {
            settings,
            ...(requestedReasoningEffort === undefined
                ? {}
                : { requestedReasoningEffort }),
        };
    }

export async function updateModelSettings(reg: AgentRegistry, id: string, patch: ModelSettingsPatch): Promise<ModelTurnSettings | undefined> {
        const result = await reg.applyModelSettings(id, patch);
        reg.pushWorkerState(id);
        return result;
    }

export async function applyModelSettings(reg: AgentRegistry, id: string, patch: ModelSettingsPatch): Promise<ModelTurnSettings | undefined> {
        const entry = reg.agents.get(id);
        if (entry === undefined || entry.agent.closed || entry.agent.failed) {
            return undefined;
        }
        if (patch.overrides !== undefined) {
            if (reg.options.updateOverrides === undefined) {
                return undefined;
            }
            reg.options.updateOverrides(
                patch.overrides === null ? clearedOverrides() : patch.overrides,
            );
        }
        if (
            patch.overrides !== undefined
            && patch.contextLimit === undefined
            && patch.provider === undefined
            && patch.model === undefined
            && patch.reasoningEffort === undefined
            && patch.reviewer === undefined
        ) {
            return settingsForClient(
                entry.modelSettings,
                entry.modelSettings.provider ?? reg.defaultProvider,
                reg.catalog,
                reg.modelsForClient(),
                reg.options.readPool?.(entry.store.header.cwd),
                reg.options.subagentModel,
                entry.requestedReasoningEffort,
                reg.reviewerDefault(),
                reg.options.contextLimit?.(),
                reg.options.configuredOverrides?.(),
                entry.store.header.cwd,
                reg.options.refreshableProviders?.(),
            );
        }
        if (patch.contextLimit !== undefined) {
            if (reg.options.updateContextLimit === undefined) return undefined;
            reg.options.updateContextLimit(patch.contextLimit);
            if (
                patch.provider === undefined
                && patch.model === undefined
                && patch.reasoningEffort === undefined
                && patch.reviewer === undefined
            ) {
                return settingsForClient(
                    entry.modelSettings,
                    entry.modelSettings.provider ?? reg.defaultProvider,
                    reg.catalog,
                    reg.modelsForClient(),
                    reg.options.readPool?.(entry.store.header.cwd),
                    reg.options.subagentModel,
                    entry.requestedReasoningEffort,
                    reg.reviewerDefault(),
                    reg.options.contextLimit?.(),
                    reg.options.configuredOverrides?.(),
                    entry.store.header.cwd,
                    reg.options.refreshableProviders?.(),
                );
            }
        }
        if (patch.reviewer !== undefined) {
            if (!reg.applyReviewerPatch(patch.reviewer)) {
                return undefined;
            }
            if (
                patch.provider === undefined
                && patch.model === undefined
                && patch.reasoningEffort === undefined
            ) {
                return settingsForClient(
                    entry.modelSettings,
                    entry.modelSettings.provider ?? reg.defaultProvider,
                    reg.catalog,
                    reg.modelsForClient(),
                    reg.options.readPool?.(entry.store.header.cwd),
                    reg.options.subagentModel,
                    entry.requestedReasoningEffort,
                    reg.reviewerDefault(),
                    reg.options.contextLimit?.(),
                    reg.options.configuredOverrides?.(),
                    entry.store.header.cwd,
                    reg.options.refreshableProviders?.(),
                );
            }
        }
        const resolved = reg.resolveModelPatch(entry, patch);
        if (resolved === undefined) {
            return undefined;
        }
        const settings = resolved.settings;
        await entry.store.appendModelSettings(
            settings,
            reg.originFor(entry, settings),
        );
        reg.options.updateModelDefaults?.(settings);
        reg.defaultModel = settings.model;
        reg.defaultProvider = settings.provider ?? reg.defaultProvider;
        reg.defaultReasoningEffort = settings.reasoningEffort;
        entry.modelSettings = settings;
        entry.requestedReasoningEffort = resolved.requestedReasoningEffort;
        return settingsForClient(
            entry.modelSettings,
            entry.modelSettings.provider ?? reg.defaultProvider,
            reg.catalog,
            reg.modelsForClient(),
            reg.options.readPool?.(entry.store.header.cwd),
            reg.options.subagentModel,
            entry.requestedReasoningEffort,
            reg.reviewerDefault(),
            reg.options.contextLimit?.(),
            reg.options.configuredOverrides?.(),
            entry.store.header.cwd,
            reg.options.refreshableProviders?.(),
        );
    }

export function effectiveDefaultPair(reg: AgentRegistry, entry: RegisteredAgentEntry): ModelTurnSettings {
        const agentPair = reg.selectedAgentDefaultPair?.(entry);
        return agentPair ?? {
            provider: reg.defaultProvider,
            model: reg.defaultModel,
            ...(reg.defaultReasoningEffort === undefined
                ? {}
                : { reasoningEffort: reg.defaultReasoningEffort }),
        };
    }

export function originFor(reg: AgentRegistry, entry: RegisteredAgentEntry, settings: ModelTurnSettings): SessionSettingOrigin {
        return samePair(settings, reg.effectiveDefaultPair(entry))
            ? "agent-default"
            : "user";
    }

export async function updateSessionModelSettings(reg: AgentRegistry, id: string, patch: ModelSettingsPatch): Promise<
        { settings: ModelTurnSettings; origin: SessionSettingOrigin } | undefined
    > {
        const result = await reg.applySessionModelSettings(id, patch);
        reg.pushWorkerState(id);
        return result;
    }

export async function applySessionModelSettings(reg: AgentRegistry, id: string, patch: ModelSettingsPatch): Promise<
        { settings: ModelTurnSettings; origin: SessionSettingOrigin } | undefined
    > {
        const entry = reg.agents.get(id);
        if (entry === undefined || entry.agent.closed || entry.agent.failed) {
            return undefined;
        }
        const resolved = reg.resolveModelPatch(entry, patch);
        if (resolved === undefined) {
            return undefined;
        }
        const origin = reg.originFor(entry, resolved.settings);
        await entry.store.appendModelSettings(resolved.settings, origin);
        entry.modelSettings = resolved.settings;
        entry.requestedReasoningEffort = resolved.requestedReasoningEffort;
        return {
            settings: settingsForClient(
                entry.modelSettings,
                entry.modelSettings.provider ?? reg.defaultProvider,
                reg.catalog,
                reg.modelsForClient(),
                reg.options.readPool?.(entry.store.header.cwd),
                reg.options.subagentModel,
                entry.requestedReasoningEffort,
                reg.reviewerDefault(),
                reg.options.contextLimit?.(),
                reg.options.configuredOverrides?.(),
                entry.store.header.cwd,
                reg.options.refreshableProviders?.(),
            ),
            origin,
        };
    }

export function sessionModelSettingsHistory(reg: AgentRegistry, id: string): readonly {
        readonly settings: ModelTurnSettings;
        readonly origin: SessionSettingOrigin;
        readonly timestamp: string;
    }[] {
        const entry = reg.agents.get(id);
        if (entry === undefined) return [];
        return entry.store.modelSettingsHistory().map((record) => ({
            settings: record.settings,
            origin: record.origin ?? "user",
            timestamp: record.timestamp,
        }));
    }

export async function poolAdd(reg: AgentRegistry, id: string, entry: { readonly provider: string; readonly model: string }, onStep: Parameters<
            NonNullable<AgentRegistryOptions["admitToPool"]>
        >[1], options?: { readonly verify?: boolean }): Promise<{
        verdict: PoolAdmissionVerdict;
        reason?: string;
        statusCode?: number;
        settings?: ModelTurnSettings;
    }> {
        const agentEntry = reg.agents.get(id);
        if (
            agentEntry === undefined
            || agentEntry.agent.closed
            || agentEntry.agent.failed
            || reg.options.admitToPool === undefined
        ) {
            return { verdict: "unavailable", reason: "admission unavailable" };
        }
        const outcome = await reg.options.admitToPool({
            provider: entry.provider.trim(),
            model: entry.model.trim(),
        }, onStep, options);
        if (outcome.verdict !== "added") {
            return outcome;
        }
        return {
            ...outcome,
            settings: settingsForClient(
                agentEntry.modelSettings,
                agentEntry.modelSettings.provider ?? reg.defaultProvider,
                reg.catalog,
                reg.modelsForClient(),
                reg.options.readPool?.(agentEntry.store.header.cwd),
                reg.options.subagentModel,
                agentEntry.requestedReasoningEffort,
                reg.reviewerDefault(),
                reg.options.contextLimit?.(),
                reg.options.configuredOverrides?.(),
                agentEntry.store.header.cwd,
                reg.options.refreshableProviders?.(),
            ),
        };
    }

export async function applyPoolAddEffect(reg: AgentRegistry, effect: { readonly models: readonly string[] }): Promise<ToolOutput> {
        if (reg.options.admitToPool === undefined) {
            return {
                kind: "output",
                output: "Pool admission is not available in this host.",
                isError: true,
            };
        }
        const lines: string[] = [];
        let failed = false;
        for (const identifier of effect.models) {
            const separator = identifier.indexOf("/");
            if (separator <= 0 || separator === identifier.length - 1) {
                lines.push(`${identifier}: not a provider/model identifier`);
                failed = true;
                continue;
            }
            const outcome = await reg.options.admitToPool({
                provider: identifier.slice(0, separator),
                model: identifier.slice(separator + 1),
            }, () => {});
            if (outcome.verdict === "added") {
                lines.push(`${identifier}: added to the pool`);
            } else if (outcome.verdict === "incompatible") {
                lines.push(`${identifier}: incompatible (${
                    outcome.reason ?? "no reason recorded"
                }); it stays out of the pool`);
            } else {
                lines.push(`${identifier}: unavailable (${
                    outcome.reason ?? "provider did not answer"
                }); nothing recorded, retry later`);
            }
        }
        return { kind: "output", output: lines.join("\n"), isError: failed };
    }

export async function refreshHostCatalog(
    reg: AgentRegistry,
    provider: string,
): Promise<readonly SuggestedModel[] | undefined> {
        if (reg.options.refreshCatalog === undefined) {
            return undefined;
        }
        const refreshed = await reg.options.refreshCatalog(provider);
        if (refreshed === undefined) {
            return undefined;
        }
        reg.availableModels = refreshed;
        return refreshed;
    }

export async function refreshCatalog(reg: AgentRegistry, id: string, provider: string): Promise<ModelTurnSettings | undefined> {
        const agentEntry = reg.agents.get(id);
        if (
            agentEntry === undefined
            || agentEntry.agent.closed
            || agentEntry.agent.failed
            || reg.options.refreshCatalog === undefined
        ) {
            return undefined;
        }
        const refreshed = await refreshHostCatalog(reg, provider);
        if (refreshed === undefined) {
            return undefined;
        }
        return settingsForClient(
            agentEntry.modelSettings,
            agentEntry.modelSettings.provider ?? reg.defaultProvider,
            reg.catalog,
            reg.availableModels,
            reg.options.readPool?.(agentEntry.store.header.cwd),
            reg.options.subagentModel,
            agentEntry.requestedReasoningEffort,
            reg.reviewerDefault(),
            reg.options.contextLimit?.(),
            reg.options.configuredOverrides?.(),
            agentEntry.store.header.cwd,
            reg.options.refreshableProviders?.(),
        );
    }

export async function poolRemove(reg: AgentRegistry, id: string, entry: { readonly provider: string; readonly model: string }): Promise<ModelTurnSettings | undefined> {
        const agentEntry = reg.agents.get(id);
        if (
            agentEntry === undefined
            || agentEntry.agent.closed
            || agentEntry.agent.failed
            || reg.options.removeFromPool === undefined
        ) {
            return undefined;
        }
        reg.options.removeFromPool({
            provider: entry.provider.trim(),
            model: entry.model.trim(),
        });
        return settingsForClient(
            agentEntry.modelSettings,
            agentEntry.modelSettings.provider ?? reg.defaultProvider,
            reg.catalog,
            reg.modelsForClient(),
            reg.options.readPool?.(agentEntry.store.header.cwd),
            reg.options.subagentModel,
            agentEntry.requestedReasoningEffort,
            reg.reviewerDefault(),
            reg.options.contextLimit?.(),
            reg.options.configuredOverrides?.(),
            agentEntry.store.header.cwd,
            reg.options.refreshableProviders?.(),
        );
    }

export async function poolName(reg: AgentRegistry, id: string, entry: { readonly provider: string; readonly model: string }, name: string | null): Promise<ModelTurnSettings | undefined> {
        const agentEntry = reg.agents.get(id);
        if (
            agentEntry === undefined
            || agentEntry.agent.closed
            || agentEntry.agent.failed
            || reg.options.namePoolEntry === undefined
        ) {
            return undefined;
        }
        const named = reg.options.namePoolEntry({
            provider: entry.provider.trim(),
            model: entry.model.trim(),
        }, name === null ? null : name.trim(), agentEntry.store.header.cwd);
        if (!named) {
            return undefined;
        }
        return settingsForClient(
            agentEntry.modelSettings,
            agentEntry.modelSettings.provider ?? reg.defaultProvider,
            reg.catalog,
            reg.modelsForClient(),
            reg.options.readPool?.(agentEntry.store.header.cwd),
            reg.options.subagentModel,
            agentEntry.requestedReasoningEffort,
            reg.reviewerDefault(),
            reg.options.contextLimit?.(),
            reg.options.configuredOverrides?.(),
            agentEntry.store.header.cwd,
            reg.options.refreshableProviders?.(),
        );
    }

export async function poolMove(reg: AgentRegistry, id: string, entry: { readonly provider: string; readonly model: string }, delta: number): Promise<ModelTurnSettings | undefined> {
        const agentEntry = reg.agents.get(id);
        if (
            agentEntry === undefined
            || agentEntry.agent.closed
            || agentEntry.agent.failed
            || reg.options.movePoolEntry === undefined
        ) {
            return undefined;
        }
        const moved = reg.options.movePoolEntry({
            provider: entry.provider.trim(),
            model: entry.model.trim(),
        }, delta, agentEntry.store.header.cwd);
        if (!moved) {
            return undefined;
        }
        return settingsForClient(
            agentEntry.modelSettings,
            agentEntry.modelSettings.provider ?? reg.defaultProvider,
            reg.catalog,
            reg.modelsForClient(),
            reg.options.readPool?.(agentEntry.store.header.cwd),
            reg.options.subagentModel,
            agentEntry.requestedReasoningEffort,
            reg.reviewerDefault(),
            reg.options.contextLimit?.(),
            reg.options.configuredOverrides?.(),
            agentEntry.store.header.cwd,
            reg.options.refreshableProviders?.(),
        );
    }
