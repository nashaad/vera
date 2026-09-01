// Lifted settings methods from AgentRegistry. Callers keep registry.foo().
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

/**
     * The model settings a client sees when it has no session behind it.
     *
     * The catalog, the shortlist and the defaults are the host's, not any
     * conversation's, so they can be read before one exists. The pair reported
     * is the host default: nobody has dialed anything yet.
     */
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
            reg.options.developerSettings?.(),
            workspace,
            reg.options.refreshableProviders?.(),
        );
    }

export function reviewerDefault(reg: AgentRegistry): ReviewerModelDefault {
        return reviewerDefaultOf(reg.readReviewer());
    }

/** The reviewer route agents read at each review, not once at start. */
export function readReviewer(reg: AgentRegistry): ToolReviewerSettings | undefined {
        return reg.options.readReviewer === undefined
            ? reg.reviewerSettings
            : reg.options.readReviewer();
    }

/**
     * Applies a reviewer choice to every running agent and writes it to the
     * config file, so the session the user is in changes with the file rather
     * than at the next start. Any model may be a reviewer: nothing here checks
     * the pool or the catalog, because a reviewer that turns out to be
     * unreachable falls through to the failsafe on its own.
     */
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

/**
     * Validate a pair patch and answer with the settings it resolves to.
     *
     * Shared by the global write and the session-scoped one so a chord and a
     * picker cannot disagree about which levels a model publishes, or coerce an
     * unpublished level differently.
     */
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
        // Pool membership does not gate this. The pool is the user's curated
        // shortlist, not the set of models they are allowed to run: choosing a
        // model from the catalog runs it and adds nothing.
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
        // Checked against exactly what the picker was served, through the
        // same reader: a level published for this model is always acceptable
        // here, whichever layer published it.
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
        // A level the model does not publish is coerced rather than promoted:
        // the model's own default, else a middle level, never the top. Same
        // rule as request-time resolution, so a switch and a turn place an
        // unknown level identically. The coerced level comes back in the
        // returned settings, which is how the client learns of the
        // substitution.
        //
        // A model that publishes no levels at all is the one case an
        // effort-only patch still refuses: there is no dial to move, and
        // there the level is the whole request.
        // The level asked for, kept so the client can say what it asked for
        // beside what it got. Undefined again the moment a change validates
        // as published, which is how the note clears.
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
        if (patch.developer !== undefined) {
            if (reg.options.updateDeveloperSettings === undefined) {
                return undefined;
            }
            reg.options.updateDeveloperSettings(
                patch.developer === null ? { enabled: false } : patch.developer,
            );
        }
        if (
            patch.developer !== undefined
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
                reg.options.developerSettings?.(),
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
                    reg.options.developerSettings?.(),
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
                // A reviewer-only patch changes no running model, so the reply
                // is the current settings carrying the new reviewer.
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
                    reg.options.developerSettings?.(),
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
            reg.options.developerSettings?.(),
            entry.store.header.cwd,
            reg.options.refreshableProviders?.(),
        );
    }

/**
     * The pair a session falls back to when nobody has dialed it.
     *
     * Today that is the host default. Once an agent can carry a `default_pair`
     * the worn agent's answer comes first, and everything that compares against
     * "the default" goes through here so there is one answer to compare with.
     */
export function effectiveDefaultPair(reg: AgentRegistry, entry: RegisteredAgentEntry): ModelTurnSettings {
        const agentPair = reg.wornAgentDefaultPair?.(entry);
        return agentPair ?? {
            provider: reg.defaultProvider,
            model: reg.defaultModel,
            ...(reg.defaultReasoningEffort === undefined
                ? {}
                : { reasoningEffort: reg.defaultReasoningEffort }),
        };
    }

/**
     * Derived at write time on every path, never carried forward.
     *
     * Reclassifying here is what makes dialing back to the default clear the
     * override: a stale `user` origin sitting on a pair that equals the default
     * would show a marker the user could not get rid of by any means except
     * knowing about the record.
     */
export function originFor(reg: AgentRegistry, entry: RegisteredAgentEntry, settings: ModelTurnSettings): SessionSettingOrigin {
        return samePair(settings, reg.effectiveDefaultPair(entry))
            ? "agent-default"
            : "user";
    }

/**
     * Dial one session. The host's defaults, and every session that is not this
     * one, are left exactly as they were.
     */
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
                reg.options.developerSettings?.(),
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

/**
     * Editing the pool never changes which model runs, so the settings that
     * come back are unchanged apart from the new pool. It refuses an unknown
     * agent for the same reason every other command does: the reply is that
     * agent's snapshot, and there is none to send.
     */
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
                reg.options.developerSettings?.(),
                agentEntry.store.header.cwd,
                reg.options.refreshableProviders?.(),
            ),
        };
    }

/**
     * The `pool_add` tool's effect: the same admission hook the client's
     * checklist calls, one model at a time, reported back as per-model
     * verdict lines. Verdicts land in the tool result rather than as
     * progress updates: the transcript is the surface the agent path owns.
     */
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

/**
     * Refetches a provider's list on the user's say-so and answers with the
     * settings the refreshed list produces, so the pane that asked can redraw
     * from one reply. A provider that cannot be asked leaves the list alone:
     * a stale list beats an empty one, which is the same rule discovery
     * itself follows on a failed fetch.
     */
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
        const refreshed = await reg.options.refreshCatalog(provider);
        if (refreshed === undefined) {
            return undefined;
        }
        reg.availableModels = refreshed;
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
            reg.options.developerSettings?.(),
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
            reg.options.developerSettings?.(),
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
            reg.options.developerSettings?.(),
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
            reg.options.developerSettings?.(),
            agentEntry.store.header.cwd,
            reg.options.refreshableProviders?.(),
        );
    }
