import {
    startTui,
    type TuiDependencies,
    type TuiAgentClient,
} from "../../clients/tui/main.ts";
import { createInProcessChannel } from "../../src/engine/message-channel.ts";
import { runHeadlessLoop } from "../../src/engine/run-turn.ts";
import {
    emptyUsage,
    type AssistantMessage,
} from "../../src/model/types.ts";
import { FauxAdapter } from "./faux-adapter.ts";
import type { VeraDoctorReport } from "../../clients/process-doctor.ts";
import { installTestProcessGuard } from "./self-terminate-guard.ts";
import type { ModelTurnSettings } from "../../src/engine/model-settings.ts";

export interface TuiChildOptions {
    /** The first doctor pass answers late with another PID, like a stale run. */
    readonly staleDoctor?: boolean;
    readonly sessionPath?: string;
    readonly resumeSessionPath?: string;
    readonly clientExtensions?: TuiDependencies["clientExtensions"];
    readonly modelSettings?: ModelTurnSettings;
}

export function createTuiChildDependencies(
    options: TuiChildOptions = {},
): TuiDependencies {
    const responses: AssistantMessage[] = [
        response(`PARTIAL ${"x".repeat(200)} FIRST-END`),
        thinkingResponse("WEIGHING THE ORDERINGS", "STEER WORKED"),
    ];
    const channel = createInProcessChannel();
    void runHeadlessLoop(
        channel.engine,
        new FauxAdapter(responses, { chunkSize: 1, delayMs: 40 }),
        "test",
        "high",
        {
            approvalMode: "auto",
            ...(options.sessionPath === undefined
                ? {}
                : { sessionPath: options.sessionPath }),
            ...(options.resumeSessionPath === undefined
                ? {}
                : { resumeSessionPath: options.resumeSessionPath }),
        },
        {
            readModelSettings: () =>
                options.modelSettings ?? {
                    model: "test",
                    reasoningEffort: "high",
                    contextWindow: 100,
                },
            readApprovalMode: () => "auto",
            updateApprovalMode: async () => undefined,
            router: {
                updateModelSettings: async () => undefined,
            },
        },
    );
    const client: TuiAgentClient = {
        async send(command): Promise<void> {
            channel.client.send(command);
        },
        receive(signal) {
            return channel.client.receive(signal);
        },
        async detach(): Promise<void> {},
        close(): void {},
    };

    let doctorChecks = 0;

    return {
        client,
        copyText: async () => undefined,
        doctor: async () => {
            doctorChecks += 1;
            if (options.staleDoctor === true && doctorChecks === 1) {
                await Bun.sleep(300);
                return doctorReport(1111);
            }
            return doctorReport(4242);
        },
        ...(options.clientExtensions === undefined
            ? {}
            : { clientExtensions: options.clientExtensions }),
    };
}

function doctorReport(pid: number): VeraDoctorReport {
    return {
        healthy: false,
        currentHostMissing: false,
        highCpuPercent: 50,
        processes: [{
            pid,
            ppid: 1,
            pgid: pid,
            elapsed: "01:23",
            cpuPercent: 98.7,
            startedAt: "Fri Aug 14 12:00:00 2026",
            command: "bun clients/host/main.ts",
            kind: "host",
            currentHost: false,
            knownProfileHost: false,
            sustainedHighCpu: true,
            stray: true,
        }],
    };
}

function thinkingResponse(
    reasoning: string,
    text: string,
): AssistantMessage {
    const message = response(text);
    return {
        ...message,
        content: [{ type: "thinking", text: reasoning }, ...message.content],
    };
}

function response(text: string): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: { ...emptyUsage(), inputTokens: 25 },
        stopReason: "stop",
    };
}

if (import.meta.main) {
    installTestProcessGuard();
    await startTui(createTuiChildDependencies({
        staleDoctor: process.env.VERA_TEST_STALE_DOCTOR === "1",
    }));
}
