#!/usr/bin/env bun

// This is the installed command dispatcher; the interactive client lives in ../tui.

import { stderr, stdout } from "node:process";
import { createInterface } from "node:readline/promises";

import {
    isVeraProviderId,
    loadVeraConfig,
    VERA_PROVIDER_IDS,
    VeraConfigError,
    type VeraConfig,
} from "../../src/config.ts";
import { abortAgentThroughHost } from "../../src/host/agent-abort-client.ts";
import type { RegisteredAgentSummary } from "../../src/host/agent-registry.ts";
import { listAgentsThroughHost } from "../../src/host/agent-list-client.ts";
import {
    runOnceThroughHost,
    type RunOnceOutcome,
} from "../../src/host/run-once-client.ts";
import {
    createHostLockfile,
    HostProtocolMismatchError,
} from "../../src/host/lockfile.ts";
import { runNdjsonProcess } from "../stdio/ndjson-process.ts";
import { sourceVersion } from "../../src/build-info.ts";
import {
    exportSession,
    type SessionExportFormat,
} from "../../src/session-export.ts";
import { inspectLatestModelRequest } from "../../src/model-request-inspector.ts";
import { workspaceKey } from "../../src/workspace-key.ts";
import { relativeTime } from "../../src/relative-time.ts";import { supportedLevels } from "../../src/model/effort-ladder.ts";
import { isCuratedPoolEntry, providerOf } from "../../src/model/pool-file.ts";
import { loadPoolFile } from "../../src/model/pool-file-loader.ts";
import { readUserPoolFile, removePoolModel } from "../../src/model/pool-file-store.ts";
import { resolvePoolRef } from "../../src/model/pool-names.ts";
import {
    admitToPool,
    type PoolAdmissionOutcome,
    type PoolAdmissionStep,
} from "../../src/model/pool-admission.ts";
import { createConfiguredModelAdapter } from "../../src/providers/configured.ts";
import { createAuthStorage } from "../../src/providers/auth-storage.ts";

interface PoolAddOptions {
    readonly verify?: boolean;
    readonly onStep?: (step: PoolAdmissionStep) => void;
}
import type { TuiStartOptions, TuiStartTarget } from "../tui/main.ts";
import { renderCliHelp, renderCliUsage } from "./help.ts";

interface CliOutput {
    write(text: string): unknown;
}

export interface CliDependencies {
    readonly abortAgent?: (agentId: string) => Promise<void>;
    readonly listAgents?: () => Promise<readonly RegisteredAgentSummary[]>;
    readonly exportSession?: (
        sessionPath: string,
        format: SessionExportFormat,
    ) => Promise<string>;
    readonly inspectModelRequest?: (sessionPath: string) => Promise<string>;
    readonly stdout?: CliOutput;
    readonly stderr?: CliOutput;
    readonly runRpc?: () => Promise<void>;
    readonly runOnce?: (request: {
        readonly workspace: string;
        readonly prompt: string;
        readonly approvalMode?: string;
        readonly model?: string;
        readonly effort?: string;
    }) => Promise<RunOnceOutcome>;
    readonly runTui?: (
        target: TuiStartTarget,
        options?: TuiStartOptions,
    ) => Promise<void>;
    readonly confirmHostStop?: () => boolean | Promise<boolean>;
    readonly stopHost?: () => Promise<number | undefined>;
    readonly listPool?: (workspace: string) => Promise<string>;
    readonly addPoolModel?: (
        workspace: string,
        ref: string,
        options: PoolAddOptions,
    ) => Promise<PoolAdmissionOutcome>;
    readonly removePoolModel?: (workspace: string, ref: string) => Promise<void>;
    readonly version?: string;
}

export async function runCli(
    args: readonly string[],
    dependencies: CliDependencies = {},
): Promise<number> {
    const output = dependencies.stdout ?? stdout;
    const errorOutput = dependencies.stderr ?? stderr;
    const runTui = dependencies.runTui ?? runConfiguredTui;
    const assumeYes = args[0] === "--yes" || args[0] === "-y";
    if (assumeYes) args = args.slice(1);
    const tuiOptions: TuiStartOptions = {
        confirmBusyUpgrade: assumeYes ? () => true : confirmBusyHostUpgrade,
    };

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
        await runTui({ type: "create", workspace: process.cwd() }, tuiOptions);
        return 0;
    }

    if (args.length === 1 && args[0] === "-c") {
        await runTui({ type: "continue" }, tuiOptions);
        return 0;
    }

    if (
        args.length === 2
        && args[0] === "attach"
        && typeof args[1] === "string"
        && args[1].length > 0
    ) {
        await runTui({ type: "attach", agentId: args[1] }, tuiOptions);
        return 0;
    }

    if (
        args.length === 2
        && args[0] === "resume"
        && typeof args[1] === "string"
        && args[1].length > 0
    ) {
        await runTui({ type: "resume", sessionPath: args[1] }, tuiOptions);
        return 0;
    }

    if (args[0] === "-p") {
        const printRequest = parsePrintRequest(args);
        if (printRequest === undefined) {
            errorOutput.write(renderCliUsage());
            return 1;
        }
        const result = await (dependencies.runOnce ?? runOnceOnResidentHost)({
            workspace: process.cwd(),
            prompt: printRequest.prompt,
            ...printRequest.options,
        });
        if (result.text.length > 0) {
            output.write(`${result.text}\n`);
        }
        for (const note of result.notes) {
            errorOutput.write(`${note}\n`);
        }
        if (result.outcome === "completed") {
            return 0;
        }
        errorOutput.write(`${result.error ?? `Turn ${result.outcome}`}\n`);
        return 1;
    }

    if (
        args[0] === "ls"
        && (args.length === 1 || (args.length === 2 && args[1] === "--all"))
    ) {
        const all = args.length === 2;
        const agents = await (dependencies.listAgents ?? listLiveAgents)();
        // Scoped by workspace key rather than by path equality, so a session
        // started under a symlinked or differently-spelled path still lands in
        // the workspace the user is standing in.
        const here = workspaceKey(process.cwd());
        output.write(renderAgentList(
            all
                ? agents
                : agents.filter((agent) =>
                    workspaceKey(agent.workspace) === here
                ),
            { all },
        ));
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
        args.length === 2
        && args[0] === "inspect"
        && typeof args[1] === "string"
        && args[1].length > 0
    ) {
        const rendered = await (
            dependencies.inspectModelRequest ?? inspectLatestModelRequest
        )(args[1]);
        output.write(rendered);
        return 0;
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

    if (args.length === 2 && args[0] === "pool" && args[1] === "list") {
        output.write(await (dependencies.listPool ?? listPool)(process.cwd()));
        return 0;
    }

    if (
        (args.length === 3 || (args.length === 4 && args[3] === "--verify"))
        && args[0] === "pool"
        && args[1] === "add"
        && typeof args[2] === "string"
        && args[2].length > 0
    ) {
        const ref = args[2];
        const verify = args.length === 4;
        const outcome = await (dependencies.addPoolModel ?? addPoolRef)(
            process.cwd(),
            ref,
            {
                verify,
                onStep: (step) => errorOutput.write(poolAdmissionStep(step)),
            },
        );
        if (outcome.verdict !== "added") {
            errorOutput.write(poolAdmissionFailure(ref, outcome));
            return 1;
        }
        output.write(
            `${ref} added to the pool${verify ? " (verified)" : " (unverified)"}.\n`,
        );
        return 0;
    }

    if (
        args.length === 3
        && args[0] === "pool"
        && args[1] === "remove"
        && typeof args[2] === "string"
        && args[2].length > 0
    ) {
        const ref = args[2];
        await (dependencies.removePoolModel ?? removePoolRef)(
            process.cwd(),
            ref,
        );
        output.write(`${ref} removed from the pool.\n`);
        return 0;
    }

    const hostStopAssumeYes = assumeYes
        || (
            args.length === 3
            && args[0] === "host"
            && args[1] === "stop"
            && (args[2] === "--yes" || args[2] === "-y")
        );
    if (
        (args.length === 2 || hostStopAssumeYes)
        && args[0] === "host"
        && args[1] === "stop"
    ) {
        const confirmed = hostStopAssumeYes
            || await (
                dependencies.confirmHostStop ?? confirmResidentHostStop
            )();
        if (!confirmed) {
            output.write("Resident Vera host was not stopped.\n");
            return 0;
        }
        const pid = await (dependencies.stopHost ?? stopResidentHost)();
        output.write(pid === undefined
            ? "No resident Vera host is running.\n"
            : `Stopped resident Vera host PID ${pid}.\n`);
        return 0;
    }

    if (args[0] === "login" && args.length <= 2) {
        return runLogin(output);
    }

    errorOutput.write(renderCliUsage());
    return 1;
}

interface PrintRequest {
    readonly prompt: string;
    readonly options: {
        readonly approvalMode?: string;
        readonly model?: string;
        readonly effort?: string;
    };
}

/** The flags `-p` accepts, and the request field each one fills. */
const PRINT_FLAGS: Readonly<Record<string, "approvalMode" | "model" | "effort">> = {
    "--permission-mode": "approvalMode",
    "--model": "model",
    "--effort": "effort",
};

function parsePrintRequest(
    args: readonly string[],
): PrintRequest | undefined {
    const prompt = args[1];
    if (typeof prompt !== "string" || prompt.length === 0) {
        return undefined;
    }
    const options: Record<string, string> = {};
    for (let index = 2; index < args.length; index += 2) {
        const field = PRINT_FLAGS[args[index] ?? ""];
        const value = args[index + 1];
        if (
            field === undefined
            || typeof value !== "string"
            || value.length === 0
            || options[field] !== undefined
        ) {
            return undefined;
        }
        options[field] = value;
    }
    return { prompt, options };
}

async function runOnceOnResidentHost(request: {
    readonly workspace: string;
    readonly prompt: string;
    readonly approvalMode?: string;
    readonly model?: string;
    readonly effort?: string;
}): Promise<RunOnceOutcome> {
    const { findOrStartResidentHost } = await import("../host/launch.ts");
    const host = await findOrStartResidentHost();
    return runOnceThroughHost(host.socket_path, request);
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
        return `Vera host upgrade required: ${error.message}\n`
            + "Close the older Vera client and retry, or run 'vera host stop'.";
    }
    if (error instanceof VeraConfigError) {
        return `${error.message}\n`
            + `Fix or remove ${error.path} and run Vera again.`;
    }
    return `Vera failed: ${
        error instanceof Error ? error.message : String(error)
    }`;
}

async function stopResidentHost(): Promise<number | undefined> {
    const lockfile = createHostLockfile();
    try {
        const record = await lockfile.read();
        if (record === undefined) return undefined;
        process.kill(record.pid, "SIGTERM");
        return record.pid;
    } catch (error) {
        if (!(error instanceof HostProtocolMismatchError)) throw error;
        process.kill(error.pid, "SIGTERM");
        return error.pid;
    }
}

export function renderAgentList(
    agents: readonly RegisteredAgentSummary[],
    options: { readonly all?: boolean; readonly now?: Date } = {},
): string {
    if (agents.length === 0) {
        return options.all === true
            ? "No live Vera agents.\n"
            : "No Vera agents in this workspace. Use --all to see every one.\n";
    }

    const now = options.now ?? new Date();
    // The workspace column only earns its width when rows can differ in it.
    const headings = options.all === true
        ? ["KIND", "STATUS", "AGENT", "TITLE", "ACTIVE", "WORKSPACE"]
        : ["KIND", "STATUS", "AGENT", "TITLE", "ACTIVE"];
    const rows = agents.map((agent) => {
        const row = [
            agent.kind,
            // `idle` here would mean "the host is holding this session", which
            // is true of every session ever started and tells the reader
            // nothing.
            agent.status === "idle" && !agent.live ? "stopped" : agent.status,
            // The id is still what every other command takes, so it stands in
            // when a session predates naming.
            agent.name ?? agent.id,
            truncate(agent.title ?? "", 48),
            relativeTime(agent.updated_at, now, "-"),
        ];
        return options.all === true ? [...row, agent.workspace] : row;
    });
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

/** A title is a whole first prompt, which is too wide to sit in a column. */
function truncate(value: string, limit: number): string {
    return value.length <= limit ? value : `${value.slice(0, limit - 1)}\u2026`;
}


async function listLiveAgents(): Promise<readonly RegisteredAgentSummary[]> {
    const host = await createHostLockfile().read();
    return host === undefined
        ? []
        : listAgentsThroughHost(host.socket_path);
}

async function abortLiveAgent(agentId: string): Promise<void> {
    const host = await createHostLockfile().read();
    if (host === undefined) {
        throw new Error("No live Vera host");
    }
    await abortAgentThroughHost(host.socket_path, agentId);
}

async function listPool(workspace: string): Promise<string> {
    const pool = loadPoolFile({ projectRoot: workspace }).merged;
    return Object.entries(pool.models)
        .filter(([, entry]) => isCuratedPoolEntry(entry))
        .map(([id, entry]) => {
            const provider = providerOf(id) ?? "";
            const levels = supportedLevels(entry.efforts ?? {});
            return `${id}\t${provider}\tefforts=${levels.join(",") || "-"}`;
        })
        .join("\n")
        + "\n";
}

async function addPoolRef(
    _workspace: string,
    ref: string,
    options: PoolAddOptions,
): Promise<PoolAdmissionOutcome> {
    const parsed = parsePoolModelId(ref);
    if (parsed === undefined) {
        return {
            verdict: "unavailable",
            reason: "expected provider/model",
        };
    }
    if (!isVeraProviderId(parsed.provider)) {
        return {
            verdict: "unavailable",
            reason: `unknown provider "${parsed.provider}", expected one of `
                + VERA_PROVIDER_IDS.join(", "),
        };
    }
    if (options.verify !== true) {
        return admitToPool(parsed);
    }
    // Verification talks to the provider, so it needs the same config and
    // stored credentials the host builds its adapters from.
    const config = loadVeraConfig();
    const authStorage = createAuthStorage();
    return admitToPool(parsed, options.onStep, {
        verify: true,
        createAdapter: (provider) =>
            createConfiguredModelAdapter({
                ...config,
                provider: provider as VeraConfig["provider"],
            }, { authStorage }),
    });
}

function poolAdmissionStep(step: PoolAdmissionStep): string {
    const detail = step.detail === undefined ? "" : `: ${step.detail}`;
    return `  ${step.status.padEnd(7)} ${step.label}${detail}\n`;
}

async function removePoolRef(workspace: string, ref: string): Promise<void> {
    const pool = loadPoolFile({ projectRoot: workspace }).merged;
    const id = resolvePoolRef(pool, ref);
    if (id === undefined) {
        throw new Error(`Model "${ref}" is not in the pool`);
    }
    if (readUserPoolFile().models[id] === undefined) {
        throw new Error(`Model "${ref}" is not in the user pool file`);
    }
    removePoolModel(id);
}

function parsePoolModelId(
    ref: string,
): { readonly provider: string; readonly model: string } | undefined {
    const separator = ref.indexOf("/");
    if (separator <= 0 || separator === ref.length - 1) {
        return undefined;
    }
    return {
        provider: ref.slice(0, separator),
        model: ref.slice(separator + 1),
    };
}

function poolAdmissionFailure(
    ref: string,
    outcome: PoolAdmissionOutcome,
): string {
    const reason = outcome.reason === undefined ? "" : `: ${outcome.reason}`;
    return `${ref} was not added to the pool (${outcome.verdict})${reason}\n`;
}

async function runConfiguredTui(
    target: TuiStartTarget,
    options?: TuiStartOptions,
): Promise<void> {
    const { startConfiguredTui } = await import("../tui/main.ts");
    await startConfiguredTui(target, options);
}

/**
 * `vera login` is reserved for a Vera platform account, which does not exist
 * yet. It says so and does nothing.
 *
 * It is deliberately not a provider command. It used to run the Codex flow,
 * which made a bare `login` mean whichever provider happened to be built first.
 * Connecting a provider now lives in the model pane (ctrl+e), where the list of
 * them and the marks for what is already connected are visible at once.
 */
function runLogin(output: CliOutput): number {
    output.write(
        "Vera accounts are not available yet.\n"
        + "To connect a model provider, open Vera and press ctrl+e in the model pane.\n",
    );
    return 0;
}

async function confirmBusyHostUpgrade(): Promise<boolean> {
    if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try {
        const answer = await prompt.question(
            "An older Vera host is busy. Restart it and disconnect attached clients? [y/N] ",
        );
        return answer.trim().toLowerCase() === "y"
            || answer.trim().toLowerCase() === "yes";
    } finally {
        prompt.close();
    }
}

async function confirmResidentHostStop(): Promise<boolean> {
    if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try {
        const answer = await prompt.question(
            "Stop the resident Vera host and disconnect attached clients? [y/N] ",
        );
        return answer.trim().toLowerCase() === "y"
            || answer.trim().toLowerCase() === "yes";
    } finally {
        prompt.close();
    }
}

if (import.meta.main) {
    process.exitCode = await runCliMain(process.argv.slice(2));
}
