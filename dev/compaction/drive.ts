/**
 * Developer-only test harness for Vera's context compaction.
 *
 * It sends a scripted sequence of prompts through one real model session,
 * forces compaction at configurable token thresholds, and prints a JSON report
 * of each turn and compaction attempt. Use it for provider-backed experiments
 * and automated checks; Vera does not call it in normal operation.
 *
 *     bun run dev/compaction/drive.ts --provider <provider> --model <id> \
 *         --prompts <file|-> [--capacity <tokens|unknown>] \
 *         [--trigger-tokens <n>] [--trigger-fraction <0..1>] \
 *         [--target-tokens <n>]
 *
 * The budget flags are the profile knobs, so a scenario can fire compaction
 * after a few small turns instead of filling a real window. Any of them builds
 * a profile; none of them binds the way an unconfigured session does.
 *
 * Runs a scripted multi-turn session with compaction bound, which no shipped
 * entry point does: `vera -p` binds compaction but sends one prompt, and
 * `vera rpc` takes many prompts but binds no compaction. Compaction needs at
 * least three prompts to have anything to summarize, since the boundary keeps
 * the last two user turns verbatim.
 *
 * Provider keys come from the environment only; nothing here reads stored
 * credentials, config, or the pool. Approvals are answered with a denial, so
 * an unattended run can never block on one and never runs a tool the script
 * did not ask for; pass `--approval full_access` to let tools run.
 *
 * Exactly one JSON document goes to stdout. A session that fails to compact,
 * or fails outright, is still a valid document (exit 0); only a usage error,
 * an unknown provider, or an unreadable prompt script exit nonzero, so the
 * caller can tell "compaction did not happen" from "this invocation was
 * wrong".
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { VeraConfig } from "../../src/config.ts";
import type {
    ResolvedCompactionProfile,
    VeraCatalogModel,
} from "../../src/config/model-catalog.ts";
import {
    BUNDLED_COMPACTION_STRATEGIES,
    DEFAULT_COMPACTION_STRATEGY_ID,
    bindCompaction,
} from "../../src/engine/compaction-binding.ts";
import type { MessageChannel } from "../../src/engine/message-channel.ts";
import type { ModelTurnSettings } from "../../src/engine/model-settings.ts";
import type { AgentUpdate, ClientCommand } from "../../src/engine/protocol.ts";
import { AsyncQueue } from "../../src/engine/async-queue.ts";
import { runHeadlessLoop } from "../../src/engine/run-turn.ts";
import type { ModelReasoningEffort } from "../../src/model/types.ts";
import { createConfiguredModelAdapter } from "../../src/providers/configured.ts";
import { ProviderRoutingAdapter } from "../../src/providers/routing.ts";
import { findProvider } from "../../src/providers/registry.ts";
import {
    DriveRecorder,
    hasBudgetOverride,
    parseArgs,
    parsePrompts,
    type CapacityOverride,
    type DriveArgs,
} from "./report.ts";

/** Ends the loop once the script is spent; nothing else stops a headless run. */
class ScriptEndedError extends Error {
    constructor() {
        super("prompt script ended");
        this.name = "ScriptEndedError";
    }
}

/**
 * The profile the budget knobs ride on. Built only when one was given, so a
 * run without them binds exactly the way an unconfigured session does.
 *
 * Every slot the strategy declares is routed to the session's own model, which
 * is what the default binding does anyway; the profile exists here to carry
 * the trigger and target, not to route a summary somewhere else.
 */
function compactionProfileFor(
    args: DriveArgs,
): ResolvedCompactionProfile | undefined {
    if (!hasBudgetOverride(args.budget)) {
        return undefined;
    }
    const strategy = BUNDLED_COMPACTION_STRATEGIES.find(
        (candidate) => candidate.id === DEFAULT_COMPACTION_STRATEGY_ID,
    );
    if (strategy === undefined) {
        throw new Error("the default compaction strategy is not bundled");
    }
    // Only the string is read downstream, where it selects a routed adapter.
    const provider = args.provider as VeraCatalogModel["provider"];
    const entry: VeraCatalogModel = {
        name: "drive",
        provider,
        model: args.model,
        ...(args.effort === undefined
            ? {}
            : { reasoning_effort: args.effort as VeraCatalogModel["reasoning_effort"] }),
    };
    const slots: Record<string, readonly VeraCatalogModel[]> = {};
    const routes: Record<string, string> = {};
    for (const slot of strategy.models) {
        slots[slot] = [entry];
        routes[slot] = "drive";
    }
    return {
        strategy: strategy.id,
        slots,
        routes,
        ...(args.budget.triggerFraction === undefined
            ? {}
            : { trigger_fraction: args.budget.triggerFraction }),
        ...(args.budget.triggerTokens === undefined
            ? {}
            : { trigger_tokens: args.budget.triggerTokens }),
        ...(args.budget.targetTokens === undefined
            ? {}
            : { target_tokens: args.budget.targetTokens }),
        ...(args.budget.retainedUserTurns === undefined
            ? {}
            : { retained_user_turns: args.budget.retainedUserTurns }),
    };
}

/**
 * `unknown` is expressed by withholding the provider as well as the window:
 * the engine falls through to the shipped catalog whenever it has a provider
 * to look the model up under, so a session with a provider always has a
 * capacity. The request keeps working because the routing adapter's default
 * provider is the one being driven.
 */
function modelSettingsFor(
    args: DriveArgs,
    capacity: CapacityOverride,
): ModelTurnSettings {
    const effort = args.effort as ModelReasoningEffort | undefined;
    if (capacity.mode === "unknown") {
        return {
            model: args.model,
            ...(effort === undefined ? {} : { reasoningEffort: effort }),
        };
    }
    return {
        provider: args.provider,
        model: args.model,
        ...(effort === undefined ? {} : { reasoningEffort: effort }),
        ...(capacity.mode === "fixed" ? { contextWindow: capacity.tokens } : {}),
    };
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    if (findProvider(args.provider) === undefined) {
        throw new Error(`unknown provider: ${args.provider}`);
    }
    const source = args.promptsPath === "-"
        ? await Bun.file(0).text()
        : await Bun.file(args.promptsPath).text();
    const prompts = parsePrompts(source);

    const adapter = new ProviderRoutingAdapter(
        (provider) => createConfiguredModelAdapter(
            { provider } as VeraConfig,
            { env: process.env },
        ),
        args.provider,
    );
    const compaction = bindCompaction(
        compactionProfileFor(args),
        adapter,
        { provider: args.provider, model: args.model },
        BUNDLED_COMPACTION_STRATEGIES,
    );
    if (compaction === undefined) {
        throw new Error("no compaction strategy could be bound");
    }

    const sessionPath = args.sessionPath
        ?? join(mkdtempSync(join(tmpdir(), "vera-compaction-")), "session.jsonl");
    const recorder = new DriveRecorder(prompts);
    const commands = new AsyncQueue<ClientCommand>();
    let next = 0;
    const release = (): void => {
        const prompt = prompts[next];
        if (prompt === undefined) {
            commands.fail(new ScriptEndedError());
            return;
        }
        next += 1;
        recorder.beginTurn();
        commands.push({ type: "prompt", content: prompt });
    };

    const endpoint: MessageChannel<AgentUpdate, ClientCommand> = {
        send(update): void {
            if (update.type === "ui_request") {
                commands.push({
                    type: "ui_response",
                    requestId: update.requestId,
                    response: update.request.type === "tool_approval"
                        ? { type: "tool_approval", decision: "deny" }
                        : { type: "user_question", outcome: "cancelled" },
                });
                return;
            }
            if (recorder.observe(update)) {
                release();
            }
        },
        receive(signal?: AbortSignal): Promise<ClientCommand> {
            return commands.receive(signal);
        },
    };

    release();
    try {
        await runHeadlessLoop(
            endpoint,
            adapter,
            args.model,
            args.effort as ModelReasoningEffort | undefined,
            {
                sessionPath,
                approvalMode: args.approvalMode,
                compaction,
                enableUserInteraction: false,
                readModelSettings: () => modelSettingsFor(args, args.capacity),
            },
        );
    } catch (error) {
        if (!(error instanceof ScriptEndedError)) {
            recorder.fail(error instanceof Error ? error.message : String(error));
        }
    }

    const report = recorder.build({
        provider: args.provider,
        model: args.model,
        ...(args.effort === undefined ? {} : { effort: args.effort }),
        approval_mode: args.approvalMode,
        capacity: args.capacity,
        budget: args.budget,
        bound: compaction,
        session_path: sessionPath,
    });
    process.stdout.write(`${JSON.stringify(report)}\n`);
}

main().catch((error: unknown) => {
    process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
});
