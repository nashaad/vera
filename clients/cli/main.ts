#!/usr/bin/env bun

import { join } from "node:path";
import { stderr, stdout } from "node:process";
import { createInterface } from "node:readline/promises";

import {
    isVeraProviderId,
    loadOptionalVeraConfig,
    startingVeraConfig,
    VeraConfigError,
    type VeraConfig,
} from "../../src/config.ts";
import { shippedProviderIds } from "../../src/providers/definitions.ts";
import { resolveAgentIdentifier } from "./agent-id.ts";
import { abortAgentThroughHost, abortPoolAgentThroughHost } from "../../src/host/agent-abort-client.ts";
import {
    closeAgentThroughHost,
    type CloseAgentResult,
} from "../../src/host/agent-close-client.ts";
import {
    blockSessionThroughHost,
    unblockSessionThroughHost,
} from "../../src/host/session-block-client.ts";
import { readStoredSessionTree } from "../../src/host/session-block.ts";
import {
    runBlockCommand,
    runUnblockCommand,
    type SessionBlockCommandDependencies,
} from "./session-block-command.ts";
import type { RegisteredAgentSummary } from "../../src/host/agent-registry.ts";
import { listAgentPageThroughHost, listAgentsThroughHost, type ListedAgentsPage } from "../../src/host/agent-list-client.ts";
import {
    describeImportRejection,
    importSessionThroughHost,
    listImportableSessionsThroughHost,
} from "../../src/host/session-import-client.ts";
import type {
    ImportableSessionListing,
    SessionImportOutcome,
    SessionImportSucceeded,
} from "../../src/host/session-import-service.ts";
import {
    createHostLockfile,
    HostBuildMismatchError,
    HostLockUnreadableError,
    HostProtocolMismatchError,
    HostUnresponsiveError,
    assertMatchingHostBuild,
    type HostLockRecord,
} from "../../src/host/lockfile.ts";
import {
    forceStopResidentHost,
    gracefulStopResidentHost,
    stopResidentHostWhenIdle,
    unverifiedHostMessage,
    type ForceStopOutcome,
    type StopWhenIdleOutcome,
} from "../../src/host/force-stop.ts";
import type { StopWaitTarget } from "../../src/host/stop-when-idle.ts";
import { forceStopPool, ForcePoolStartupInProgressError } from "../../src/host/master/force-stop-pool.ts";
import { HostStartupInProgressError } from "../../src/host/startup-claim.ts";
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
import {
    rollbackLocalInstall,
    type FinishedInterruptedSwitch,
    type RolledBackRelease,
} from "../../src/release/rollback.ts";
import {
    HomeMigrationError,
    migrateHome,
    rollbackHomeMigration,
    type HomeMigrationResult,
} from "../../src/home-migration.ts";
import { thisProcessVersion } from "../../src/release/stamp.ts";
import {
    exportSession,
    type SessionExportFormat,
} from "../../src/session-export.ts";
import { inspectLatestModelRequest } from "../../src/model-request-inspector.ts";
import { workspaceKey } from "../../src/workspace-key.ts";
import {
    assertProfileLayout,
    veraBlockedDirectory,
    veraHomeDirectory,
    veraRuntimeDirectory,
    VeraProfileError,
} from "../../src/profile-paths.ts";
import { defaultSessionDirectory } from "../../src/store/session-store.ts";
import { relativeTime } from "../../src/relative-time.ts";import { supportedLevels } from "../../src/model/effort-ladder.ts";
import { isCuratedPoolEntry, providerOf } from "../../src/model/pool-file.ts";
import { loadPoolFile } from "../../src/model/pool-file-loader.ts";
import { readUserPoolFile, setPoolMembership } from "../../src/model/pool-file-store.ts";
import { resolveBoundModelRef, resolvePoolRef } from "../../src/model/pool-names.ts";
import {
    admitToPool,
    type PoolAdmissionOutcome,
    type PoolAdmissionStep,
} from "../../src/model/pool-admission.ts";
import { createConfiguredModelAdapter } from "../../src/providers/configured.ts";
import { createAuthStorage } from "../../src/providers/auth-storage.ts";
import { refreshWebDevArena } from "../../src/model/webdev-arena.ts";
import {
    refreshProviderCatalogs,
    type CatalogRefreshOutcome,
} from "../../src/host/runtime.ts";

interface PoolAddOptions {
    readonly verify?: boolean;
    readonly onStep?: (step: PoolAdmissionStep) => void;
}
import type { TuiStartOptions, TuiStartTarget } from "../tui/main.ts";
import { renderCliHelp, renderCliUsage, renderCommandHelp, renderHelpRedirect } from "./help.ts";
import { runRulesCli } from "./rules.ts";
import { runScheduleCli } from "./schedule.ts";
import type { ScheduleOperation } from "../../src/scheduler/types.ts";
import { runScheduleOperationThroughHost } from "../../src/host/schedule-client.ts";
import {
    isCatalogRefreshFallback,
    refreshCatalogsThroughHost,
} from "../../src/host/catalog-refresh-client.ts";
import type { StartupProfile } from "../../src/startup-profile.ts";
import { Vera } from "../../src/sdk/agent.ts";
import type { ModelReasoningEffort } from "../../src/model/types.ts";
import { openFileInEditor, veraConfigPath } from "../editor.ts";
import {
    diagnoseVeraProcesses,
    livePidFromHostLockFile,
    renderVeraDoctor,
    colorizeVeraDoctor,
    stopStrayVeraProcesses,
    type DiagnosedVeraProcess,
    type StrayStopReport,
    type VeraDoctorReport,
} from "../process-doctor.ts";
import {
    claimListedProcess,
    listLiveProcesses,
    renderVeraPrune,
    skippedProcessLine,
    stopListedLiveProcess,
    type ListedProcess,
    type ListedStopResult,
    type LiveProcessReads,
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
    setAnyExtensionEnabled,
    type ExtensionManagerOperations,
} from "../../src/extensions/manager.ts";
import {
    parseExtensionManagerCommand,
    renderExtensionInstallPreview,
    renderExtensionList,
    renderExtensionMutation,
} from "../../src/extensions/manager-command.ts";
const PROVIDER_CHECK_FLAG = "--check-providers";

async function defaultProviderDoctor(
    options: ProviderDoctorOptions,
): Promise<ProviderDoctorReport> {
    return diagnoseProviders(loadOptionalVeraConfig() ?? startingVeraConfig(), {
        ...options,
        authStorage: createAuthStorage(),
    });
}

async function refreshDiscoveredCatalogs(
    dependencies: Pick<
        CliDependencies,
        | "readLiveHost"
        | "refreshCatalogsThroughHost"
        | "refreshLocalCatalogs"
    > = {},
): Promise<readonly CatalogRefreshOutcome[]> {
    const host = await (dependencies.readLiveHost ?? readAnsweringHost)();
    if (host !== undefined) {
        try {
            return await (
                dependencies.refreshCatalogsThroughHost
                    ?? refreshCatalogsThroughHost
            )(host.socket_path);
        } catch (error) {
            if (!isCatalogRefreshFallback(error)) throw error;
        }
    }
    if (dependencies.refreshLocalCatalogs !== undefined) {
        return dependencies.refreshLocalCatalogs();
    }
    const config = loadOptionalVeraConfig() ?? startingVeraConfig();
    // A one-shot fallback has nothing waiting on it, so the score download is awaited too.
    const [outcomes] = await Promise.all([
        refreshProviderCatalogs(config, { authStorage: createAuthStorage() }),
        refreshWebDevArena({ maxAgeMs: 0 }),
    ]);
    return outcomes;
}

async function readAnsweringHost(): Promise<
    { readonly socket_path: string } | undefined
> {
    try {
        const host = await createHostLockfile().read();
        return host === undefined ? undefined : { socket_path: host.socket_path };
    } catch {
        return undefined;
    }
}

interface CliOutput {
    write(text: string): unknown;
    readonly columns?: number;
}

function cliStreamWantsColor(output: CliOutput): boolean {
    if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "") {
        return false;
    }
    return "isTTY" in output && (output as { isTTY?: boolean }).isTTY === true;
}

interface PrintOutcome {
    readonly agentId: string;
    readonly sessionPath: string;
    readonly text: string;
    readonly outcome: "completed" | "error" | "aborted";
    readonly error?: string;
    readonly notes: readonly string[];
}

type RollbackInstallResult =
    | Pick<RolledBackRelease, "kind" | "fromBuildId" | "toBuildId">
    | Pick<FinishedInterruptedSwitch, "kind" | "activeBuildId">;

export interface CliDependencies {
    readonly abortAgent?: (agentId: string) => Promise<void | "no_turn">;
    readonly sessionBlock?: Partial<SessionBlockCommandDependencies>;
    readonly closeAgent?: (agentId: string) => Promise<CloseAgentResult>;
    readonly listAgents?: () => Promise<readonly RegisteredAgentSummary[]>;
    readonly listAgentPage?: () => Promise<ListedAgentsPage>;
    readonly scheduleOperation?: (
        operation: ScheduleOperation,
    ) => Promise<Record<string, unknown>>;
    readonly exportSession?: (
        sessionPath: string,
        format: SessionExportFormat,
    ) => Promise<string>;
    readonly inspectModelRequest?: (sessionPath: string) => Promise<string>;
    readonly importSession?: (path: string) => Promise<SessionImportOutcome>;
    readonly listImportableSessions?: (
        workspace: string | undefined,
    ) => Promise<ImportableSessionListing | undefined>;
    readonly openConfigure?: () => Promise<void>;
    readonly stdout?: CliOutput;
    readonly stderr?: CliOutput;
    readonly superviseHost?: (
        action: "on" | "off" | "status",
    ) => SupervisionReport;
    readonly runStdio?: (target: StdioStartTarget) => Promise<void>;
    readonly runOnce?: (request: {
        readonly workspace: string;
        readonly prompt: string;
        readonly approvalMode?: string;
        readonly model?: string;
        readonly effort?: string;
        readonly startupProfile?: StartupProfile;
        readonly sessionPath?: string;
    }) => Promise<PrintOutcome>;
    readonly runTui?: (
        target: TuiStartTarget,
        options?: TuiStartOptions,
    ) => Promise<void>;
    readonly confirmHostStop?: (force: boolean) => boolean | Promise<boolean>;
    readonly stopHost?: (options: {
        readonly onWaiting: (waiting: readonly StopWaitTarget[]) => void;
        readonly force?: boolean;
    }) => Promise<StopWhenIdleOutcome | undefined>;
    readonly forceStopHost?: () => Promise<ForceStopOutcome | undefined>;
    readonly doctor?: () => Promise<VeraDoctorReport>;
    readonly prune?: () => Promise<readonly LiveProcessRecord[]>;
    readonly confirmPruneProcess?: (
        process: LiveProcessRecord,
        currentHostPid?: number,
    ) => boolean | Promise<boolean>;
    readonly stopPruneProcess?: (pid: number) => number | Promise<number>;
    // Reads and signals used by the default prune stop to confirm each process.
    readonly liveProcessReads?: LiveProcessReads;
    readonly tmuxSockets?: () => Promise<TmuxSocketReport>;
    readonly confirmStopStrayProcesses?: (
        strays: readonly DiagnosedVeraProcess[],
        straySocketCount?: number,
    ) => boolean | Promise<boolean>;
    readonly stopStrayProcesses?: (
        strays: readonly DiagnosedVeraProcess[],
        report: StrayStopReport,
    ) => number | Promise<number>;
    readonly sweepTmuxSockets?: (
        report: TmuxSocketReport,
    ) => TmuxSocketSweepResult | Promise<TmuxSocketSweepResult>;
    readonly providerDoctor?: (
        options: ProviderDoctorOptions,
    ) => Promise<ProviderDoctorReport>;
    readonly refreshCatalogs?: () => Promise<readonly CatalogRefreshOutcome[]>;
    readonly readLiveHost?: () => Promise<
        { readonly socket_path: string } | undefined
    >;
    readonly refreshCatalogsThroughHost?: (
        socketPath: string,
    ) => Promise<readonly CatalogRefreshOutcome[]>;
    readonly refreshLocalCatalogs?: () => Promise<readonly CatalogRefreshOutcome[]>;
    readonly listPool?: (workspace: string) => Promise<string>;
    readonly addPoolModel?: (
        workspace: string,
        ref: string,
        options: PoolAddOptions,
    ) => Promise<PoolAdmissionOutcome>;
    readonly removePoolModel?: (workspace: string, ref: string) => Promise<void>;
    readonly extensionManager?: Partial<ExtensionManagerOperations>;
    readonly version?: string;
    readonly dispatchToHostRelease?: (
        argv: readonly string[],
    ) => Promise<number | undefined>;
    readonly rollbackInstall?: (prefix: string) => Promise<RollbackInstallResult>;
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

    if (args.length === 1 && isHelpFlag(args[0])) {
        output.write(renderCliHelp(helpColumns(output)));
        return 0;
    }

    if (args[0] === "help") {
        output.write(renderHelpRedirect(args[1]));
        return 0;
    }

    if (args.length > 1 && args.slice(1).some(isHelpFlag)) {
        const commandHelp = renderCommandHelp(args[0]!, helpColumns(output));
        if (commandHelp !== undefined) {
            output.write(commandHelp);
            return 0;
        }
    }

    if (
        args.length === 1
        && (args[0] === "--version" || args[0] === "-v")
    ) {
        try {
            output.write(
                `${dependencies.version ?? thisProcessVersion()}\n`,
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

    if (args[0] === "-p") {
        const printRequest = parsePrintRequest(args);
        if (printRequest === undefined) {
            errorOutput.write(renderCliUsage());
            return 1;
        }
        const result = await (dependencies.runOnce ?? runHostlessPrint)({
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
                ?? setAnyExtensionEnabled,
            remove: dependencies.extensionManager?.remove ?? removeExtension,
        };
        try {
            if (command.operation === "list") {
                output.write(renderExtensionList(manager.list()));
                return 0;
            }
            if (command.operation === "install") {
                const result = manager.install(command.source, {
                    dryRun: command.dryRun,
                });
                output.write(renderExtensionInstallPreview(result.preview));
                if (!command.dryRun) {
                    output.write(
                        `Installed ${result.record?.id ?? result.preview.id}.\n`,
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
                );
                output.write(renderExtensionMutation(command.operation, record));
                output.write(
                    "Restart the resident host to apply host-side capabilities.\n",
                );
                return 0;
            }
            const record = manager.remove(command.id);
            output.write(renderExtensionMutation("remove", record));
            output.write(
                "Restart the resident host to apply host-side capabilities.\n",
            );
            return 0;
        } catch (error) {
            errorOutput.write(`Extension operation failed: ${renderCliFailure(error)}\n`);
            return 1;
        }
    }

    if (
        args[0] === "ls"
        && (args.length === 1 || (args.length === 2 && args[1] === "--all"))
    ) {
        const all = args.length === 2;
        const listing = dependencies.listAgentPage !== undefined
            ? await dependencies.listAgentPage()
            : dependencies.listAgents === undefined
                ? await listLiveAgentPage()
                : { agents: await dependencies.listAgents() };
        const agents = listing.agents;
        const here = workspaceKey(process.cwd());
        output.write(renderAgentList(
            all
                ? agents
                : agents.filter((agent) =>
                    workspaceKey(agent.workspace) === here
                ),
            { all },
        ));
        if ("unavailableWorkers" in listing && listing.unavailableWorkers !== undefined
            && listing.unavailableWorkers.length > 0) {
            output.write(`Unavailable session processes: ${listing.unavailableWorkers.join(", ")}.\n`);
        }
        return 0;
    }

    if (
        args[0] === "import"
        && (args.length === 1 || (args.length === 2 && args[1] === "--all"))
    ) {
        const all = args.length === 2;
        const listing = await (dependencies.listImportableSessions ?? listImportableSessionsFromCli)(
            all ? undefined : process.cwd(),
        );
        if (listing === undefined) {
            errorOutput.write("Could not list sessions. Check that the Vera host is running.\n");
            return 1;
        }
        output.write(renderImportableSessions(listing, { all }));
        return 0;
    }

    if (
        args.length === 2
        && args[0] === "import"
        && typeof args[1] === "string"
        && args[1].length > 0
    ) {
        const outcome = await (dependencies.importSession ?? importSessionFromCli)(
            args[1],
        );
        if (outcome.status === "rejected") {
            errorOutput.write(`${describeImportRejection(args[1], outcome.reason)}\n`);
            return 1;
        }
        output.write(renderImportOutcome(args[1], outcome));
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

    if (args[0] === "block" || args[0] === "unblock") {
        const deps = {
            ...sessionBlockDependencies(output, errorOutput),
            ...dependencies.sessionBlock,
        };
        return args[0] === "block"
            ? runBlockCommand(args, deps)
            : runUnblockCommand(args, deps);
    }

    if (
        args.length === 2
        && args[0] === "abort"
        && typeof args[1] === "string"
        && args[1].length > 0
    ) {
        const result = await (dependencies.abortAgent ?? abortLiveAgent)(args[1]);
        output.write(result === "no_turn"
            ? `No turn is running for ${args[1]}.\n`
            : `Abort requested for ${args[1]}.\n`);
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
        let currentHostPid: number | undefined;
        try {
            currentHostPid = await livePidFromHostLockFile(
                join(veraRuntimeDirectory(), "host.json"),
            );
        } catch (error) {
            // Without the host's PID, prune could offer the live host for stopping.
            if (!(error instanceof HostLockUnreadableError)) throw error;
            errorOutput.write(`${error.message}\n`);
            return 1;
        }
        output.write(renderVeraPrune(records, currentHostPid));
        if (records.length === 0) return 0;
        const confirm = dependencies.confirmPruneProcess;
        if (confirm === undefined && (!process.stdin.isTTY || !process.stdout.isTTY)) {
            errorOutput.write(
                "Prune needs a terminal to ask about each process.\n",
            );
            return 1;
        }
        // Claimed now, before any prompt, so a PID reused while the user
        // deliberates is caught by the check made just before each signal.
        const claims = records.map((record) =>
            claimListedProcess(record, dependencies.liveProcessReads)
        );
        let stopped = 0;
        for (const listed of claims) {
            const candidate = listed.record;
            const approved = await (confirm ?? confirmPruneProcess)(
                candidate,
                currentHostPid,
            );
            if (!approved) continue;
            if (dependencies.stopPruneProcess !== undefined) {
                stopped += await dependencies.stopPruneProcess(candidate.pid);
                continue;
            }
            const result = stopListedLiveProcess(
                listed,
                dependencies.liveProcessReads,
            );
            if (result === "stopped") {
                stopped += 1;
                continue;
            }
            output.write(skippedProcessLine(candidate.pid, result));
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
                    )(strays, { onSkipped: (line) => output.write(line) });
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

    if (args[0] === "rules") {
        return await runRulesCli(
            args.slice(1),
            process.cwd(),
            output,
            errorOutput,
        );
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
            dependencies.refreshCatalogs
                ?? (() => refreshDiscoveredCatalogs(dependencies))
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
        return outcomes.some((outcome) => outcome.failure === undefined)
            ? 0
            : 1;
    }

    if (args.length === 2 && (args[0] === "library" || args[0] === "shortlist") && args[1] === "list") {
        output.write(await (dependencies.listPool ?? listPool)(process.cwd()));
        return 0;
    }

    if (
        (args.length === 3 || (args.length === 4 && args[3] === "--verify"))
        && (args[0] === "library" || args[0] === "shortlist")
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
            `${ref} added to your library${verify ? " (verified)" : " (unverified)"}.\n`,
        );
        return 0;
    }

    if (
        args.length === 3
        && (args[0] === "library" || args[0] === "shortlist")
        && args[1] === "remove"
        && typeof args[2] === "string"
        && args[2].length > 0
    ) {
        const ref = args[2];
        await (dependencies.removePoolModel ?? removePoolRef)(
            process.cwd(),
            ref,
        );
        output.write(`${ref} removed from your library.\n`);
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
            )(force);
        if (!confirmed) {
            output.write("Resident Vera host was not stopped.\n");
            return 0;
        }
        try {
            let announced = false;
            const onWaiting = (waiting: readonly StopWaitTarget[]): void => {
                if (!announced) {
                    announced = true;
                    output.write(force
                        ? "Cutting running turns and queued prompts. New turns are refused until the host stops.\n"
                        : "Stopping after running turns end. New turns are refused until the host stops.\n");
                }
                for (const target of waiting) {
                    output.write(target.name === null
                        ? `Waiting on ${target.session_id} (${target.status})\n`
                        : `Waiting on ${target.name} (${target.session_id}, ${target.status})\n`);
                }
            };
            if (force) {
                if (dependencies.stopHost === undefined && dependencies.forceStopHost === undefined) {
                    const pool = await forceStopPool(veraHomeDirectory());
                    if (pool !== undefined) {
                        if (pool.masterPid !== undefined) {
                            output.write(`Stopped resident Vera host PID ${pool.masterPid}.\n`);
                        }
                        for (const pid of pool.workerPids) {
                            output.write(`Stopped session process PID ${pid}.\n`);
                        }
                        if (pool.masterPid === undefined && pool.workerPids.length === 0) {
                            output.write("No resident Vera host is recorded.\n");
                        }
                        return 0;
                    }
                }
                const cut = await (
                    dependencies.stopHost ?? stopResidentHostWhenIdle
                )({ onWaiting, force: true });
                if (cut !== undefined && !cutNeedsSignal(cut)) {
                    const rendered = cut.endedBy === "stopped"
                        ? {
                            text: `Stopped resident Vera host PID ${cut.pid} after cutting its running turns.\n`,
                            exitCode: 0,
                        }
                        : renderStopWhenIdleOutcome(cut);
                    output.write(rendered.text);
                    return rendered.exitCode;
                }
                if (cut === undefined) {
                    output.write("No resident Vera host is recorded.\n");
                    return 0;
                }
                output.write(cutFallbackNotice(cut));
                const outcome = await (
                    dependencies.forceStopHost ?? forceStopResidentHost
                )();
                if (outcome === undefined) {
                    output.write("No resident Vera host is recorded.\n");
                    return 0;
                }
                const rendered = renderForceStopOutcome(outcome);
                output.write(rendered.text);
                return rendered.exitCode;
            }
            const outcome = await (
                dependencies.stopHost ?? stopResidentHostWhenIdle
            )({ onWaiting });
            if (outcome === undefined) {
                output.write("No resident Vera host is running.\n");
                return 0;
            }
            const rendered = renderStopWhenIdleOutcome(outcome);
            output.write(rendered.text);
            return rendered.exitCode;
        } catch (error) {
            if (error instanceof ForcePoolStartupInProgressError) {
                if (error.stoppedMasterPid !== undefined) {
                    output.write(`Stopped resident Vera host PID ${error.stoppedMasterPid}.\n`);
                }
                for (const pid of error.stoppedWorkerPids) {
                    output.write(`Stopped session process PID ${pid}.\n`);
                }
            }
            if (error instanceof HostLockUnreadableError || error instanceof HostStartupInProgressError) {
                errorOutput.write(`${error.message}\n`);
                return 1;
            }
            throw error;
        }
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
        readonly sessionPath?: string;
    };
}

const PRINT_FLAGS: Readonly<Record<string, "approvalMode" | "model" | "effort" | "sessionPath">> = {
    "--permission-mode": "approvalMode",
    "--model": "model",
    "--effort": "effort",
    "--session": "sessionPath",
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

export async function runHostlessPrint(request: {
    readonly workspace: string;
    readonly prompt: string;
    readonly approvalMode?: string;
    readonly model?: string;
    readonly effort?: string;
    readonly startupProfile?: StartupProfile;
    readonly sessionPath?: string;
}): Promise<PrintOutcome> {
    let provider: string | undefined;
    let model: string | undefined;
    if (request.model !== undefined) {
        const pool = loadPoolFile({ projectRoot: request.workspace }).merged;
        const bound = resolveBoundModelRef(pool, request.model);
        if (bound === undefined) {
            return {
                agentId: "run",
                sessionPath: "",
                text: "",
                outcome: "error",
                error: `${request.model} is not in your model library`,
                notes: [],
            };
        }
        provider = bound.provider;
        model = bound.model;
    }
    const result = await Vera.run({
        prompt: request.prompt,
        workspace: request.workspace,
        ...(request.approvalMode === undefined
            ? {}
            : { posture: request.approvalMode }),
        ...(provider === undefined || model === undefined
            ? {}
            : { provider, model }),
        ...(request.effort === undefined
            ? {}
            : { effort: request.effort as ModelReasoningEffort }),
        ...(request.startupProfile === "prompt_only" ? { tools: [] } : {}),
        ...(request.sessionPath === undefined
            ? {}
            : { sessionPath: request.sessionPath }),
    });
    const outcome = result.outcome === "completed"
        ? "completed"
        : result.outcome === "aborted"
            ? "aborted"
            : "error";
    return {
        agentId: "run",
        sessionPath: "",
        text: result.transcript,
        outcome,
        ...(result.error === undefined ? {} : { error: result.error.message }),
        notes: result.substitutions.map((substitution) =>
            substitution.scope === "model"
                ? `model ${substitution.requested} -> ${substitution.using ?? substitution.model}`
                : `effort ${substitution.requested} -> ${substitution.using ?? "default"}`
        ),
    };
}

async function scheduleOperationOnResidentHost(
    operation: ScheduleOperation,
): Promise<Record<string, unknown>> {
    const { findOrStartResidentHost } = await import("../host/launch.ts");
    const host = await findOrStartResidentHost();
    return runScheduleOperationThroughHost(host.socket_path, operation);
}

async function importSessionFromCli(path: string): Promise<SessionImportOutcome> {
    const { findOrStartResidentHost } = await import("../host/launch.ts");
    const host = await findOrStartResidentHost();
    return importSessionThroughHost(host.socket_path, path);
}

async function listImportableSessionsFromCli(
    workspace: string | undefined,
): Promise<ImportableSessionListing | undefined> {
    const { findOrStartResidentHost } = await import("../host/launch.ts");
    const host = await findOrStartResidentHost();
    return listImportableSessionsThroughHost(host.socket_path, workspace);
}

export function renderImportableSessions(
    listing: ImportableSessionListing,
    options: { readonly all?: boolean; readonly now?: Date } = {},
): string {
    if (listing.sessions.length === 0) {
        return options.all === true
            ? "No Claude Code or Codex sessions found.\n"
            : "No Claude Code or Codex sessions in this folder. Use --all to see every one.\n";
    }
    const now = options.now ?? new Date();
    const headings = options.all === true
        ? ["TOOL", "CHANGED", "TITLE", "IMPORTED", "WORKSPACE", "PATH"]
        : ["TOOL", "CHANGED", "TITLE", "IMPORTED", "PATH"];
    const rows = listing.sessions.map((session) => {
        const title = (session.title ?? session.first_message ?? "").replaceAll(/\s+/g, " ").trim();
        const row = [
            session.tool === "claude-code" ? "Claude Code" : "Codex",
            relativeTime(session.updated_at, now, "-"),
            truncate(title, 48),
            session.imported_session_id === undefined ? "" : "yes",
        ];
        return options.all === true
            ? [...row, session.workspace, session.path]
            : [...row, session.path];
    });
    const widths = headings.map((heading, index) =>
        Math.max(heading.length, ...rows.map((row) => row[index]?.length ?? 0))
    );
    const table = [headings, ...rows]
        .map((row) => row
            .map((cell, index) => cell.padEnd(widths[index] ?? cell.length))
            .join("  ")
            .trimEnd())
        .join("\n");
    const more = listing.truncated
        ? `Showing the newest ${listing.sessions.length}.\n`
        : "";
    return `${table}\n${more}Import one with: vera import <path>\n`;
}

interface StopRendering {
    readonly text: string;
    readonly exitCode: number;
}

function clearedExitedHostLockfile(outcome: ForceStopOutcome): StopRendering {
    const lockfile = outcome.lockDamaged === true
        ? "damaged lockfile"
        : "lockfile";
    return {
        text: `Resident Vera host PID ${outcome.pid} had already exited;`
            + ` cleared its ${lockfile}.\n`,
        exitCode: 0,
    };
}

function clearedStaleLockfile(outcome: ForceStopOutcome): StopRendering {
    const lockfile = outcome.lockDamaged === true
        ? "damaged lockfile"
        : "stale lockfile";
    return {
        text: `PID ${outcome.pid} is no longer a Vera host; cleared its`
            + ` ${lockfile}.\n`,
        exitCode: 0,
    };
}

// No default arm: a new endedBy value must fail to compile here.
function renderForceStopOutcome(outcome: ForceStopOutcome): StopRendering {
    const stopped = (how: string): StopRendering => ({
        text: `Stopped resident Vera host PID ${outcome.pid} (${how}).\n`,
        exitCode: 0,
    });
    switch (outcome.endedBy) {
        case "sigterm":
            return stopped("SIGTERM");
        case "sigkill":
            return stopped("killed after it ignored SIGTERM");
        case "already_dead":
            return clearedExitedHostLockfile(outcome);
        case "not_ours":
            return clearedStaleLockfile(outcome);
        case "survived":
            return {
                text: `Resident Vera host PID ${outcome.pid} is still running`
                    + " after SIGKILL, which means it is stuck in the kernel."
                    + " Its lockfile was left in place. Wait for the operation"
                    + " it is blocked on, or reboot.\n",
                exitCode: 1,
            };
        case "unverified":
            return {
                text: `${unverifiedHostMessage(outcome)}\n`,
                exitCode: 1,
            };
    }
}

// Only an answer the host did not give falls back to a signal. A refusal is reported and never signalled.
function cutNeedsSignal(outcome: StopWhenIdleOutcome): boolean {
    return outcome.endedBy === "no_answer"
        || outcome.endedBy === "unsupported"
        || outcome.endedBy === "timed_out";
}

function cutFallbackNotice(outcome: StopWhenIdleOutcome): string {
    const pid = outcome.pid === undefined ? "" : ` PID ${outcome.pid}`;
    switch (outcome.endedBy) {
        case "unsupported":
            return `Resident Vera host${pid} is a build that cannot cut its turns. Sending it the stop signal.\n`;
        case "timed_out":
            return `Resident Vera host${pid} did not stop within 10 seconds. Sending it the stop signal.\n`;
        default:
            return `Resident Vera host${pid} did not answer the cut request. Sending it the stop signal.\n`;
    }
}

function renderStopWhenIdleOutcome(outcome: StopWhenIdleOutcome): StopRendering {
    switch (outcome.endedBy) {
        case "stopped":
            return {
                text: `Stopped resident Vera host PID ${outcome.pid} after its running turns ended.\n`,
                exitCode: 0,
            };
        case "still_running":
            return {
                text: `Resident Vera host PID ${outcome.pid} accepted the stop but is still running.`
                    + " Run 'vera host stop --force' to stop it now.\n",
                exitCode: 1,
            };
        case "no_answer":
            return {
                text: `Resident Vera host PID ${outcome.pid} did not answer the stop request, so it was left running.`
                    + " Run 'vera host stop --force' to stop it now and cut its running turns.\n",
                exitCode: 1,
            };
        case "unsupported":
            return {
                text: `Resident Vera host PID ${outcome.pid} is a build that cannot wait for turns, so it was left running.`
                    + " Run 'vera host stop --force' to stop it now and cut its running turns.\n",
                exitCode: 1,
            };
        case "timed_out":
            return {
                text: `Resident Vera host PID ${outcome.pid} did not stop after its turns were cut, so it was left running.\n`,
                exitCode: 1,
            };
        case "accepted":
            return {
                text: `Resident Vera host PID ${outcome.pid} will stop once its running turns end.\n`,
                exitCode: 0,
            };
        case "abandoned":
            return {
                text: `${outcome.message ?? "The stop was abandoned."}\n`,
                exitCode: 1,
            };
        case "refused":
            return {
                text: outcome.message !== undefined
                    ? `${outcome.message}\n`
                    : outcome.refusal === "identity_mismatch"
                        ? `Resident Vera host PID ${outcome.pid} refused the stop because it is not the host its lockfile records. Left it running.\n`
                        : `Resident Vera host PID ${outcome.pid} is not accepting stop requests yet. Left it running; try again.\n`,
                exitCode: 1,
            };
        case "sigterm":
        case "sigkill":
        case "already_dead":
        case "survived":
        case "not_ours":
        case "unverified":
            return renderGracefulStopOutcome(outcome);
    }
}

function renderGracefulStopOutcome(outcome: ForceStopOutcome): StopRendering {
    switch (outcome.endedBy) {
        case "sigterm":
        case "sigkill":
            return {
                text: `Stopped resident Vera host PID ${outcome.pid}.\n`,
                exitCode: 0,
            };
        case "already_dead":
            return clearedExitedHostLockfile(outcome);
        case "not_ours":
            return clearedStaleLockfile(outcome);
        case "survived":
            return {
                text: `Resident Vera host PID ${outcome.pid} is still running. `
                    + "Run 'vera host stop --force' to kill it.\n",
                exitCode: 1,
            };
        case "unverified":
            return {
                text: `${unverifiedHostMessage(outcome)}\n`,
                exitCode: 1,
            };
    }
}

export function renderImportOutcome(
    path: string,
    outcome: SessionImportSucceeded,
): string {
    const lead = outcome.existing
        ? `${path} was already imported as ${outcome.sessionId}.`
        : `Imported ${path} as ${outcome.sessionId}.`;
    return `${lead}\nResume it with: vera resume ${outcome.sessionId}\n`;
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
    if (error instanceof VeraProfileError) {
        return error.message;
    }
    if (error instanceof HostUnresponsiveError) {
        return `${error.message}\n`
            + "Run 'vera host stop --force' to kill it.";
    }
    if (error instanceof HostProtocolMismatchError) {
        return `Vera host upgrade required: ${error.message}\n`
            + "Close the older Vera client and retry, or run 'vera host stop'.";
    }
    if (error instanceof HostBuildMismatchError) {
        return error.message;
    }
    if (error instanceof HostLockUnreadableError) {
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
    const headings = options.all === true
        ? ["KIND", "STATUS", "AGENT", "TITLE", "ACTIVE", "WORKSPACE"]
        : ["KIND", "STATUS", "AGENT", "TITLE", "ACTIVE"];
    const rows = agents.map((agent) => {
        const row = [
            agent.kind,
            agent.status === "idle" && !agent.live ? "stopped" : agent.status,
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

function truncate(value: string, limit: number): string {
    return value.length <= limit ? value : `${value.slice(0, limit - 1)}\u2026`;
}

function sessionBlockDependencies(
    output: { write(text: string): unknown },
    errorOutput: { write(text: string): unknown },
): SessionBlockCommandDependencies {
    const sessionDirectory = defaultSessionDirectory();
    return {
        listLive: listLiveAgents,
        readStored: () => readStoredSessionTree(sessionDirectory),
        sessionDirectory,
        blockedDirectory: veraBlockedDirectory(),
        hostSocketPath: async () => (await readPairedLiveHost())?.socket_path,
        blockThroughHost: (socketPath, request) => blockSessionThroughHost(socketPath, request),
        unblockThroughHost: (socketPath, request) => unblockSessionThroughHost(socketPath, request),
        hasTerminal: process.stdin.isTTY === true && process.stdout.isTTY === true,
        confirm: confirmSessionBlock,
        output,
        errorOutput,
    };
}

async function confirmSessionBlock(question: string): Promise<boolean> {
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try {
        const answer = (await prompt.question(question)).trim().toLowerCase();
        return answer === "y" || answer === "yes";
    } finally {
        prompt.close();
    }
}

async function listLiveAgents(): Promise<readonly RegisteredAgentSummary[]> {
    const host = await readPairedLiveHost();
    return host === undefined
        ? []
        : listAgentsThroughHost(host.socket_path);
}

async function listLiveAgentPage(): Promise<ListedAgentsPage> {
    const host = await readPairedLiveHost();
    return host === undefined ? { agents: [] } : await listAgentPageThroughHost(host.socket_path);
}

async function abortLiveAgent(agentId: string): Promise<void | "no_turn"> {
    const host = await readPairedLiveHost();
    if (host === undefined) {
        throw new Error("No live Vera host");
    }
    if (host.worker_count !== undefined) return await abortPoolAgentThroughHost(host.socket_path, agentId);
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
    reason: Extract<CloseAgentResult, { status: "rejected" }>["reason"],
): string {
    if (reason === "not_found") {
        return "no agent or session has that id. Run 'vera ls --all' to see them.";
    }
    if (reason === "not_owned") {
        return "that agent belongs to someone else.";
    }
    if (reason === "busy") {
        return "it is being moved to the trash.";
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
        throw new Error(`Model "${ref}" is not in your library`);
    }
    if (readUserPoolFile().models[id] === undefined) {
        throw new Error(`Model "${ref}" is not in your own library file`);
    }
    setPoolMembership([id], false);
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

function runLogin(output: CliOutput): number {
    output.write(
        "Vera accounts are not available yet.\n"
        + "To connect a model provider, open Vera, press Ctrl+P and choose Configure providers.\n",
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
            : "Host supervision was not installed for this home.\n");
        return 0;
    }
    if (!report.installed && !report.loaded) {
        output.write(
            "Host supervision is off for this home."
                + " Turn it on with 'vera host supervise'.\n",
        );
        return 0;
    }
    output.write(
        `Host supervision is on for this home (${report.label}).\n`
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

async function runRollbackCommand(
    flags: readonly string[],
    output: CliOutput,
    errorOutput: CliOutput,
    dependencies: CliDependencies,
): Promise<number> {
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
        const result = await (dependencies.rollbackInstall ?? rollbackLocalInstall)(target);
        if (result.kind === "finished_interrupted") {
            // The pin may already point back at the release this switch left, so
            // the advice stays conditional on the active release.
            output.write(
                result.activeBuildId === undefined
                    ? "Finished an interrupted install or rollback.\n"
                    : "Finished an interrupted install or rollback;"
                        + ` ${result.activeBuildId} is active. If that is not the`
                        + " release you want, run 'vera rollback'.\n",
            );
        } else if (result.fromBuildId === undefined) {
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

async function confirmResidentHostStop(force: boolean): Promise<boolean> {
    if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    const question = force
        ? "Stop the resident Vera host now, cut its running turns and disconnect attached clients? [y/N] "
        : "Stop the resident Vera host after its running turns end? New turns are refused until it stops. [y/N] ";
    try {
        const answer = await prompt.question(question);
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

/** Tests that inject a fake process doctor must not hit the real tmux socket directory. */
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

// Piped help, and test writers without a width, wrap at 80.
function helpColumns(output: CliOutput): number {
    return output.columns !== undefined && output.columns > 0 ? output.columns : 80;
}

function isHelpFlag(arg: string | undefined): boolean {
    return arg === "--help" || arg === "-h";
}

export function cliRequiresMigratedHome(args: readonly string[]): boolean {
    if (args.length === 1 && isHelpFlag(args[0])) return false;
    if (args.slice(1).some(isHelpFlag) && renderCommandHelp(args[0]!) !== undefined) return false;
    const first = args[0] === "--yes" || args[0] === "-y" ? args[1] : args[0];
    return first !== "migrate-home"
        && first !== "help"
        && first !== "--version"
        && first !== "-v";
}

if (import.meta.main) {
    const args = process.argv.slice(2);
    let layoutError: unknown;
    if (cliRequiresMigratedHome(args)) {
        try {
            assertProfileLayout();
        } catch (error) {
            layoutError = error;
        }
    }
    if (layoutError !== undefined) {
        stderr.write(`${renderCliFailure(layoutError)}\n`);
        process.exitCode = 1;
    } else {
        process.exitCode = await runCliMain(args);
    }
}
