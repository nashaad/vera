import { basename } from "node:path";

import type { VeraConfig } from "../../config.ts";
import {
    applyModelRequestOptions,
    mergeModelRequestBody,
} from "../../providers/routing.ts";
import type { HostLog } from "../host-log.ts";

import { ToolHooks } from "../../engine/hooks.ts";
import {
    commandHookPhase,
    createCommandHook,
    type CommandHookFunction,
    type CommandHookPhase,
} from "../../extensions/command-hook.ts";
import { notifyObservers, notifyTurnFinished } from "../../extensions/host-services.ts";
import type { ExtensionRegistry } from "../../extensions/registry.ts";
import type {
    ContextSizeTriggerHook,
    PostToolUseHook,
    PreCompactHook,
    PreToolUseHook,
    PreTurnHook,
    SessionEndHook,
    SessionStartHook,
    SubagentFinishedHook,
    SubagentFinishedHookPayload,
    TurnEndingHook,
} from "../../sdk/hooks.ts";
import { loadSkillContribution } from "../../skills/contribution.ts";
import {
    loadStandingNudges,
    standingNudgeContribution,
    type StandingNudgeCadence,
} from "../../standing-nudges.ts";
import type { SessionImportNotes } from "../session-import-note.ts";
import type { StartupFindings } from "../startup-findings.ts";

import type { AgentRegistryOptions } from "../agent-registry/support.ts";

interface SessionHookOptions {
    readonly currentConfig: () => VeraConfig;
    readonly extensions: ExtensionRegistry;
    readonly hostLog: HostLog;
    readonly home: string;
    readonly startupFindings: StartupFindings;
    readonly sessionImportNotes: SessionImportNotes;
}

export function createSessionHooks(options: SessionHookOptions): Pick<AgentRegistryOptions,
    "loadContextualContributions" | "createToolHooks" | "prepareModelRequest"
    | "onTurnFinished" | "onSessionUpdated" | "onPreCompact"
    | "onContextSizeTrigger" | "onSessionEnd"
    | "onSubagentFinished"
> {
    const { currentConfig, extensions, hostLog, home, startupFindings, sessionImportNotes } = options;
    const standingNudgeCadenceBySession = new Map<string, StandingNudgeCadence>();
    // Config commands run before extension hooks, as they do in every other phase.
    const notifyHookObservers = <Payload>(
        configured: readonly ObserverEntry<Payload>[],
        registered: readonly ObserverEntry<Payload>[],
        payload: Payload,
        type: string,
    ): void => {
        notifyObservers(configured, payload, (command, message) => hostLog({
            type,
            level: "warn",
            command,
            message,
        }));
        notifyObservers(registered, payload, (extensionId, message) => hostLog({
            type,
            level: "warn",
            extensionId,
            message,
        }));
    };
    const notifySubagentFinished = (payload: SubagentFinishedHookPayload): void => notifyHookObservers(
        configuredObservers<SubagentFinishedHook>(currentConfig(), "subagent_finished"),
        extensions.subagentFinishedHooks(),
        payload,
        "subagent_finished_hook_failed",
    );
    return {
        loadContextualContributions: async (
            instructionRoot,
            allowedSkills,
            context,
        ) => {
            let cadence: StandingNudgeCadence | undefined;
            if (context?.sessionId !== undefined) {
                cadence = standingNudgeCadenceBySession.get(context.sessionId);
                if (cadence === undefined) {
                    cadence = { matchingTurns: new Map<string, number>() };
                    standingNudgeCadenceBySession.set(
                        context.sessionId,
                        cadence,
                    );
                }
            }
            const standing = context === undefined || context.turn === "delivery"
                ? undefined
                : standingNudgeContribution(
                    loadStandingNudges(home),
                    context,
                    cadence,
                );
            return [
                ...await loadSkillContribution(
                    context?.workspace ?? instructionRoot.path,
                    allowedSkills,
                ),
                ...startupFindings.contributions(),
                ...(standing === undefined ? [] : [standing]),
                ...await sessionImportNotes.contributions(context?.sessionId),
            ];
        },
        createToolHooks: () => {
            const hooks = new ToolHooks((failure) => hostLog({
                type: "session_start_hook_failed",
                level: "warn",
                ...failure,
            }));
            registerConfiguredHooks(hooks, currentConfig());
            for (const hook of extensions.preToolUseHooks()) {
                hooks.registerPreToolUse(hook);
            }
            for (const hook of extensions.postToolUseHooks()) {
                hooks.registerPostToolUse(hook);
            }
            for (const hook of extensions.sessionStartHooks()) {
                hooks.registerSessionStart(hook);
            }
            for (const hook of extensions.preTurnHooks()) {
                hooks.registerPreTurn(hook.run, hook.extensionId);
            }
            for (const hook of extensions.turnEndingHooks()) {
                hooks.registerTurnEnding(hook.run, hook.extensionId);
            }
            hooks.registerSubagentFinished(notifySubagentFinished);
            return hooks;
        },
        prepareModelRequest: ({ sessionId, workspace }) => async (request, provider) => {
            const body: Record<string, import("../../sdk/hooks.ts").JsonValue> = {};
            for (const hook of extensions.modelRequestHooks()) {
                const value = await hook.run({
                    type: "model_request",
                    provider,
                    model: request.model,
                    sessionId,
                    workspace,
                    ...(request.signal === undefined
                        ? {}
                        : { signal: request.signal }),
                });
                if (value === undefined) continue;
                const cloned = structuredClone(value);
                const serialized = JSON.stringify(cloned);
                if (Buffer.byteLength(serialized, "utf8") > 64 * 1024) {
                    throw new Error(
                        `Model request contribution ${hook.namespace} exceeded 65536 bytes`,
                    );
                }
                body[hook.namespace] = cloned;
            }
            const contributed = Object.keys(body).length === 0
                ? request
                : mergeModelRequestBody(
                    request,
                    body,
                    "model request hooks",
                );
            return applyModelRequestOptions(
                contributed,
                currentConfig(),
                provider,
            );
        },
        onTurnFinished: (payload) => notifyTurnFinished(
            extensions.turnFinishedHooks(),
            payload,
            (extensionId, message) => hostLog({
                type: "turn_finished_hook_failed",
                level: "warn",
                extensionId,
                message,
            }),
        ),
        onSessionUpdated: (payload) => notifyObservers(
            extensions.sessionUpdatedHooks(),
            payload,
            (extensionId, message) => hostLog({
                type: "session_updated_hook_failed",
                level: "warn",
                extensionId,
                message,
            }),
        ),
        onPreCompact: (payload) => notifyHookObservers(
            configuredObservers<PreCompactHook>(currentConfig(), "pre_compact"),
            extensions.preCompactHooks(),
            payload,
            "pre_compact_hook_failed",
        ),
        onContextSizeTrigger: (payload) => notifyHookObservers(
            configuredObservers<ContextSizeTriggerHook>(currentConfig(), "context_size_trigger"),
            extensions.contextSizeTriggerHooks(),
            payload,
            "context_size_trigger_hook_failed",
        ),
        onSessionEnd: (payload) => notifyHookObservers(
            configuredObservers<SessionEndHook>(currentConfig(), "session_end"),
            extensions.sessionEndHooks(),
            payload,
            "session_end_hook_failed",
        ),
        onSubagentFinished: notifySubagentFinished,
    };
}

interface ConfiguredCommand {
    readonly phase: CommandHookPhase;
    /** The script's file name, shown on transcript rows and in failure logs. */
    readonly name: string;
    readonly run: CommandHookFunction;
}

interface ObserverEntry<Payload> {
    readonly extensionId: string;
    readonly run: (payload: Payload) => void | Promise<void>;
}

function configuredCommands(config: VeraConfig): readonly ConfiguredCommand[] {
    return (config.hooks ?? []).map((spec) => ({
        phase: commandHookPhase(spec.phase, spec.protocol),
        name: basename(spec.argv[0]!),
        run: createCommandHook({
            phase: spec.phase,
            argv: spec.argv,
            ...(spec.protocol === undefined ? {} : { protocol: spec.protocol }),
            ...(spec.timeout_ms === undefined
                ? {}
                : { timeoutMs: spec.timeout_ms }),
        }),
    }));
}

function registerConfiguredHooks(hooks: ToolHooks, config: VeraConfig): void {
    for (const command of configuredCommands(config)) {
        switch (command.phase) {
            case "session_start":
                hooks.registerSessionStart(command.run as SessionStartHook);
                break;
            case "pre_tool_use":
                hooks.registerPreToolUse(command.run as PreToolUseHook);
                break;
            case "post_tool_use":
                hooks.registerPostToolUse(command.run as PostToolUseHook);
                break;
            case "pre_turn":
                hooks.registerPreTurn(command.run as PreTurnHook, command.name);
                break;
            case "turn_ending":
                hooks.registerTurnEnding(command.run as TurnEndingHook, command.name);
                break;
            // Observers are not per session; the registry's notify callbacks run them.
            case "pre_compact":
            case "context_size_trigger":
            case "session_end":
            case "subagent_finished":
                break;
        }
    }
}

function configuredObservers<Hook>(
    config: VeraConfig,
    phase: "pre_compact" | "context_size_trigger" | "session_end" | "subagent_finished",
): readonly { readonly extensionId: string; readonly run: Hook }[] {
    return configuredCommands(config)
        .filter((command) => command.phase === phase)
        .map((command) => ({ extensionId: command.name, run: command.run as Hook }));
}

