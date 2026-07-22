#!/usr/bin/env bun

// This is the installed command dispatcher; the interactive client lives in ../tui.

import { stderr, stdout } from "node:process";

import { abortAgentThroughHost } from "../../src/host/agent-abort-client.ts";
import type { RegisteredAgentSummary } from "../../src/host/agent-registry.ts";
import { listAgentsThroughHost } from "../../src/host/agent-list-client.ts";
import { sendPromptThroughHost } from "../../src/host/agent-send-client.ts";
import {
    createHostLockfile,
    HostProtocolMismatchError,
} from "../../src/host/lockfile.ts";
import { runNdjsonProcess } from "../stdio/ndjson-process.ts";
import { loginOpenAICodex } from "../../src/providers/openai-codex-oauth.ts";
import {
    exportSession,
    type SessionExportFormat,
} from "../../src/session-export.ts";
import type { TuiStartTarget } from "../tui/main.ts";
import { renderCliHelp, renderCliUsage } from "./help.ts";

interface CliOutput {
    write(text: string): unknown;
}

export interface CliDependencies {
    readonly abortAgent?: (agentId: string) => Promise<void>;
    readonly listAgents?: () => Promise<readonly RegisteredAgentSummary[]>;
    readonly sendPrompt?: (
        agentId: string,
        content: string,
    ) => Promise<string>;
    readonly exportSession?: (
        sessionPath: string,
        format: SessionExportFormat,
    ) => Promise<string>;
    readonly stdout?: CliOutput;
    readonly stderr?: CliOutput;
    readonly runRpc?: () => Promise<void>;
    readonly runTui?: (target: TuiStartTarget) => Promise<void>;
    readonly runOpenAICodexLogin?: (
        onAuthorizationUrl: (url: string) => void,
    ) => Promise<void>;
    readonly version?: string;
}

export async function runCli(
    args: readonly string[],
    dependencies: CliDependencies = {},
): Promise<number> {
    const output = dependencies.stdout ?? stdout;
    const errorOutput = dependencies.stderr ?? stderr;
    const runTui = dependencies.runTui ?? runConfiguredTui;

    if (
        args.length === 1
        && (args[0] === "--help" || args[0] === "-h")
    ) {
        output.write(renderCliHelp());
        return 0;
    }

    if (
        args.length === 1
        && (args[0] === "--version" || args[0] === "-v")
    ) {
        output.write(`vera ${dependencies.version ?? sourceVersion()}\n`);
        return 0;
    }

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

    const exportRequest = parseExportRequest(args);
    if (exportRequest !== undefined) {
        const rendered = await (dependencies.exportSession ?? exportSession)(
            exportRequest.sessionPath,
            exportRequest.format,
        );
        output.write(rendered);
        return 0;
    }

    if (
        args.length >= 3
        && args[0] === "send"
        && typeof args[1] === "string"
        && args[1].length > 0
    ) {
        const content = args.slice(2).join(" ");
        if (content.length > 0) {
            const response = await (dependencies.sendPrompt ?? sendLivePrompt)(
                args[1],
                content,
            );
            output.write(`${response}\n`);
            return 0;
        }
    }

    if (
        args.length === 2
        && args[0] === "abort"
        && typeof args[1] === "string"
        && args[1].length > 0
    ) {
        await (dependencies.abortAgent ?? abortLiveAgent)(args[1]);
        output.write(`Abort requested for ${args[1]}.\n`);
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

    errorOutput.write(renderCliUsage());
    return 1;
}

function parseExportRequest(
    args: readonly string[],
): { readonly sessionPath: string; readonly format: SessionExportFormat } | undefined {
    if (args[0] !== "export" || typeof args[1] !== "string" || args[1].length === 0) {
        return undefined;
    }
    if (args.length === 2) {
        return { sessionPath: args[1], format: "markdown" };
    }
    if (
        args.length === 4
        && args[2] === "--format"
        && (args[3] === "markdown" || args[3] === "json")
    ) {
        return { sessionPath: args[1], format: args[3] };
    }
    return undefined;
}

export async function runCliMain(
    args: readonly string[],
    dependencies: CliDependencies = {},
): Promise<number> {
    try {
        return await runCli(args, dependencies);
    } catch (error) {
        const output = dependencies.stderr ?? stderr;
        output.write(`${renderCliFailure(error)}\n`);
        return 1;
    }
}

export function renderCliFailure(error: unknown): string {
    if (error instanceof HostProtocolMismatchError) {
        return `Vera host upgrade required: ${error.message}`;
    }
    return `Vera failed: ${
        error instanceof Error ? error.message : String(error)
    }`;
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

async function sendLivePrompt(
    agentId: string,
    content: string,
): Promise<string> {
    const host = await createHostLockfile().read();
    if (host === undefined) {
        throw new Error("No live Vera host");
    }
    return sendPromptThroughHost(host.socket_path, agentId, content);
}

async function abortLiveAgent(agentId: string): Promise<void> {
    const host = await createHostLockfile().read();
    if (host === undefined) {
        throw new Error("No live Vera host");
    }
    await abortAgentThroughHost(host.socket_path, agentId);
}

async function runConfiguredTui(target: TuiStartTarget): Promise<void> {
    const { startConfiguredTui } = await import("../tui/main.ts");
    await startConfiguredTui(target);
}

function sourceVersion(): string {
    const revision = Bun.spawnSync(
        ["git", "rev-parse", "--short", "HEAD"],
        {
            cwd: import.meta.dir,
            stdout: "pipe",
            stderr: "ignore",
        },
    );
    if (revision.exitCode !== 0) {
        return "source";
    }
    const value = revision.stdout.toString().trim();
    if (value.length === 0) {
        return "source";
    }
    const status = Bun.spawnSync(
        ["git", "status", "--porcelain", "--untracked-files=normal"],
        {
            cwd: import.meta.dir,
            stdout: "pipe",
            stderr: "ignore",
        },
    );
    const dirty = status.exitCode === 0 && status.stdout.length > 0
        ? "+dirty"
        : "";
    return `source ${value}${dirty}`;
}

if (import.meta.main) {
    process.exitCode = await runCliMain(process.argv.slice(2));
}
