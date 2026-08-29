import {
    startTui,
    type TuiAgentClient,
    type TuiDependencies,
} from "../../clients/tui/main.ts";
import { createInProcessChannel } from "../../src/engine/message-channel.ts";
import type { ClientCommand } from "../../src/engine/protocol.ts";
import { runHeadlessLoop } from "../../src/engine/run-turn.ts";
import type {
    AvailableModel,
    PooledModel,
} from "../../src/model/catalog-view.ts";
import { emptyUsage, type AssistantMessage } from "../../src/model/types.ts";
import { FauxAdapter } from "./faux-adapter.ts";
import { installTestProcessGuard } from "./self-terminate-guard.ts";

const PROVIDER = "openrouter";

/**
 * A fixture whose provider has a list to fetch, so the picker's refresh key
 * has somewhere to go. The second list is what the provider answers with.
 */
export function createTuiCatalogRefreshDependencies(
    options: {
        readonly pooled?: readonly PooledModel[];
        readonly poolAdmissionDelayMs?: number;
        readonly poolAdmissionSteps?: readonly {
            readonly step: string;
            readonly label: string;
            readonly status: "running" | "passed" | "failed" | "skipped";
            readonly detail?: string;
        }[];
        readonly onCommand?: (command: ClientCommand) => void;
    } = {},
): TuiDependencies {
    let pooled = options.pooled ?? [];
    let availableModels: readonly AvailableModel[] = [
        {
            provider: PROVIDER,
            model: "one/model",
            label: "One",
            description: "the list before the refresh",
            refreshable: true,
            levels: [],
        },
    ];
    const settings = () => ({
        provider: PROVIDER,
        model: "one/model",
        availableModels,
        refreshableProviders: [PROVIDER],
        ...(options.pooled === undefined
            && options.poolAdmissionDelayMs === undefined
            ? {}
            : { pooled }),
    });
    const channel = createInProcessChannel();
    void runHeadlessLoop(
        channel.engine,
        new FauxAdapter([response("REFRESH FIXTURE")], { chunkSize: 1 }),
        "one/model",
        undefined,
        {
            approvalMode: "auto",
        },
        {
            readModelSettings: settings,
            readApprovalMode: () => "auto",
            updateApprovalMode: async () => "auto",
            router: {
                updateModelSettings: async () => settings(),
                ...(options.poolAdmissionDelayMs === undefined
                    ? {}
                    : {
                        poolAdd: async (
                            entry: {
                                readonly provider: string;
                                readonly model: string;
                            },
                            onStep,
                            admission,
                        ) => {
                            if (admission?.verify === true) {
                                for (
                                    const step of options.poolAdmissionSteps ?? []
                                ) {
                                    onStep(step);
                                }
                            }
                            await Bun.sleep(options.poolAdmissionDelayMs ?? 0);
                            pooled = [{
                                provider: entry.provider,
                                model: entry.model,
                                label: entry.model,
                                available: true,
                                verified: false,
                                levels: [],
                            }, ...pooled.filter((candidate) =>
                                candidate.provider !== entry.provider
                                || candidate.model !== entry.model
                            )];
                            return {
                                verdict: "added" as const,
                                settings: settings(),
                            };
                        },
                    }),
                refreshCatalog: async (provider) => {
                    if (provider !== PROVIDER) {
                        return undefined;
                    }
                    availableModels = [
                        ...availableModels,
                        {
                            provider: PROVIDER,
                            model: "two/model",
                            label: "Two",
                            description: "arrived with the refresh",
                            refreshable: true,
                            levels: [],
                        },
                    ];
                    return settings();
                },
            },
        },
    );

    const client: TuiAgentClient = {
        async send(command): Promise<void> {
            options.onCommand?.(command);
            channel.client.send(command);
        },
        receive(signal) {
            return channel.client.receive(signal);
        },
        async detach(): Promise<void> {},
        close(): void {},
    };

    return { client };
}

if (import.meta.main) {
    installTestProcessGuard();
    await startTui(createTuiCatalogRefreshDependencies());
}

function response(text: string): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text }],
        source: {
            provider: PROVIDER,
            api: "openai-chat-completions",
            model: "one/model",
        },
        usage: emptyUsage(),
        stopReason: "stop",
    };
}
