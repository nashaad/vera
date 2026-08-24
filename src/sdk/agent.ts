import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import {
    configuredModelFallback,
    loadVeraConfig,
    type VeraConfig,
} from "../config.ts";
import { runHeadlessLoop } from "../engine/run-turn.ts";
import type { SessionModelUsage } from "../engine/protocol.ts";
import type {
    ModelAdapter,
    ModelReasoningEffort,
    ModelSubstitution,
} from "../model/types.ts";
import { createConfiguredModelAdapter } from "../providers/configured.ts";
import { createAuthStorage } from "../providers/auth-storage.ts";
import {
    VERA_PROFILE_ENV,
    veraProfileDirectory,
} from "../profile-paths.ts";
import {
    ResidentAgent,
    ResidentAgentClosedError,
} from "../host/resident-agent.ts";

export interface VeraCreateOptions {
    /** Profile to read without changing the process-wide VERA_PROFILE value. */
    readonly profile?: string;
    /** Default workspace for agents created by this Vera instance. */
    readonly workspace?: string;
    /** An already parsed config, primarily for embedding and tests. */
    readonly config?: VeraConfig;
    /** Adapter construction seam for custom runtimes and deterministic tests. */
    readonly createAdapter?: (
        config: VeraConfig,
        workspace: string,
    ) => ModelAdapter;
}

export interface VeraAgentOptions {
    readonly workspace?: string;
    readonly provider?: string;
    readonly model?: string;
    readonly reasoningEffort?: ModelReasoningEffort;
}

export interface AgentRunOptions {
    readonly signal?: AbortSignal;
}

export type AgentRunOutcome = "completed" | "failed" | "aborted";

export interface AgentRunResult {
    readonly outcome: AgentRunOutcome;
    readonly text: string;
    readonly model: {
        readonly provider: string;
        readonly model: string;
    };
    readonly usage?: SessionModelUsage;
    readonly substitutions: readonly ModelSubstitution[];
    readonly error?: string;
}

interface ResolvedAgentOptions {
    readonly workspace: string;
    readonly config: VeraConfig;
    readonly model: string;
    readonly reasoningEffort?: ModelReasoningEffort;
    readonly createAdapter: (config: VeraConfig, workspace: string) => ModelAdapter;
}

/**
 * Host-independent Vera runtime for ordinary application code.
 *
 * This is deliberately above the engine loop and below workflow policy. A
 * caller owns sequencing with normal TypeScript; each agent run owns one
 * bounded, tool-free Vera turn.
 */
export class Vera {
    private constructor(
        private readonly config: VeraConfig,
        private readonly workspace: string,
        private readonly createAdapter: (
            config: VeraConfig,
            workspace: string,
        ) => ModelAdapter,
    ) {}

    static async create(options: VeraCreateOptions = {}): Promise<Vera> {
        const workspace = options.workspace ?? process.cwd();
        const config = options.config ?? loadVeraConfig({
            path: profileConfigPath(options.profile),
            projectRoot: workspace,
        });
        const authStorage = createAuthStorage();
        const createAdapter = options.createAdapter
            ?? ((selected: VeraConfig, selectedWorkspace: string): ModelAdapter =>
                createConfiguredModelAdapter(selected, {
                    authStorage,
                    projectRoot: selectedWorkspace,
                }));
        return new Vera(config, workspace, createAdapter);
    }

    agent(options: VeraAgentOptions = {}): Agent {
        const provider = options.provider ?? this.config.provider;
        const selectedConfig: VeraConfig = {
            ...this.config,
            provider,
            model: options.model ?? this.config.model,
            ...(provider === this.config.provider ? {} : { fallback: undefined }),
        };
        return new Agent({
            workspace: options.workspace ?? this.workspace,
            config: selectedConfig,
            model: selectedConfig.model,
            reasoningEffort: options.reasoningEffort
                ?? selectedConfig.reasoning_effort,
            createAdapter: this.createAdapter,
        });
    }
}

export class Agent {
    constructor(private readonly options: ResolvedAgentOptions) {}

    async run(prompt: string, options: AgentRunOptions = {}): Promise<AgentRunResult> {
        if (prompt.trim().length === 0) {
            throw new Error("Agent prompt must not be empty");
        }
        options.signal?.throwIfAborted();

        const temporaryDirectory = await mkdtemp(join(tmpdir(), "vera-sdk-"));
        const id = randomUUID();
        const resident = new ResidentAgent(id, this.options.workspace);
        const attachment = resident.attach();
        let text = "";
        let usage: SessionModelUsage | undefined;
        let outcome: AgentRunOutcome = "completed";
        let error: string | undefined;
        const substitutions: ModelSubstitution[] = [];
        let loop: Promise<void> | undefined;
        let loopFailure: unknown;
        const abort = (): void => {
            try {
                attachment.send({ type: "abort" });
            } catch {
                // A turn that has already settled needs no second cancellation.
            }
        };
        try {
            const adapter = this.options.createAdapter(
                this.options.config,
                this.options.workspace,
            );
            loop = runHeadlessLoop(
                resident.engine,
                adapter,
                this.options.model,
                this.options.reasoningEffort,
                {
                    sessionPath: join(temporaryDirectory, `${id}.jsonl`),
                    approvalMode: "full_access",
                    offerTools: false,
                    loadOptionalContext: false,
                    instructionRoot: {
                        path: this.options.workspace,
                        source: "workspace",
                    },
                },
                {
                    readModelSettings: () => ({
                        provider: this.options.config.provider,
                        model: this.options.model,
                        ...(this.options.reasoningEffort === undefined
                            ? {}
                            : {
                                reasoningEffort:
                                    this.options.reasoningEffort,
                            }),
                    }),
                    readPolicy: () => ({
                        modelFallback:
                            configuredModelFallback(this.options.config),
                    }),
                },
            ).catch((caught: unknown) => {
                loopFailure = caught;
                resident.fail(
                    randomUUID(),
                    caught instanceof Error ? caught.message : String(caught),
                );
            });
            if (options.signal?.aborted === true) {
                abort();
            } else {
                options.signal?.addEventListener("abort", abort, { once: true });
            }
            resident.sendPrompt(prompt);
            for (;;) {
                const update = await attachment.receive();
                if (update.type === "assistant_delta") {
                    text += update.text;
                    continue;
                }
                if (update.type === "model_substitution") {
                    substitutions.push(update);
                    continue;
                }
                if (update.type === "agent_failed") {
                    outcome = "failed";
                    error = update.detail;
                    break;
                }
                if (update.type !== "turn_finished") continue;
                usage = update.usage;
                if (update.outcome === "aborted") outcome = "aborted";
                if (update.outcome === "error") outcome = "failed";
                error = update.error;
                break;
            }
        } finally {
            options.signal?.removeEventListener("abort", abort);
            attachment.detach();
            resident.close();
            try {
                await loop;
                if (
                    loopFailure !== undefined
                    && outcome !== "failed"
                    && !(loopFailure instanceof ResidentAgentClosedError)
                ) {
                    throw loopFailure;
                }
            } finally {
                await rm(temporaryDirectory, { recursive: true, force: true });
            }
        }

        const used = usage?.rows.at(-1);
        return {
            outcome,
            text,
            model: {
                provider: used?.provider ?? this.options.config.provider,
                model: used?.model ?? this.options.model,
            },
            ...(usage === undefined ? {} : { usage }),
            substitutions,
            ...(error === undefined ? {} : { error }),
        };
    }
}

function profileConfigPath(profile: string | undefined): string | undefined {
    if (profile === undefined) return undefined;
    return join(
        veraProfileDirectory({
            ...process.env,
            [VERA_PROFILE_ENV]: profile,
        }),
        "config.json",
    );
}
