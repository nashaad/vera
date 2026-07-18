#!/usr/bin/env bun

// This is the installed command dispatcher; the interactive client lives in ../tui.

import { stderr, stdout } from "node:process";

import type { RegisteredAgentSummary } from "../../src/host/agent-registry.ts";
import { listAgentsThroughHost } from "../../src/host/agent-list-client.ts";
import { createHostLockfile } from "../../src/host/lockfile.ts";
import { runNdjsonProcess } from "../stdio/ndjson-process.ts";
import { loginOpenAICodex } from "../../src/providers/openai-codex-oauth.ts";
import type { TuiStartTarget } from "../tui/main.ts";

interface CliOutput {
    write(text: string): unknown;
}

export interface CliDependencies {
    readonly listAgents?: () => Promise<readonly RegisteredAgentSummary[]>;
    readonly stdout?: CliOutput;
    readonly stderr?: CliOutput;
    readonly runRpc?: () => Promise<void>;
    readonly runTui?: (target: TuiStartTarget) => Promise<void>;
    readonly runOpenAICodexLogin?: (
        onAuthorizationUrl: (url: string) => void,
    ) => Promise<void>;
}

export async function runCli(
    args: readonly string[],
    dependencies: CliDependencies = {},
): Promise<number> {
    const output = dependencies.stdout ?? stdout;
    const errorOutput = dependencies.stderr ?? stderr;
    const runTui = dependencies.runTui ?? runConfiguredTui;

    if (args.length === 0) {
        await runTui({ type: "create", workspace: process.cwd() });
        return 0;
    }

    if (
        args.length === 2
        && args[0] === "attach"
        && typeof args[1] === "string"
        && args[1].length > 0
    ) {
        await runTui({ type: "attach", agentId: args[1] });
        return 0;
    }

    if (
        args.length === 2
        && args[0] === "resume"
        && typeof args[1] === "string"
        && args[1].length > 0
    ) {
        await runTui({ type: "resume", sessionPath: args[1] });
        return 0;
    }

    if (args.length === 1 && args[0] === "ls") {
        const agents = await (dependencies.listAgents ?? listLiveAgents)();
        output.write(renderAgentList(agents));
        return 0;
    }

    if (args.length === 1 && args[0] === "rpc") {
        await (dependencies.runRpc ?? runNdjsonProcess)();
        return 0;
    }

    if (
        (args.length === 1 && args[0] === "login")
        || (args.length === 2
            && args[0] === "login"
            && args[1] === "openai-codex")
    ) {
        const runLogin = dependencies.runOpenAICodexLogin
            ?? (async (onAuthorizationUrl: (url: string) => void) => {
                await loginOpenAICodex({ onAuthorizationUrl });
            });
        await runLogin((url) => {
            output.write(`Open this URL to sign in:\n${url}\n`);
        });
        output.write("Logged in to OpenAI Codex.\n");
        return 0;
    }

    errorOutput.write(
        "Usage: vera [attach <agent-id>|resume <session-path>|ls|rpc|login [openai-codex]]\n",
    );
    return 1;
}

export function renderAgentList(
    agents: readonly RegisteredAgentSummary[],
): string {
    if (agents.length === 0) {
        return "No live Vera agents.\n";
    }

    const rows = agents.map((agent) => [
        agent.kind,
        agent.status,
        agent.workspace,
        agent.id,
        agent.session_path,
    ]);
    const headings = ["KIND", "STATUS", "WORKSPACE", "AGENT", "SESSION"];
    const widths = headings.map((heading, index) =>
        Math.max(heading.length, ...rows.map((row) => row[index]?.length ?? 0))
    );

    return [headings, ...rows]
        .map((row) => row
            .map((cell, index) => cell.padEnd(widths[index] ?? cell.length))
            .join("  ")
            .trimEnd())
        .join("\n") + "\n";
}

async function listLiveAgents(): Promise<readonly RegisteredAgentSummary[]> {
    const host = await createHostLockfile().read();
    return host === undefined
        ? []
        : listAgentsThroughHost(host.socket_path);
}

async function runConfiguredTui(target: TuiStartTarget): Promise<void> {
    const { startConfiguredTui } = await import("../tui/main.ts");
    await startConfiguredTui(target);
}

if (import.meta.main) {
    process.exitCode = await runCli(process.argv.slice(2));
}
