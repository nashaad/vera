#!/usr/bin/env bun

// This is the installed command dispatcher; the interactive client lives in ../tui.

import { spawn } from "node:child_process";
import { join } from "node:path";
import { stderr, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

import {
    PINNED_BUILD_ENV,
    pinnedCliEntrypoint,
} from "../../src/host/pinned-build.ts";

import {
    isVeraProviderId,
    loadOptionalVeraConfig,
    startingVeraConfig,
    VeraConfigError,
    type VeraConfig,
} from "../../src/config.ts";
import { shippedProviderIds } from "../../src/providers/definitions.ts";
import { resolveAgentIdentifier } from "./agent-id.ts";
import { abortAgentThroughHost } from "../../src/host/agent-abort-client.ts";
import {
    closeAgentThroughHost,
    type CloseAgentResult,
} from "../../src/host/agent-close-client.ts";
import type { RegisteredAgentSummary } from "../../src/host/agent-registry.ts";
import { listAgentsThroughHost } from "../../src/host/agent-list-client.ts";
import {
    runOnceThroughHost,
    type RunOnceOutcome,
} from "../../src/host/run-once-client.ts";
import {
    createHostLockfile,
    HostBuildMismatchError,
    HostProtocolMismatchError,
    HostUnresponsiveError,
    assertMatchingHostBuild,
    type HostLockRecord,
} from "../../src/host/lockfile.ts";
import {
    forceStopResidentHost,
    gracefulStopResidentHost,
    type ForceStopOutcome,
} from "../../src/host/force-stop.ts";
import {
    type SupervisionReport,
    superviseHost,
} from "../../src/host/supervision.ts";
import { residentHostEntrypoint } from "../host/launch.ts";
import {
    parseStdioArgs,
    runStdioProcess,
    type StdioStartTarget,
} from "../stdio/process.ts";
import {
    dispatchToHostRelease,
    RetainedReleaseMissingError,
} from "../../src/release/dispatch.ts";
import { defaultInstallPrefix } from "../../src/release/layout.ts";
import { rollbackLocalInstall } from "../../src/release/rollback.ts";
import {
    HomeMigrationError,
    migrateHome,
    rollbackHomeMigration,
    type HomeMigrationResult,
} from "../../src/home-migration.ts";
import { formatVeraVersion, readStampedRelease } from "../../src/release/stamp.ts";
import {
    exportSession,
    type SessionExportFormat,
} from "../../src/session-export.ts";
import { inspectLatestModelRequest } from "../../src/model-request-inspector.ts";
import { workspaceKey } from "../../src/workspace-key.ts";
import {
    assertProfileLayout,
    unrecognisedHomeEntries,
    veraHomeDirectory,
    veraRuntimeDirectory,
    DEFAULT_PROFILE_NAME,
    VERA_PROFILE_ENV,
    VeraProfileError,
    veraProfileName,
} from "../../src/profile-paths.ts";
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
import {
    refreshProviderCatalogs,
    type CatalogRefreshOutcome,
} from "../../src/host/runtime.ts";

interface PoolAddOptions {
    readonly verify?: boolean;
    readonly onStep?: (step: PoolAdmissionStep) => void;
}
import type { TuiStartOptions, TuiStartTarget } from "../tui/main.ts";
import { renderCliHelp, renderCliUsage } from "./help.ts";
import {
    findHelpTopic,
    loadHelpCorpus,
    parseHelpRequest,
    renderHelpTopic,
    renderHelpUsage,
    renderLlmHelp,
    type HelpCorpus,
} from "./help-corpus.ts";
import { runScheduleCli } from "./schedule.ts";
import type { ScheduleOperation } from "../../src/scheduler/types.ts";
import { runScheduleOperationThroughHost } from "../../src/host/schedule-client.ts";
import type { StartupProfile } from "../../src/startup-profile.ts";
import { openFileInEditor, veraConfigPath } from "../editor.ts";
import {
    diagnoseVeraProcesses,
    livePidFromHostLockFile,
    renderVeraDoctor,
    colorizeVeraDoctor,
    stopStrayVeraProcesses,
    type DiagnosedVeraProcess,
    type VeraDoctorReport,
} from "../process-doctor.ts";
import {
    listLiveProcesses,
    renderVeraPrune,
    stopLivePid,
    type LiveProcessRecord,
} from "../../src/live-process.ts";
import {
    diagnoseProviders,
    renderProviderDoctor,
    type ProviderDoctorOptions,
    type ProviderDoctorReport,
} from "../provider-doctor.ts";
import {
    diagnoseTmuxSockets,
    renderTmuxSocketDoctor,
    sweepStaleTmuxSockets,
    type TmuxSocketReport,
    type TmuxSocketSweepResult,
} from "../tmux-socket-doctor.ts";
import {
    installExtension,
    listExtensions,
    removeExtension,
    setExtensionEnabled,
    type ExtensionManagerOperations,
} from "../../src/extensions/manager.ts";
import {
    extensionTarget,
    parseExtensionManagerCommand,
    renderExtensionInstallPreview,
    renderExtensionList,
    renderExtensionMutation,
} from "../../src/extensions/manager-command.ts";
const PROVIDER_CHECK_FLAG = "--check-providers";

/**
 * Provider diagnosis over the real config and the real credential store.
 * Offline unless `--check-providers` asked for a request.
 */
async function defaultProviderDoctor(
    options: ProviderDoctorOptions,
): Promise<ProviderDoctorReport> {
    // A machine that has never run Vera is diagnosed against what a first
    // start would give it, rather than being refused for having no file yet.
    // Doctor reports; it does not write one.
    return diagnoseProviders(loadOptionalVeraConfig() ?? startingVeraConfig(), {
        ...options,
        authStorage: createAuthStorage(),
    });
}

/**
 * The manual half of the catalog TTL: an ordinary start answers from the
 * snapshot, so this is how a user asks the providers right now.
 */
async function refreshDiscoveredCatalogs(): Promise<
    readonly CatalogRefreshOutcome[]
> {
    return refreshProviderCatalogs(
        loadOptionalVeraConfig() ?? startingVeraConfig(),
        { authStorage: createAuthStorage() },
    );
}

interface CliOutput {
    write(text: string): unknown;
}

function cliStreamWantsColor(output: CliOutput): boolean {
    if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "") {
        return false;
    }
    return "isTTY" in output && (output as { isTTY?: boolean }).isTTY === true;
}

export interface CliDependencies {
    readonly abortAgent?: (agentId: string) => Promise<void>;
    readonly closeAgent?: (agentId: string) => Promise<CloseAgentResult>;
    readonly listAgents?: () => Promise<readonly RegisteredAgentSummary[]>;
    readonly scheduleOperation?: (
        operation: ScheduleOperation,
    ) => Promise<Record<string, unknown>>;
    readonly exportSession?: (
        sessionPath: string,
        format: SessionExportFormat,
    ) => Promise<string>;
    readonly inspectModelRequest?: (sessionPath: string) => Promise<string>;
    readonly openConfigure?: () => Promise<void>;
    readonly stdout?: CliOutput;
    readonly stderr?: CliOutput;
    readonly superviseHost?: (
        action: "on" | "off" | "status",
    ) => SupervisionReport;
    readonly runPinnedBuild?: (
        args: readonly string[],
        output: CliOutput,
    ) => Promise<number | undefined>;
    readonly runStdio?: (target: StdioStartTarget) => Promise<void>;
    readonly runOnce?: (request: {
        readonly workspace: string;
        readonly prompt: string;
        readonly approvalMode?: string;
        readonly model?: string;
        readonly effort?: string;
        readonly startupProfile?: StartupProfile;
    }) => Promise<RunOnceOutcome>;
    readonly runTui?: (
        target: TuiStartTarget,
        options?: TuiStartOptions,
    ) => Promise<void>;
    readonly confirmHostStop?: () => boolean | Promise<boolean>;
    readonly stopHost?: () => Promise<ForceStopOutcome | undefined>;
    readonly forceStopHost?: () => Promise<ForceStopOutcome | undefined>;
    readonly doctor?: () => Promise<VeraDoctorReport>;
    readonly prune?: () => Promise<readonly LiveProcessRecord[]>;
    readonly confirmPruneProcess?: (
        process: LiveProcessRecord,
        currentHostPid?: number,
    ) => boolean | Promise<boolean>;
    readonly stopPruneProcess?: (pid: number) => number | Promise<number>;
    readonly tmuxSockets?: () => Promise<TmuxSocketReport>;
    readonly confirmStopStrayProcesses?: (
        strays: readonly DiagnosedVeraProcess[],
        straySocketCount?: number,
    ) => boolean | Promise<boolean>;
    readonly stopStrayProcesses?: (
        strays: readonly DiagnosedVeraProcess[],
    ) => number | Promise<number>;
    readonly sweepTmuxSockets?: (
        report: TmuxSocketReport,
    ) => TmuxSocketSweepResult | Promise<TmuxSocketSweepResult>;
    readonly providerDoctor?: (
        options: ProviderDoctorOptions,
    ) => Promise<ProviderDoctorReport>;
    readonly refreshCatalogs?: () => Promise<readonly CatalogRefreshOutcome[]>;
    readonly listPool?: (workspace: string) => Promise<string>;
    readonly addPoolModel?: (
        workspace: string,
        ref: string,
        options: PoolAddOptions,
    ) => Promise<PoolAdmissionOutcome>;
    readonly removePoolModel?: (workspace: string, ref: string) => Promise<void>;
    readonly extensionManager?: Partial<ExtensionManagerOperations>;
    readonly helpCorpus?: () => Promise<HelpCorpus>;
    readonly version?: string;
    readonly dispatchToHostRelease?: (
        argv: readonly string[],
    ) => Promise<number | undefined>;
    readonly rollbackInstall?: (prefix: string) => {
        readonly fromBuildId: string | undefined;
        readonly toBuildId: string;
    };
    readonly migrateHome?: (home: string) => HomeMigrationResult;
    readonly rollbackHomeMigration?: (home: string) => HomeMigrationResult;
}

export async function runCli(
    args: readonly string[],
    dependencies: CliDependencies = {},
): Promise<number> {
    const output = dependencies.stdout ?? stdout;
    const errorOutput = dependencies.stderr ?? stderr;
    const runTui = dependencies.runTui ?? runConfiguredTui;
    const originalArgs = args;
    const assumeYes = args[0] === "--yes" || args[0] === "-y";
    if (assumeYes) args = args.slice(1);
    const tuiOptions: TuiStartOptions = {
        confirmBusyUpgrade: assumeYes ? () => true : confirmBusyHostUpgrade,
    };

    if (
        args.length === 1
        && (args[0] === "help" || args[0] === "--help" || args[0] === "-h")
    ) {
        const corpus = await (dependencies.helpCorpus ?? loadHelpCorpus)();
        output.write(renderCliHelp(corpus));
        return 0;
    }

    if (args[0] === "help") {
        const request = parseHelpRequest(args);
        if (request === undefined) {
            errorOutput.write(renderHelpUsage());
            return 1;
        }
        const corpus = await (dependencies.helpCorpus ?? loadHelpCorpus)();
        if (request.llms) {
            output.write(renderLlmHelp(corpus));
            return 0;
        }
        if (request.topic === undefined) {
            output.write(renderCliHelp(corpus));
            return 0;
        }
        const topic = findHelpTopic(corpus, request.topic);
        if (topic === undefined) {
            errorOutput.write(
                `Unknown Vera help topic '${request.topic}'. Available topics: `
                    + `${corpus.topics.map((item) => item.slug).join(", ")}\n`
                    + renderHelpUsage(),
            );
            return 1;
        }
        output.write(renderHelpTopic(topic));
        return 0;
    }

    if (
        args.length === 1
        && (args[0] === "--version" || args[0] === "-v")
    ) {
        try {
            output.write(
                `${dependencies.version ?? formatVeraVersion(readStampedRelease())}\n`,
            );
            return 0;
        } catch (error) {
            errorOutput.write(
                `vera: ${error instanceof Error ? error.message : String(error)}\n`,
            );
            return 1;
        }
    }

    if (args[0] === "rollback") {
        return runRollbackCommand(args.slice(1), output, errorOutput, dependencies);
    }

    if (args[0] === "migrate-home") {
        return runMigrateHomeCommand(args.slice(1), output, errorOutput, dependencies);
    }

    const dispatched = await (dependencies.dispatchToHostRelease
        ?? ((argv: readonly string[]) => dispatchToHostRelease({ argv })))(originalArgs);
    if (dispatched !== undefined) {
        return dispatched;
    }

    if (args.length === 0) {
        await runTui({ type: "home", workspace: process.cwd() }, tuiOptions);
        return 0;
    }

    if (
        args.length === 1
        && (args[0] === "--bare" || args[0] === "--prompt-only")
    ) {
        await runTui({
            type: "create",
            workspace: process.cwd(),
            startupProfile: args[0] === "--bare" ? "bare" : "prompt_only",
        }, tuiOptions);
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

    const extensionRequest = parseExtensionManagerCommand(args);
    if (extensionRequest !== undefined) {
        if ("error" in extensionRequest) {
            errorOutput.write(`${extensionRequest.error}\n`);
            return 1;
        }
        if (extensionRequest.command.operation === "reload") {
            errorOutput.write(
                "Extension reload is available in the TUI as /extension reload.\n",
            );
            return 1;
        }
        const command = extensionRequest.command;
        const manager: ExtensionManagerOperations = {
            install: dependencies.extensionManager?.install ?? installExtension,
            list: dependencies.extensionManager?.list ?? listExtensions,
            setEnabled: dependencies.extensionManager?.setEnabled
                ?? setExtensionEnabled,
            remove: dependencies.extensionManager?.remove ?? removeExtension,
        };
        const target = extensionTarget(command, process.cwd());
        try {
            if (command.operation === "list") {
                output.write(renderExtensionList(manager.list({
                    ...(command.scope === "project"
                        ? { projectRoot: process.cwd() }
                        : {}),
                    scope: command.scope,
                })));
                return 0;
            }
            if (command.operation === "install") {
                const result = manager.install(command.source, target, {
                    dryRun: command.dryRun,
                });
                output.write(renderExtensionInstallPreview(result.preview));
                if (!command.dryRun) {
                    output.write(
                        `Installed ${result.record?.id ?? result.preview.id}`
                            + ` in the ${result.preview.scope} scope.\n`,
                    );
                    output.write(
                        "Restart the resident host to apply host-side capabilities.\n",
                    );
                }
                return 0;
            }
            if (command.operation === "enable" || command.operation === "disable") {
                const record = manager.setEnabled(
                    command.id,
                    command.operation === "enable",
                    target,
                );
                output.write(renderExtensionMutation(
                    command.operation,
                    record,
                    command.scope,
                ));
                output.write(
                    "Restart the resident host to apply host-side capabilities.\n",
                );
                return 0;
            }
            const record = manager.remove(command.id, target);
            output.write(renderExtensionMutation("remove", record, command.scope));
            output.write(
                "Restart the resident host to apply host-side capabilities.\n",
            );
            return 0;
        } catch (error) {
            errorOutput.write(`Extension operation failed: ${renderCliFailure(error)}\n`);
            return 1;
        }
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

    if (args.length === 1 && args[0] === "configure") {
        await (dependencies.openConfigure ?? (() =>
            openFileInEditor(veraConfigPath())))();
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

    if (
        args.length === 2
        && args[0] === "close"
        && typeof args[1] === "string"
        && args[1].length > 0
    ) {
        const target = resolveAgentIdentifier(
            args[1],
            await (dependencies.listAgents ?? listLiveAgents)(),
        );
        if (target.status === "ambiguous") {
            errorOutput.write(
                `Could not close ${args[1]}: more than one agent matches. `
                + `Name one of ${target.candidates.join(", ")}.\n`,
            );
            return 1;
        }
        const result = await (dependencies.closeAgent ?? closeLiveAgent)(
            target.id,
        );
        if (result.status === "closed") {
            output.write(result.sessionRetained
                ? `Closed ${target.label}. Its session is kept; `
                    + `resume it with 'vera resume ${target.id}'.\n`
                : `Closed ${target.label}. It was a temporary agent, so its `
                    + `session is gone and there is nothing to resume.\n`);
            return 0;
        }
        errorOutput.write(
            `Could not close ${target.label}: `
            + `${closeRejectionText(result.reason)}\n`,
        );
        return 1;
    }

    if (args[0] === "stdio") {
        const target = parseStdioArgs(args);
        if (target === undefined) {
            errorOutput.write(renderCliUsage());
            return 1;
        }
        await (dependencies.runStdio ?? runStdioProcess)(target);
        return 0;
    }

    if (args[0] === "prune") {
        if (args.length !== 1) {
            errorOutput.write(renderCliUsage());
            return 1;
        }
        const records = (await (dependencies.prune ?? (async () =>
            listLiveProcesses()
        ))()).filter((record) => record.pid !== process.pid);
        const currentHostPid = await livePidFromHostLockFile(
            join(veraRuntimeDirectory(), "host.json"),
        );
        output.write(renderVeraPrune(records, currentHostPid));
        if (records.length === 0) return 0;
        const confirm = dependencies.confirmPruneProcess;
        if (confirm === undefined && (!process.stdin.isTTY || !process.stdout.isTTY)) {
            errorOutput.write(
                "Prune needs a terminal to ask about each process.\n",
            );
            return 1;
        }
        let stopped = 0;
        for (const candidate of records) {
            const approved = await (confirm ?? confirmPruneProcess)(
                candidate,
                currentHostPid,
            );
            if (!approved) continue;
            const didStop = await (
                dependencies.stopPruneProcess ?? ((pid: number) =>
                    stopLivePid(pid) ? 1 : 0)
            )(candidate.pid);
            stopped += didStop;
        }
        output.write(
            stopped === 0
                ? "Left every listed process running.\n"
                : `Stopped ${stopped} process${stopped === 1 ? "" : "es"}.\n`,
        );
        return 0;
    }

    if (
        args[0] === "doctor"
        && args.slice(1).every((arg) =>
            arg === PROVIDER_CHECK_FLAG || arg === "--yes" || arg === "-y"
        )
    ) {
        const checkNetwork = args.includes(PROVIDER_CHECK_FLAG);
        const doctorAssumeYes = assumeYes || args.includes("--yes")
            || args.includes("-y");
        const report = await (
            dependencies.doctor ?? diagnoseVeraProcesses
        )();
        const sockets = await diagnoseDoctorTmuxSockets(dependencies);
        output.write(colorizeVeraDoctor(renderVeraDoctor(report), {
            color: cliStreamWantsColor(output),
        }));
        output.write(`\n${renderTmuxSocketDoctor(sockets)}`);
        const strays = report.processes.filter((process) => process.stray);
        const straySockets = sockets.sockets.filter((socket) => socket.stray);
        if (strays.length > 0 || straySockets.length > 0) {
            const confirmed = doctorAssumeYes || await (
                dependencies.confirmStopStrayProcesses
                    ?? confirmStopStrayVeraProcesses
            )(strays, straySockets.length);
            if (confirmed) {
                if (strays.length > 0) {
                    const stopped = await (
                        dependencies.stopStrayProcesses ?? stopStrayVeraProcesses
                    )(strays);
                    output.write(
                        `Stopped ${stopped} stray process${stopped === 1 ? "" : "es"}.\n`,
                    );
                }
                if (straySockets.length > 0) {
                    const swept = await (
                        dependencies.sweepTmuxSockets ?? sweepStaleTmuxSockets
                    )(sockets);
                    output.write(renderTmuxSocketSweep(swept));
                }
            } else {
                output.write("Left stray processes and leftover tmux sockets in place.\n");
            }
        }
        const providers = await (
            dependencies.providerDoctor ?? defaultProviderDoctor
        )({ checkNetwork });
        output.write(`\n${renderProviderDoctor(providers)}`);
        return report.healthy && sockets.healthy ? 0 : 1;
    }

    if (args[0] === "schedule") {
        const code = await runScheduleCli(
            args.slice(1),
            dependencies.scheduleOperation ?? scheduleOperationOnResidentHost,
            output,
        );
        if (code !== 0) errorOutput.write(renderCliUsage());
        return code;
    }

    if (args.length === 2 && args[0] === "models" && args[1] === "refresh") {
        const outcomes = await (
            dependencies.refreshCatalogs ?? refreshDiscoveredCatalogs
        )();
        for (const outcome of outcomes) {
            output.write(
                outcome.failure === undefined
                    ? `${outcome.provider}: ${outcome.models} models\n`
                    : `${outcome.provider}: failed (${
                        catalogRefreshFailure(outcome)
                    })\n`,
            );
        }
        // A refresh that reached nothing is not a success, and the exit code
        // is what a script reads.
        return outcomes.some((outcome) => outcome.failure === undefined)
            ? 0
            : 1;
    }

    if (args.length === 2 && args[0] === "shortlist" && args[1] === "list") {
        output.write(await (dependencies.listPool ?? listPool)(process.cwd()));
        return 0;
    }

    if (
        (args.length === 3 || (args.length === 4 && args[3] === "--verify"))
        && args[0] === "shortlist"
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
            `${ref} pinned to your shortlist${verify ? " (verified)" : " (unverified)"}.\n`,
        );
        return 0;
    }

    if (
        args.length === 3
        && args[0] === "shortlist"
        && args[1] === "remove"
        && typeof args[2] === "string"
        && args[2].length > 0
    ) {
        const ref = args[2];
        await (dependencies.removePoolModel ?? removePoolRef)(
            process.cwd(),
            ref,
        );
        output.write(`${ref} removed from your shortlist.\n`);
        return 0;
    }

    if (
        args[0] === "host"
        && args[1] === "stop"
        && args.slice(2).every((flag) =>
            flag === "--yes" || flag === "-y" || flag === "--force"
        )
    ) {
        const flags = args.slice(2);
        const force = flags.includes("--force");
        const hostStopAssumeYes = assumeYes
            || flags.includes("--yes")
            || flags.includes("-y");
        const confirmed = hostStopAssumeYes
            || await (
                dependencies.confirmHostStop ?? confirmResidentHostStop
            )();
        if (!confirmed) {
            output.write("Resident Vera host was not stopped.\n");
            return 0;
        }
        if (force) {
            const outcome = await (
                dependencies.forceStopHost ?? forceStopResidentHost
            )();
            if (outcome === undefined) {
                output.write("No resident Vera host is recorded.\n");
                return 0;
            }
            if (outcome.endedBy === "survived") {
                output.write(
                    `Resident Vera host PID ${outcome.pid} is still running`
                        + " after SIGKILL, which means it is stuck in the"
                        + " kernel. Its lockfile was left in place. Wait for"
                        + " the operation it is blocked on, or reboot.\n",
                );
                return 1;
            }
            output.write(`Stopped resident Vera host PID ${outcome.pid} (${
                outcome.endedBy === "sigkill"
                    ? "killed after it ignored SIGTERM"
                    : outcome.endedBy === "already_dead"
                    ? "it was already dead; cleared its lockfile"
                    : outcome.endedBy === "not_ours"
                    ? "that PID belongs to another process now; cleared its"
                        + " stale lockfile"
                    : "SIGTERM"
            }).\n`);
            return 0;
        }
        const outcome = await (dependencies.stopHost ?? gracefulStopResidentHost)();
        if (outcome === undefined) {
            output.write("No resident Vera host is running.\n");
            return 0;
        }
        if (outcome.endedBy === "survived") {
            output.write(
                `Resident Vera host PID ${outcome.pid} is still running. `
                    + "Run 'vera host stop --force' to kill it.\n",
            );
            return 1;
        }
        output.write(`Stopped resident Vera host PID ${outcome.pid}.\n`);
        return 0;
    }

    if (
        args[0] === "host"
        && args[1] === "supervise"
        && args.length <= 3
        && (args[2] === undefined || args[2] === "off" || args[2] === "status")
    ) {
        return runHostSupervision(args[2], output, errorOutput, dependencies);
    }

    if (args[0] === "login" && args.length <= 2) {
        return runLogin(output);
    }

    if (args[0] === "abort" || args[0] === "close") {
        errorOutput.write(
            `${args[0]} needs the id of a live agent. `
            + `Run 'vera ls' to see them, then 'vera ${args[0]} <agent-id>'.\n`,
        );
        return 1;
    }

    errorOutput.write(renderCliUsage());
    return 1;
}

function catalogRefreshFailure(outcome: CatalogRefreshOutcome): string {
    const failure = outcome.failure;
    const reason = failure === "missing_credential" ? "no credential"
        : failure === "authentication" ? "credential rejected"
        : failure === "malformed_response" ? "malformed response"
        : failure === "empty_response" ? "empty response"
        : failure === "persistence_failed" ? "could not save catalog"
        : failure === "invalid" ? "provider is not refreshable"
        : "provider unavailable";
    return outcome.keptModels === undefined
        ? reason
        : `${reason}; kept ${outcome.keptModels} cached models`;
}

interface PrintRequest {
    readonly prompt: string;
    readonly options: {
        readonly approvalMode?: string;
        readonly model?: string;
        readonly effort?: string;
        readonly startupProfile?: StartupProfile;
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
    const options: Record<string, string> & { startupProfile?: StartupProfile } = {};
    for (let index = 2; index < args.length;) {
        const flag = args[index];
        if (flag === "--bare" || flag === "--prompt-only") {
            if (options.startupProfile !== undefined) return undefined;
            options.startupProfile = flag === "--bare" ? "bare" : "prompt_only";
            index += 1;
            continue;
        }
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
        index += 2;
    }
    return { prompt, options };
}

async function runOnceOnResidentHost(request: {
    readonly workspace: string;
    readonly prompt: string;
    readonly approvalMode?: string;
    readonly model?: string;
    readonly effort?: string;
    readonly startupProfile?: StartupProfile;
}): Promise<RunOnceOutcome> {
    const { findOrStartResidentHost } = await import("../host/launch.ts");
    const host = await findOrStartResidentHost();
    return runOnceThroughHost(host.socket_path, request);
}

async function scheduleOperationOnResidentHost(
    operation: ScheduleOperation,
): Promise<Record<string, unknown>> {
    const { findOrStartResidentHost } = await import("../host/launch.ts");
    const host = await findOrStartResidentHost();
    return runScheduleOperationThroughHost(host.socket_path, operation);
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

/**
 * Consumed before dispatch so every path lookup downstream sees one profile,
 * including the ones reached through module-level defaults.
 */
/** The name `--profile` carries, without consuming the flag. */
export function namedProfileFlag(args: readonly string[]): string | undefined {
    const index = args.indexOf("--profile");
    if (index === -1) return undefined;
    const name = args[index + 1];
    return name === undefined || name.startsWith("-") ? undefined : name;
}

export function applyProfileFlag(
    args: readonly string[],
    env: NodeJS.ProcessEnv = process.env,
): readonly string[] {
    const index = args.indexOf("--profile");
    if (index === -1) return args;
    const name = args[index + 1];
    if (name === undefined || name.startsWith("-")) {
        throw new VeraProfileError("--profile needs a name, as in --profile dogfood");
    }
    env[VERA_PROFILE_ENV] = name;
    return [...args.slice(0, index), ...args.slice(index + 2)];
}

/**
 * `vera rescue` is `vera` under the fixed `rescue` profile: its own host,
 * socket, lockfile, sessions, and config, with credentials shared from the
 * machine tier. When the daily host is wedged, this reaches a working Vera
 * while that host stays where it is. Stop the wedged host with
 * `vera host stop --force`.
 * Consumed here for the same reason as `--profile`: every path lookup after
 * dispatch must see one profile.
 *
 * Runs after `applyProfileFlag`, so an explicit `--profile` has already been
 * consumed by the time this sees the arguments. Naming both is a contradiction
 * rather than a preference, so it is refused instead of silently resolved.
 */
export function isRescueInvocation(args: readonly string[]): boolean {
    const index = args.findIndex((arg) => arg !== "--yes" && arg !== "-y");
    return index !== -1 && args[index] === "rescue";
}

export function applyRescueCommand(
    args: readonly string[],
    env: NodeJS.ProcessEnv = process.env,
    profileFlagName?: string,
): readonly string[] {
    const index = args.findIndex((arg) => arg !== "--yes" && arg !== "-y");
    if (index === -1 || args[index] !== "rescue") return args;
    if (profileFlagName !== undefined) {
        throw new VeraProfileError(
            `vera rescue always runs under the rescue profile, so it cannot also take --profile ${profileFlagName}.\n`
                + `Use one or the other:\n`
                + `  vera rescue\n`
                + `  vera --profile ${profileFlagName}`,
        );
    }
    env[VERA_PROFILE_ENV] = "rescue";
    return [...args.slice(0, index), ...args.slice(index + 1)];
}

export async function runCliMain(
    args: readonly string[],
    dependencies: CliDependencies = {},
): Promise<number> {
    try {
        const requestedProfile = namedProfileFlag(args);
        const withoutProfileFlag = applyProfileFlag(args);
        const rescuing = isRescueInvocation(withoutProfileFlag);
        const remaining = applyRescueCommand(
            withoutProfileFlag,
            process.env,
            requestedProfile,
        );
        veraProfileName();
        if (rescuing) {
            const pinned = await (dependencies.runPinnedBuild
                ?? runPinnedBuild)(remaining, dependencies.stderr ?? stderr);
            if (pinned !== undefined) return pinned;
        }
        return await runCli(remaining, dependencies);
    } catch (error) {
        const output = dependencies.stderr ?? stderr;
        output.write(`${renderCliFailure(error)}\n`);
        return 1;
    }
}

/**
 * Runs the rescue under the last build whose host booted cleanly, when that
 * is not the build already running. A rescue that runs the same code as the
 * sick host cannot help when the host is sick because the code is broken.
 *
 * Returns undefined when there is no usable pinned build, which leaves rescue
 * running in place: a rescue that refuses to start would be worse than one
 * that runs possibly-broken code, since the broken case is the rarer one.
 */
async function runPinnedBuild(
    args: readonly string[],
    output: CliOutput,
): Promise<number | undefined> {
    const entrypoint = pinnedCliEntrypoint(fileURLToPath(import.meta.url));
    if (entrypoint === undefined) return undefined;
    output.write(`Starting rescue from the pinned build at ${entrypoint}.\n`);
    const child = spawn(process.execPath, [entrypoint, ...args], {
        stdio: "inherit",
        env: { ...process.env, [PINNED_BUILD_ENV]: "1" },
    });
    return await new Promise<number>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => {
            resolve(signal !== null ? 1 : code ?? 0);
        });
    });
}

export function renderCliFailure(error: unknown): string {
    if (error instanceof VeraProfileError) {
        return error.message;
    }
    if (error instanceof HostUnresponsiveError) {
        return `${error.message}\n`
            + "Run 'vera host stop --force' to kill it.\n"
            + "For a working Vera while it stays wedged, run 'vera rescue'.";
    }
    if (error instanceof HostProtocolMismatchError) {
        return `Vera host upgrade required: ${error.message}\n`
            + "Close the older Vera client and retry, or run 'vera host stop'.";
    }
    if (error instanceof HostBuildMismatchError) {
        return error.message;
    }
    if (error instanceof RetainedReleaseMissingError) {
        return error.message;
    }
    if (error instanceof VeraConfigError) {
        return `${error.message}\n`
            + `Fix or remove ${error.path} and run Vera again.`;
    }
    return `Vera failed: ${
        error instanceof Error ? error.message : String(error)
    }`;
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
    const host = await readPairedLiveHost();
    return host === undefined
        ? []
        : listAgentsThroughHost(host.socket_path);
}

async function abortLiveAgent(agentId: string): Promise<void> {
    const host = await readPairedLiveHost();
    if (host === undefined) {
        throw new Error("No live Vera host");
    }
    await abortAgentThroughHost(host.socket_path, agentId);
}

async function closeLiveAgent(agentId: string): Promise<CloseAgentResult> {
    const host = await readPairedLiveHost();
    if (host === undefined) {
        throw new Error("No live Vera host");
    }
    return closeAgentThroughHost(host.socket_path, agentId);
}

async function readPairedLiveHost(): Promise<HostLockRecord | undefined> {
    const host = await createHostLockfile().read();
    if (host === undefined) return undefined;
    assertMatchingHostBuild(host);
    return host;
}

function closeRejectionText(
    reason: "not_found" | "not_owned" | "failed",
): string {
    if (reason === "not_found") {
        return "no agent or session has that id. Run 'vera ls --all' to see them.";
    }
    if (reason === "not_owned") {
        return "that agent belongs to someone else.";
    }
    return "the host could not complete the close.";
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
    // Config and stored credentials are what verification builds its adapter
    // from, and the config is also where a declared provider's name lives, so
    // both paths read it before deciding the name is unknown.
    const config = loadOptionalVeraConfig() ?? startingVeraConfig();
    const declared = Object.keys(config.providers ?? {});
    if (
        !isVeraProviderId(parsed.provider)
        && !declared.includes(parsed.provider)
    ) {
        return {
            verdict: "unavailable",
            reason: `unknown provider "${parsed.provider}", expected one of `
                + [...shippedProviderIds(), ...declared].join(", "),
        };
    }
    if (options.verify !== true) {
        return admitToPool(parsed);
    }
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
        throw new Error(`Model "${ref}" is not on your shortlist`);
    }
    if (readUserPoolFile().models[id] === undefined) {
        throw new Error(`Model "${ref}" is not in your own shortlist file`);
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
    return `${ref} was not pinned (${outcome.verdict})${reason}\n`;
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

async function confirmBusyHostUpgrade(error?: Error): Promise<boolean> {
    if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try {
        const answer = await prompt.question(
            error instanceof HostUnresponsiveError
                ? `The resident Vera host (PID ${error.pid}) is not responding. Replace it? [y/N] `
                : "An older Vera host is busy. Restart it and disconnect attached clients? [y/N] ",
        );
        return answer.trim().toLowerCase() === "y"
            || answer.trim().toLowerCase() === "yes";
    } finally {
        prompt.close();
    }
}

function runHostSupervision(
    keyword: string | undefined,
    output: CliOutput,
    errorOutput: CliOutput,
    dependencies: CliDependencies,
): number {
    const action = keyword === undefined
        ? "on"
        : keyword === "off"
        ? "off"
        : "status";
    let report: SupervisionReport;
    try {
        report = (dependencies.superviseHost ?? ((requested) =>
            superviseHost(requested, {
                entrypoint: residentHostEntrypoint(),
            })))(action);
    } catch (error) {
        errorOutput.write(`${renderCliFailure(error)}\n`);
        return 1;
    }
    if (report.action === "on") {
        output.write(
            `${report.replaced ? "Replaced" : "Installed"} ${report.label}.`
                + " launchd starts the resident host at login and again"
                + " whenever it dies. Turn it off with"
                + " 'vera host supervise off'.\n",
        );
        return 0;
    }
    if (report.action === "off") {
        output.write(report.removed
            ? `Removed ${report.label}. Nothing restarts the resident host`
                + " now; the next 'vera' starts one.\n"
            : "Host supervision was not installed for this profile.\n");
        return 0;
    }
    if (!report.installed && !report.loaded) {
        output.write(
            "Host supervision is off for this profile."
                + " Turn it on with 'vera host supervise'.\n",
        );
        return 0;
    }
    output.write(
        `Host supervision is on for this profile (${report.label}).\n`
            + `  plist: ${report.plistPath}\n`
            + `  launchd: ${
                report.loaded
                    ? report.pid === undefined
                        ? "loaded, no host running right now"
                        : `running the host as PID ${report.pid}`
                    : "not loaded; run 'vera host supervise' to load it"
            }\n`,
    );
    return 0;
}

function runMigrateHomeCommand(
    flags: readonly string[],
    output: CliOutput,
    errorOutput: CliOutput,
    dependencies: CliDependencies,
): number {
    let rollback = false;
    for (const flag of flags) {
        if (flag === "--rollback") {
            rollback = true;
            continue;
        }
        if (flag.startsWith("-")) {
            errorOutput.write(`vera migrate-home: unknown flag: ${flag}\n`);
            return 1;
        }
        errorOutput.write("vera migrate-home: usage: vera migrate-home [--rollback]\n");
        return 1;
    }
    const home = veraHomeDirectory();
    try {
        const result = rollback
            ? (dependencies.rollbackHomeMigration ?? rollbackHomeMigration)(home)
            : (dependencies.migrateHome ?? migrateHome)(home);
        output.write(renderHomeMigration(result));
        return 0;
    } catch (error) {
        errorOutput.write(
            `vera migrate-home: ${error instanceof HomeMigrationError || error instanceof Error
                ? error.message
                : String(error)}\n`,
        );
        return 1;
    }
}

function renderHomeMigration(result: HomeMigrationResult): string {
    if (result.status === "already_flat") {
        return `${result.home} is already a single home.\n`;
    }
    if (result.status === "rolled_back") {
        return `Restored ${result.home} from the pre-migration backup.\n`;
    }
    const extra = result.otherProfiles.length === 0
        ? ""
        : ` Other profiles kept in backup: ${result.otherProfiles.join(", ")}.`;
    const unknown = result.unknownEntries.length === 0
        ? ""
        : ` Unknown files kept in backup: ${result.unknownEntries.join(", ")}.`;
    const backup = result.backup === undefined ? "" : ` Backup: ${result.backup}.`;
    const resumed = result.status === "resumed" ? " Resumed an interrupted migration." : "";
    return `Migrated ${result.home}.${backup}${extra}${unknown}${resumed}\n`;
}

function runRollbackCommand(
    flags: readonly string[],
    output: CliOutput,
    errorOutput: CliOutput,
    dependencies: CliDependencies,
): number {
    let prefix: string | undefined;
    for (let i = 0; i < flags.length; i++) {
        const flag = flags[i];
        if (flag === "--prefix") {
            prefix = flags[++i];
            if (prefix === undefined || prefix.length === 0) {
                errorOutput.write("vera rollback: missing --prefix path\n");
                return 1;
            }
            continue;
        }
        if (flag !== undefined && flag.startsWith("-")) {
            errorOutput.write(`vera rollback: unknown flag: ${flag}\n`);
            return 1;
        }
        errorOutput.write("vera rollback: usage: vera rollback [--prefix DIR]\n");
        return 1;
    }
    const target = prefix ?? defaultInstallPrefix();
    try {
        const result = (dependencies.rollbackInstall ?? rollbackLocalInstall)(target);
        if (result.fromBuildId === undefined) {
            output.write(`Activated ${result.toBuildId}\n`);
        } else {
            output.write(`Activated ${result.toBuildId} (was ${result.fromBuildId})\n`);
        }
        return 0;
    } catch (error) {
        errorOutput.write(
            `vera rollback: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        return 1;
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

async function confirmPruneProcess(
    candidate: LiveProcessRecord,
    currentHostPid?: number,
): Promise<boolean> {
    if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try {
        const current = candidate.pid === currentHostPid
            ? " (this shell's current host)"
            : "";
        const answer = await prompt.question(
            `Stop PID ${candidate.pid} ${candidate.kind} ${candidate.runtime_dir}${current}? [y/N] `,
        );
        return answer.trim().toLowerCase() === "y"
            || answer.trim().toLowerCase() === "yes";
    } finally {
        prompt.close();
    }
}

async function confirmStopStrayVeraProcesses(
    strays: readonly DiagnosedVeraProcess[],
    straySocketCount = 0,
): Promise<boolean> {
    if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try {
        const parts = [
            ...(strays.length > 0
                ? [`${strays.length} stray process${strays.length === 1 ? "" : "es"}`]
                : []),
            ...(straySocketCount > 0
                ? [`${straySocketCount} leftover tmux socket${straySocketCount === 1 ? "" : "s"}`]
                : []),
        ];
        const answer = await prompt.question(
            `Stop ${parts.join(" and ")}? [y/N] `,
        );
        return answer.trim().toLowerCase() === "y"
            || answer.trim().toLowerCase() === "yes";
    } finally {
        prompt.close();
    }
}

/**
 * Tests that inject a fake process doctor must not hit the real tmux
 * socket directory. The real CLI (no `doctor` override) diagnoses both.
 */
async function diagnoseDoctorTmuxSockets(
    dependencies: CliDependencies,
): Promise<TmuxSocketReport> {
    if (dependencies.tmuxSockets !== undefined) {
        return dependencies.tmuxSockets();
    }
    if (dependencies.doctor !== undefined) {
        return { healthy: true, directory: "", sockets: [] };
    }
    return diagnoseTmuxSockets();
}

function renderTmuxSocketSweep(result: TmuxSocketSweepResult): string {
    const parts = [
        ...(result.killedServers > 0
            ? [`stopped ${result.killedServers} leftover tmux server${result.killedServers === 1 ? "" : "s"}`]
            : []),
        ...(result.unlinkedFiles > 0
            ? [`removed ${result.unlinkedFiles} leftover tmux socket${result.unlinkedFiles === 1 ? "" : "s"}`]
            : []),
    ];
    if (parts.length === 0) return "No leftover tmux sockets to remove.\n";
    return `${parts.join("; ")}.\n`;
}

if (import.meta.main) {
    let layoutError: unknown;
    try {
        assertProfileLayout();
    } catch (error) {
        layoutError = error;
    }
    if (layoutError !== undefined) {
        stderr.write(`${renderCliFailure(layoutError)}\n`);
        process.exitCode = 1;
    } else {
        const strays = unrecognisedHomeEntries();
        if (strays.length > 0) {
            stderr.write(
                `${veraHomeDirectory()} holds entries no profile owns: ${strays.join(", ")}.\n`
                + "Whatever wrote them joined the home directly instead of a profile;"
                + " move them under a profile once it is fixed.\n",
            );
        }
        process.exitCode = await runCliMain(process.argv.slice(2));
    }
}
