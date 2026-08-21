import { stdin, stdout } from "node:process";

import { listAgentsThroughHost } from "../../src/host/agent-list-client.ts";
import {
    createAgentThroughHost,
    resumeAgentThroughHost,
} from "../../src/host/agent-start-client.ts";
import { findOrStartResidentHost } from "../host/launch.ts";
import { attachReconnectingAgent } from "../../src/host/reconnecting-agent-client.ts";
import {
    resolveResumeTarget,
} from "../tui/session-target.ts";
import { runAttachedStdioBridge } from "./ndjson-bridge.ts";

export interface StdioCreateTarget {
    readonly type: "create";
}

export interface StdioAttachTarget {
    readonly type: "attach";
    readonly agentId: string;
}

export interface StdioResumeTarget {
    readonly type: "resume";
    readonly selector: string;
}

export type StdioStartTarget =
    | StdioCreateTarget
    | StdioAttachTarget
    | StdioResumeTarget;

export function parseStdioArgs(
    args: readonly string[],
): StdioStartTarget | undefined {
    if (args.length === 1 && args[0] === "stdio") {
        return { type: "create" };
    }
    if (
        args.length === 3
        && args[0] === "stdio"
        && args[1] === "--attach"
        && args[2] !== undefined
        && args[2].length > 0
    ) {
        return { type: "attach", agentId: args[2] };
    }
    if (
        args.length === 3
        && args[0] === "stdio"
        && args[1] === "--resume"
        && args[2] !== undefined
        && args[2].length > 0
    ) {
        return { type: "resume", selector: args[2] };
    }
    return undefined;
}

export async function runStdioProcess(
    target: StdioStartTarget,
): Promise<void> {
    const host = await findOrStartResidentHost();
    const agentId = await resolveAgentId(host.socket_path, target);
    const client = await attachReconnectingAgent({
        socketPath: () => host.socket_path,
        agentId,
    });
    const stopping = new AbortController();
    const onSignal = (): void => stopping.abort();
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    try {
        await runAttachedStdioBridge(stdin, stdout, client, {
            signal: stopping.signal,
        });
    } finally {
        process.off("SIGINT", onSignal);
        process.off("SIGTERM", onSignal);
        if (!client.closed) client.close();
    }
}

async function resolveAgentId(
    socketPath: string,
    target: StdioStartTarget,
): Promise<string> {
    if (target.type === "create") {
        return (await createAgentThroughHost(
            socketPath,
            process.cwd(),
            undefined,
            undefined,
        )).id;
    }
    if (target.type === "attach") {
        return target.agentId;
    }

    const resolved = resolveResumeTarget(
        await listAgentsThroughHost(socketPath),
        target.selector,
    );
    return resolved.type === "attach"
        ? resolved.agentId
        : (await resumeAgentThroughHost(
            socketPath,
            resolved.sessionPath,
        )).id;
}
