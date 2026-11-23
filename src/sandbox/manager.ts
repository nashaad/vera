import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
    SandboxManager as Srt,
    type SandboxRuntimeConfig,
} from "@anthropic-ai/sandbox-runtime";
import { getDefaultWritePaths } from "@anthropic-ai/sandbox-runtime";
import {
    DANGEROUS_FILES,
    getDangerousDirectories,
} from "@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-utils.js";
import type { SandboxConfig } from "../config/sandbox.ts";
import type { PermissionRule } from "../engine/permissions.ts";
import {
    linkedWorktreeSharedDirectory,
    otherCheckoutRoots,
} from "../engine/workspace-scope.ts";
import type { HostLog } from "../host/host-log.ts";
import type { SandboxInspection } from "../sdk/sandbox.ts";
import { sandboxSessionSuffix } from "./attribution.ts";
import { mergeSandboxEnvironment } from "./env.ts";
import { compileSandboxPolicy, type SandboxPolicy } from "./policy.ts";
import {
    scanNestedProtectedPaths,
    type ProtectedScanResult,
} from "./protected-scan.ts";
import {
    RECOVERY_DELAY_MS,
    RECOVERY_TIMEOUT_MS,
    denialFromLogEvent,
    logWindows,
    readMacOSLog,
    violationKey,
    type SandboxLogReader,
} from "./recovery.ts";
import { ensureOwnerOnlyDirectory, sandboxTmpDir } from "./tmpdir.ts";
import type {
    CommandSandbox,
    SandboxCommandRequest,
    SandboxPreparedCommand,
    SandboxPreparation,
    SandboxSettledCommand,
    SandboxInspector,
    SandboxUnwrappedCommand,
    SandboxViolation,
} from "./types.ts";
import { NO_SANDBOX_PREPARATION } from "./types.ts";
import { classifyViolation, formatViolationBlock } from "./violations.ts";

const SRT_VERSION = "0.0.83";
const DNS_MACH_SERVICES = [
    "com.apple.SystemConfiguration.configd",
    "com.apple.dnssd.service",
    "com.apple.mDNSResponder",
];
// A denial taken from the macOS log can arrive after the child exits. Wait
// until the store has been quiet for two ticks, and no longer than this: a
// command that simply failed pays the quiet ticks, not the ceiling.
const EXIT_GRACE_TICKS = 5;
const EXIT_GRACE_QUIET_TICKS = 2;
const EXIT_GRACE_MS = 20;
// How long a disposal lets srt's `log stream` child take the SIGTERM srt
// sends before it is killed outright.
const MONITOR_EXIT_ATTEMPTS = 10;
const MONITOR_EXIT_MS = 20;
const MAX_COMMAND_ID = 100;
const MONITOR_READY_TIMEOUT_MS = 2000;
const MONITOR_POLL_MS = 20;
// Recent commands, so a recovered denial can name the command that caused it.
const MAX_REMEMBERED_COMMANDS = 500;
// Recent logged lines, so recovery never repeats a live entry.
const MAX_REMEMBERED_LINES = 1000;

export interface SandboxManagerOptions {
    /** What `~` in a rule expands to; the account's home by default. */
    readonly home?: string;
    readonly config: () => SandboxConfig;
    readonly permissionRules: () => readonly PermissionRule[];
    readonly log: HostLog;
    /** Overrides srt's own dependency check; a host that pre-checked uses this. */
    readonly readDependencies?: () => SandboxAvailability;
    /** Shortens the macOS monitor handshake; tests set it. */
    readonly monitorTimeoutMs?: number;
    /** Overrides the macOS log query; tests pass a fake. */
    readonly readLogEvents?: SandboxLogReader;
    /** How long a recovery query may take; a few seconds by default. */
    readonly recoveryTimeoutMs?: number;
    /** How long after a turn ends recovery starts; tests shorten it. */
    readonly recoveryDelayMs?: number;
    /** The platform whose policy to compile; tests set it to reach Linux paths. */
    readonly platform?: NodeJS.Platform;
    /** Overrides the Linux protected-path scan; tests pass a fake. */
    readonly scanProtected?: (roots: readonly string[]) => ProtectedScanResult;
    /** Overrides srt's per-command cleanup; tests pass a counter. */
    readonly cleanupAfterCommand?: () => void;
    /** The clock recovery windows are measured with; tests advance a fake. */
    readonly now?: () => number;
}

export interface SandboxAvailability {
    readonly ok: boolean;
    readonly reason?: string;
    readonly errors: readonly string[];
    readonly warnings: readonly string[];
}

type Availability = SandboxAvailability;

/**
 * One srt runtime per process. Each command is wrapped with the policy
 * compiled for it, so two sessions never share one.
 */
export class SandboxManager implements CommandSandbox, SandboxInspector {
    private state: "idle" | "starting" | "ready" | "unavailable" = "idle";
    private reason: string | undefined;
    private failure: Availability | undefined;
    private starting: Promise<void> | undefined;
    private readonly warned = new Set<string>();
    private readonly results = new WeakMap<
        SandboxPreparedCommand,
        SandboxSettledCommand
    >();
    private lastPolicyKey: string | undefined;
    private currentPolicy: SandboxPolicy | undefined;
    private disposed = false;
    private readonly platform: NodeJS.Platform;
    private sessionSuffix: string | undefined;
    // Spans of commands wrapped since the last query: their start times, then
    // the finished pairs waiting for the next turn to query them.
    private readonly spanStarts = new Map<SandboxPreparedCommand, number>();
    private pendingSpans: { start: number; end: number }[] = [];
    // srt's per-command cleanup runs once for a wrap, however often a caller
    // reports the end.
    private readonly released = new WeakSet<SandboxPreparedCommand>();
    private recoveryRunning = false;
    private recoveryPending = false;
    private recoveryWarned = false;
    private recoveryTask: Promise<void> | undefined;
    private recoveryTimer: ReturnType<typeof setTimeout> | undefined;
    private recoveryWaitTimer: ReturnType<typeof setTimeout> | undefined;
    private recoveryWaitResolve: (() => void) | undefined;
    // When the next pass may query; a turn ending during a running pass moves
    // it forward so that turn's windows get the same margin.
    private recoveryNotBefore = 0;
    private recoveryResolve: (() => void) | undefined;
    private recoveryAbort: AbortController | undefined;
    private readonly commandIdentities = new Map<
        string,
        { readonly sessionId: string; readonly toolCallId: string }
    >();
    private readonly loggedLines = new Map<string, true>();
    private readonly now: () => number;

    constructor(private readonly options: SandboxManagerOptions) {
        this.platform = options.platform ?? process.platform;
        this.now = options.now ?? Date.now;
    }

    async prepare(
        request: SandboxCommandRequest,
    ): Promise<SandboxPreparation> {
        const config = this.options.config();
        if (!config.enabled) return NO_SANDBOX_PREPARATION;
        const commandId = commandIdFor(request);
        if (request.approvalMode === "full_access") {
            this.notePolicy(request.workspace, request.scratchDir, config, []);
            return {
                unwrapped: {
                    sessionId: request.sessionId,
                    toolCallId: request.toolCallId,
                    commandId,
                    reason: "full_access",
                },
            };
        }
        const scan = this.scanForProtected(request.workspace);
        if (!scan.ok) {
            this.log({
                type: "sandbox_scan_failed",
                level: "error",
                platform: this.platform,
                workspace: request.workspace,
                reason: scan.reason,
            });
            return {
                refusal: `Sandbox could not scan this workspace for protected paths: ${scan.reason}.`,
            };
        }
        this.notePolicy(request.workspace, request.scratchDir, config, scan.paths);
        if (!await this.ensureStarted(config)) {
            return this.unavailablePreparation(request, commandId);
        }
        const policy = this.policyFor(
            request.workspace,
            request.scratchDir,
            config,
            scan.paths,
        );
        try {
            const wrapped = await Srt.wrapWithSandboxArgv(
                request.command,
                "bash",
                perCommandConfig(policy) as Partial<SandboxRuntimeConfig>,
                undefined,
                request.cwd,
                { commandId, commandText: request.command },
            );
            const tmpDir = sandboxTmpDir(wrapped.argv);
            if (tmpDir !== undefined) {
                const failure = ensureOwnerOnlyDirectory(tmpDir);
                if (failure !== undefined) {
                    this.goUnavailable({
                        ok: false,
                        reason: `the sandbox temp folder is unusable: ${failure}`,
                        errors: [failure],
                        warnings: [],
                    });
                    try {
                        await Srt.reset();
                    } catch {
                        // The folder, not the runtime, is the failure to report.
                    }
                    return this.unavailablePreparation(request, commandId);
                }
            }
            const suffix = sandboxSessionSuffix(wrapped.argv);
            if (suffix !== undefined && this.sessionSuffix === undefined) {
                this.sessionSuffix = suffix;
            }
            const prepared: SandboxPreparedCommand = {
                argv: wrapped.argv,
                // macOS and Linux answer with this process's environment,
                // so only what srt added or changed may join the caller's
                // env: a skill script's env is an allowlist, and turning
                // the sandbox on must not widen it.
                env: mergeSandboxEnvironment(request.env, wrapped.env),
                commandId,
                sessionId: request.sessionId,
                toolCallId: request.toolCallId,
                command: request.command,
                violationsBefore: this.violationTotal(),
            };
            // Recovery only ever asks about time a command was running, so
            // the monitor probe's own denial is outside every window.
            if (this.platform === "darwin") {
                this.spanStarts.set(prepared, this.now());
            }
            this.rememberCommand(commandId, request.sessionId, request.toolCallId);
            return { prepared };
        } catch (error) {
            const message = messageOf(error);
            this.logCommand({
                sessionId: request.sessionId,
                toolCallId: request.toolCallId,
                commandId,
                wrapped: false,
                wrapError: message,
            });
            return {
                refusal: `Sandbox could not wrap this command: ${message}.`,
            };
        }
    }

    private unavailablePreparation(
        request: SandboxCommandRequest,
        commandId: string,
    ): SandboxPreparation {
        const notice = this.unavailableNotice(request.sessionId);
        return {
            ...(notice === undefined ? {} : { notice }),
            unwrapped: {
                sessionId: request.sessionId,
                toolCallId: request.toolCallId,
                commandId,
                reason: "unavailable",
            },
        };
    }

    async settle(
        prepared: SandboxPreparedCommand,
        exitCode: number | null,
    ): Promise<SandboxSettledCommand> {
        const settled = this.results.get(prepared);
        if (settled !== undefined) return settled;
        let violations = this.readViolations(prepared.commandId);
        // The log monitor files its line a tick after the child exits, even
        // when the command exits zero, so give it that tick before deciding.
        if (violations.length === 0 && exitCode !== null) {
            await new Promise((resolve) => setTimeout(resolve, 0));
            violations = this.readViolations(prepared.commandId);
        }
        // macOS reads denials from `log stream`, which is a separate process
        // and lags the exit. Linux's monitor reports at the syscall from
        // inside the sandbox, so its line is there by the time the child is.
        if (
            violations.length === 0
            && exitCode !== null
            && this.platform !== "linux"
            && (exitCode !== 0
                || this.violationTotal() > prepared.violationsBefore)
        ) {
            let previous = this.violationTotal();
            let quiet = 0;
            for (let tick = 0; tick < EXIT_GRACE_TICKS; tick++) {
                await new Promise((resolve) => setTimeout(resolve, EXIT_GRACE_MS));
                violations = this.readViolations(prepared.commandId);
                if (violations.length > 0) break;
                const total = this.violationTotal();
                if (total === previous) {
                    quiet += 1;
                    if (quiet >= EXIT_GRACE_QUIET_TICKS) break;
                } else {
                    quiet = 0;
                    previous = total;
                }
            }
        }
        return this.finish(prepared, violations, exitCode);
    }

    settleSync(prepared: SandboxPreparedCommand): SandboxSettledCommand {
        const settled = this.results.get(prepared);
        if (settled !== undefined) return settled;
        return this.finish(prepared, this.readViolations(prepared.commandId), null);
    }

    finishUnwrapped(
        unwrapped: SandboxUnwrappedCommand,
        exitCode: number | null,
    ): void {
        this.logCommand({
            sessionId: unwrapped.sessionId,
            toolCallId: unwrapped.toolCallId,
            commandId: unwrapped.commandId,
            wrapped: false,
            reason: unwrapped.reason,
            ...(exitCode === null ? {} : { exitCode }),
        });
    }

    release(prepared: SandboxPreparedCommand): void {
        this.results.delete(prepared);
    }

    /**
     * The command's child has exited, or the wrap will never be spawned. srt
     * must clean up after each wrap on Linux: an absent deny path is mounted
     * over a placeholder it creates on the host, and the placeholder outlives
     * the command otherwise.
     */
    commandEnded(prepared: SandboxPreparedCommand): void {
        this.closeSpan(prepared);
        if (this.released.has(prepared)) return;
        this.released.add(prepared);
        try {
            if (this.options.cleanupAfterCommand !== undefined) {
                this.options.cleanupAfterCommand();
            } else {
                Srt.cleanupAfterCommand();
            }
        } catch {
            // srt's cleanup is best effort; a failure must not fail the
            // command that already ran.
        }
    }

    private closeSpan(prepared: SandboxPreparedCommand): void {
        const start = this.spanStarts.get(prepared);
        if (start === undefined) return;
        this.spanStarts.delete(prepared);
        this.pendingSpans.push({ start, end: this.now() });
    }

    /**
     * A turn ended. The query runs in the background: it may take a second,
     * and nothing waiting on the turn may be made to wait for it.
     */
    turnEnded(): void {
        if (
            this.platform !== "darwin"
            || this.sessionSuffix === undefined
            || this.disposed
        ) {
            return;
        }
        const now = this.now();
        for (const [prepared, start] of this.spanStarts) {
            this.pendingSpans.push({ start, end: now });
            // A command still running is queried again from this point by the
            // next turn; its earlier time is in this window already.
            this.spanStarts.set(prepared, now);
        }
        if (this.pendingSpans.length === 0) return;
        this.recoveryWarned = false;
        this.recoveryPending = true;
        this.recoveryNotBefore = this.now() + (
            this.options.recoveryDelayMs ?? RECOVERY_DELAY_MS
        );
        if (this.recoveryRunning) return;
        if (this.recoveryTask === undefined) {
            this.recoveryTask = new Promise<void>((resolve) => {
                this.recoveryResolve = resolve;
            });
        }
        this.scheduleRecovery();
    }

    /**
     * Re-arms the one delayed pass. A turn that ends while the timer waits
     * joins that pass: its spans are already queued and the timer moves to
     * give its windows the same margin.
     */
    private scheduleRecovery(): void {
        if (this.disposed) return;
        if (this.recoveryTimer !== undefined) clearTimeout(this.recoveryTimer);
        const timer = setTimeout(() => {
            this.recoveryTimer = undefined;
            void this.pumpRecovery().finally(() => {
                const resolve = this.recoveryResolve;
                this.recoveryResolve = undefined;
                this.recoveryTask = undefined;
                resolve?.();
            });
        }, this.options.recoveryDelayMs ?? RECOVERY_DELAY_MS);
        this.recoveryTimer = timer;
        timer.unref?.();
    }

    /** Resolves when no recovery query is queued or running; tests await it. */
    async whenRecoveryIdle(): Promise<void> {
        await this.recoveryTask;
    }

    private async pumpRecovery(): Promise<void> {
        if (this.recoveryRunning) return;
        this.recoveryRunning = true;
        try {
            while (this.recoveryPending && !this.disposed) {
                // A turn that ended while the previous query ran moved this
                // forward, so its windows are wholly in the past too.
                const wait = this.recoveryNotBefore - this.now();
                if (wait > 0) await this.waitForRecovery(wait);
                if (this.disposed) return;
                this.recoveryPending = false;
                await this.recoverOnce();
            }
        } finally {
            this.recoveryRunning = false;
        }
    }

    private async waitForRecovery(ms: number): Promise<void> {
        await new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
                this.recoveryWaitTimer = undefined;
                this.recoveryWaitResolve = undefined;
                resolve();
            }, ms);
            this.recoveryWaitTimer = timer;
            this.recoveryWaitResolve = resolve;
            timer.unref?.();
        });
    }

    private async recoverOnce(): Promise<void> {
        if (!this.ready || this.sessionSuffix === undefined) return;
        const spans = this.pendingSpans;
        this.pendingSpans = [];
        if (spans.length === 0) return;
        const windows = logWindows(spans);
        const timeout = this.options.recoveryTimeoutMs ?? RECOVERY_TIMEOUT_MS;
        let failedSpan: number | undefined;
        for (const window of windows) {
            if (window.span === failedSpan) continue;
            if (this.disposed) return;
            const controller = new AbortController();
            this.recoveryAbort = controller;
            let messages: readonly string[];
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
                const read = this.options.readLogEvents ?? readMacOSLog;
                const query = read(
                    {
                        start: window.start,
                        end: window.end,
                        suffix: this.sessionSuffix,
                    },
                    controller.signal,
                );
                // The race may settle by timeout; the query's own rejection is
                // then nobody's, and must not surface as unhandled.
                query.catch(() => undefined);
                messages = await Promise.race([
                    query,
                    new Promise<never>((_, reject) => {
                        timer = setTimeout(() => {
                            controller.abort();
                            reject(new Error(`the log query exceeded ${timeout} ms`));
                        }, timeout);
                    }),
                ]);
            } catch (error) {
                // The span is dropped, so a failed query never widens the
                // next one. One warn per turn names the time that was lost.
                failedSpan = window.span;
                if (!this.recoveryWarned) {
                    this.recoveryWarned = true;
                    this.log({
                        type: "sandbox_recovery_failed",
                        level: "warn",
                        platform: this.platform,
                        reason: messageOf(error),
                        skipped: `${new Date(window.start).toISOString()} to ${new Date(window.end).toISOString()}`,
                    });
                }
                continue;
            } finally {
                if (timer !== undefined) clearTimeout(timer);
                this.recoveryAbort = undefined;
            }
            for (const message of messages) {
                const denial = denialFromLogEvent(message);
                if (denial === undefined) continue;
                // The suffix is shared by every command this process runs.
                // Only a command this manager wrapped can be attributed.
                const identity = this.commandIdentities.get(denial.commandId);
                if (identity === undefined) continue;
                const key = violationKey(denial.commandId, denial.violation.line);
                if (this.loggedLines.has(key)) continue;
                this.noteLoggedLine(key);
                this.log({
                    type: "sandbox_violation",
                    recovered: true,
                    session_id: identity.sessionId,
                    tool_call_id: identity.toolCallId,
                    command_id: denial.commandId,
                    kind: denial.violation.kind,
                    target: denial.violation.target,
                    raw: denial.violation.line,
                });
            }
        }
    }

    private scanForProtected(workspace: string): ProtectedScanResult {
        if (this.platform !== "linux") return { ok: true, paths: [] };
        const shared = linkedWorktreeSharedDirectory(workspace);
        const roots = shared === undefined ? [workspace] : [workspace, shared];
        try {
            const scan = this.options.scanProtected ?? ((paths) =>
                scanNestedProtectedPaths({
                    roots: paths,
                    protectedFiles: DANGEROUS_FILES,
                    protectedDirectories: getDangerousDirectories(),
                }));
            return scan(roots);
        } catch (error) {
            return { ok: false, reason: messageOf(error) };
        }
    }

    private rememberCommand(
        commandId: string,
        sessionId: string,
        toolCallId: string,
    ): void {
        this.commandIdentities.set(commandId, { sessionId, toolCallId });
        trimMap(this.commandIdentities, MAX_REMEMBERED_COMMANDS);
    }

    private noteLoggedLine(key: string): void {
        this.loggedLines.set(key, true);
        trimMap(this.loggedLines, MAX_REMEMBERED_LINES);
    }

    inspection(): SandboxInspection {
        const config = this.options.config();
        if (!config.enabled) {
            return {
                enabled: false,
                status: "active",
                network: config.network,
                allowedDomains: [...config.allowed_domains],
            };
        }
        const availability = this.availability();
        if (!availability.ok) {
            return {
                enabled: true,
                status: "unavailable",
                network: config.network,
                allowedDomains: [...config.allowed_domains],
                reason: availability.reason ?? "unknown reason",
            };
        }
        return {
            enabled: true,
            status: "active",
            network: config.network,
            allowedDomains: [...config.allowed_domains],
        };
    }

    async dispose(): Promise<void> {
        this.disposed = true;
        this.recoveryPending = false;
        this.pendingSpans = [];
        this.spanStarts.clear();
        if (this.recoveryTimer !== undefined) {
            clearTimeout(this.recoveryTimer);
            this.recoveryTimer = undefined;
        }
        if (this.recoveryWaitTimer !== undefined) {
            clearTimeout(this.recoveryWaitTimer);
            this.recoveryWaitTimer = undefined;
        }
        const wake = this.recoveryWaitResolve;
        this.recoveryWaitResolve = undefined;
        wake?.();
        // A pending pass is cancelled, not awaited; whoever waits on it stops
        // waiting now.
        const resolve = this.recoveryResolve;
        this.recoveryResolve = undefined;
        resolve?.();
        this.recoveryAbort?.abort();
        if (this.state === "ready" || this.state === "starting") {
            await Promise.allSettled([Srt.reset(), stopStrayMonitors()]);
        }
        this.state = "idle";
    }

    // srt returns from initialize before its `log stream` child is attached,
    // so a command that starts at once can be denied with nothing recorded.
    // Write once to a path this wrap denies and wait, bounded, until it is
    // recorded. False means the wait ran out; enforcement still works.
    private async awaitViolationMonitor(): Promise<boolean> {
        if (this.platform !== "darwin" || this.currentPolicy === undefined) {
            return true;
        }
        const timeout = this.options.monitorTimeoutMs ?? MONITOR_READY_TIMEOUT_MS;
        const target = join(
            tmpdir(),
            `.vera-sandbox-probe-${randomBytes(8).toString("hex")}`,
        );
        const commandId = `vera-monitor-${randomBytes(8).toString("hex")}`;
        let cancelled = false;
        let child: ReturnType<typeof Bun.spawn> | undefined;
        const probe = (async (): Promise<boolean> => {
            const config = perCommandConfig(this.currentPolicy!);
            const wrapped = await Srt.wrapWithSandboxArgv(
                `printf x > '${target}' || true`,
                "bash",
                {
                    ...config,
                    filesystem: {
                        ...config.filesystem,
                        denyWrite: [...config.filesystem.denyWrite, target],
                    },
                } as Partial<SandboxRuntimeConfig>,
                undefined,
                undefined,
                { commandId, commandText: "sandbox monitor probe" },
            );
            if (cancelled) return false;
            child = Bun.spawn([...wrapped.argv], {
                stdin: "ignore",
                stdout: "ignore",
                stderr: "ignore",
                env: { ...process.env, ...wrapped.env },
            });
            const store = Srt.getSandboxViolationStore();
            while (!cancelled) {
                if (store.getViolationsForCommand(commandId).length > 0) {
                    store.clear();
                    return true;
                }
                await new Promise((resolve) => setTimeout(resolve, MONITOR_POLL_MS));
            }
            return false;
        })().catch(() => false);
        let timer: ReturnType<typeof setTimeout> | undefined;
        const bounded = await Promise.race([
            probe,
            new Promise<boolean>((resolve) => {
                timer = setTimeout(() => resolve(false), timeout);
            }),
        ]);
        if (timer !== undefined) clearTimeout(timer);
        if (!bounded) {
            cancelled = true;
            try {
                child?.kill();
            } catch {
                // The probe process exited on its own.
            }
            try {
                Srt.getSandboxViolationStore().clear();
            } catch {
                // Nothing was recorded to clear.
            }
        }
        return bounded;
    }

    private policyFor(
        workspace: string,
        scratchDir: string | undefined,
        config: SandboxConfig,
        scanned: readonly string[],
    ): SandboxPolicy {
        const sharedGitDir = linkedWorktreeSharedDirectory(workspace);
        return compileSandboxPolicy({
            workspace,
            platform: this.platform,
            protectedFiles: DANGEROUS_FILES,
            protectedDirectories: getDangerousDirectories(),
            ...(scratchDir === undefined ? {} : { scratchDir }),
            home: this.options.home,
            otherCheckouts: otherCheckoutRoots(workspace),
            ...(sharedGitDir === undefined ? {} : { sharedGitDir }),
            scannedWriteDenies: scanned,
            config,
            permissionRules: this.options.permissionRules(),
        });
    }

    private get ready(): boolean {
        return this.state === "ready";
    }

    private async ensureStarted(config: SandboxConfig): Promise<boolean> {
        if (this.ready) return true;
        if (this.state === "unavailable") return false;
        if (this.starting !== undefined) {
            await this.starting;
            return this.ready;
        }
        const availability = this.availability();
        if (!availability.ok) {
            this.goUnavailable(availability);
            return false;
        }
        this.state = "starting";
        this.starting = (async () => {
            try {
                await Srt.initialize(
                    baseConfig() as SandboxRuntimeConfig,
                    undefined,
                    true,
                );
                if (this.disposed) return;
                const monitor = await this.awaitViolationMonitor();
                if (this.disposed) return;
                this.state = "ready";
                this.log({
                    type: "sandbox_started",
                    platform: process.platform,
                    srt_version: SRT_VERSION,
                    dependencies: {
                        errors: availability.errors,
                        warnings: availability.warnings,
                    },
                    writable: effectiveWritable(
                        this.currentPolicy?.filesystem.allowWrite ?? [],
                    ),
                    deny_read: this.currentPolicy?.filesystem.denyRead ?? [],
                    deny_write: this.currentPolicy?.filesystem.denyWrite ?? [],
                    network: config.network,
                    allowed_hosts: config.allowed_domains.length,
                });
                if (!monitor) {
                    this.log({
                        type: "sandbox_monitor_unconfirmed",
                        level: "warn",
                        platform: process.platform,
                        timeout_ms: this.options.monitorTimeoutMs
                            ?? MONITOR_READY_TIMEOUT_MS,
                        reason: "srt did not report the probe violation in time; "
                            + "a blocked command may end without its violation lines",
                    });
                }
            } catch (error) {
                if (!this.disposed) {
                    this.goUnavailable({
                        ok: false,
                        reason: messageOf(error),
                        errors: [messageOf(error)],
                        warnings: availability.warnings,
                    });
                }
            } finally {
                this.starting = undefined;
            }
        })();
        await this.starting;
        return this.ready;
    }

    private availability(): Availability {
        if (this.state === "ready") {
            return { ok: true, errors: [], warnings: [] };
        }
        if (this.state === "unavailable") {
            return this.failure ?? {
                ok: false,
                reason: this.reason,
                errors: [],
                warnings: [],
            };
        }
        if (!Srt.isSupportedPlatform()) {
            return {
                ok: false,
                reason: `not supported on ${process.platform}`,
                errors: [],
                warnings: [],
            };
        }
        let dependencies: SandboxAvailability;
        try {
            dependencies = this.options.readDependencies?.()
                ?? { ok: true, ...Srt.checkDependencies() };
        } catch (error) {
            return {
                ok: false,
                reason: messageOf(error),
                errors: [],
                warnings: [],
            };
        }
        if (dependencies.ok === false) return dependencies;
        if (dependencies.errors.length > 0) {
            return {
                ok: false,
                reason: dependencies.errors.join("; "),
                errors: dependencies.errors,
                warnings: dependencies.warnings,
            };
        }
        // srt treats a missing seccomp filter as a warning and runs anyway,
        // leaving Unix sockets reachable. A release supplies its own copy.
        if (
            seccompApplyPath() === undefined
            && dependencies.warnings.some((warning) => warning.includes("seccomp"))
        ) {
            return {
                ok: false,
                reason: "the seccomp filter is unavailable, so Unix sockets would not be restricted",
                errors: [],
                warnings: dependencies.warnings,
            };
        }
        return { ok: true, errors: [], warnings: dependencies.warnings };
    }

    private goUnavailable(availability: Availability): void {
        this.state = "unavailable";
        this.failure = availability;
        this.reason = availability.reason ?? "unknown reason";
        this.log({
            type: "sandbox_unavailable",
            level: "warn",
            platform: process.platform,
            srt_version: SRT_VERSION,
            reason: this.reason,
            errors: availability.errors,
            warnings: availability.warnings,
            install: installHint(this.platform),
        });
    }

    private unavailableNotice(sessionId: string): string | undefined {
        const availability = this.availability();
        if (!availability.ok && !this.warned.has(sessionId)) {
            this.warned.add(sessionId);
            const reason = (availability.reason ?? "unknown reason")
                .replace(/\.$/, "");
            const install = installHint(this.platform);
            return `Sandbox unavailable: ${reason}. Commands run unsandboxed.`
                + (install === undefined ? "" : ` ${install}`);
        }
        return undefined;
    }

    private notePolicy(
        workspace: string,
        scratchDir: string | undefined,
        config: SandboxConfig,
        scanned: readonly string[],
    ): void {
        const policy = this.policyFor(workspace, scratchDir, config, scanned);
        this.currentPolicy = policy;
        const key = JSON.stringify([policy, config.network]);
        if (this.lastPolicyKey === undefined) {
            this.lastPolicyKey = key;
            return;
        }
        if (this.lastPolicyKey === key) return;
        this.lastPolicyKey = key;
        this.log({
            type: "sandbox_policy_changed",
            writable: effectiveWritable(policy.filesystem.allowWrite),
            deny_read: policy.filesystem.denyRead,
            deny_write: policy.filesystem.denyWrite,
            network: config.network,
            allowed_hosts: config.allowed_domains.length,
        });
    }

    private readViolations(commandId: string): readonly SandboxViolation[] {
        try {
            return Srt.getSandboxViolationStore()
                .getViolationsForCommand(commandId)
                .map((violation) => classifyViolation(violation.line));
        } catch {
            return [];
        }
    }

    private violationTotal(): number {
        try {
            return Srt.getSandboxViolationStore().getTotalCount();
        } catch {
            return 0;
        }
    }

    private finish(
        prepared: SandboxPreparedCommand,
        violations: readonly SandboxViolation[],
        exitCode: number | null,
    ): SandboxSettledCommand {
        const existing = this.results.get(prepared);
        if (existing !== undefined) return existing;
        const listed = violations.filter((violation) => violation.kind !== "other");
        for (const violation of violations) {
            const key = violationKey(prepared.commandId, violation.line);
            const alreadyLogged = this.loggedLines.has(key);
            this.noteLoggedLine(key);
            // A line the background recovery already wrote is not written again.
            if (alreadyLogged) continue;
            this.log({
                type: "sandbox_violation",
                session_id: prepared.sessionId,
                tool_call_id: prepared.toolCallId,
                command_id: prepared.commandId,
                kind: violation.kind,
                target: violation.target,
                raw: violation.line,
            });
        }
        const droppedElsewhere =
            this.violationTotal() - prepared.violationsBefore > violations.length;
        this.logCommand({
            sessionId: prepared.sessionId,
            toolCallId: prepared.toolCallId,
            commandId: prepared.commandId,
            wrapped: true,
            ...(exitCode === null ? {} : { exitCode }),
            violations: listed.length,
            truncated: droppedElsewhere,
        });
        const block = formatViolationBlock(violations);
        const result: SandboxSettledCommand = {
            suffix: block === "" ? "" : `\n\n${block}`,
            violations,
        };
        this.results.set(prepared, result);
        return result;
    }

    private logCommand(command: {
        readonly sessionId: string;
        readonly toolCallId: string;
        readonly commandId: string;
        readonly wrapped: boolean;
        readonly reason?: "unavailable" | "full_access";
        readonly wrapError?: string;
        readonly exitCode?: number;
        readonly violations?: number;
        readonly truncated?: boolean;
    }): void {
        this.log({
            type: "sandbox_command",
            session_id: command.sessionId,
            tool_call_id: command.toolCallId,
            command_id: command.commandId,
            wrapped: command.wrapped,
            ...(command.reason === undefined ? {} : { reason: command.reason }),
            ...(command.wrapError === undefined ? {} : { wrap_error: command.wrapError }),
            ...(command.exitCode === undefined ? {} : { exit_code: command.exitCode }),
            ...(command.violations === undefined ? {} : { violations: command.violations }),
            ...(command.truncated === undefined ? {} : { truncated: command.truncated }),
        });
    }

    private log(entry: Parameters<HostLog>[0]): void {
        if (this.disposed) return;
        this.options.log(entry);
    }
}

/**
 * srt keeps its `log stream` child in a closure and hands back only a
 * shutdown function, whose SIGTERM does not outlast a process that exits at
 * once. The child is still this process's, so find it by parent and wait
 * for it, killing what is left.
 */
async function stopStrayMonitors(): Promise<void> {
    if (process.platform !== "darwin") return;
    for (const pid of monitorPids()) {
        try {
            process.kill(pid, "SIGTERM");
        } catch {
            // Already gone.
        }
    }
    for (let attempt = 0; attempt < MONITOR_EXIT_ATTEMPTS; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, MONITOR_EXIT_MS));
        if (monitorPids().length === 0) return;
    }
    for (const pid of monitorPids()) {
        try {
            process.kill(pid, "SIGKILL");
        } catch {
            // Already gone.
        }
    }
}

function monitorPids(): number[] {
    let listing: string;
    try {
        const result = Bun.spawnSync(
            ["ps", "-Ao", "pid=,ppid=,comm=,args="],
            { stdout: "pipe", stderr: "ignore" },
        );
        listing = result.stdout.toString();
    } catch {
        return [];
    }
    const pids: number[] = [];
    for (const line of listing.split("\n")) {
        const columns = line.trim().split(/\s+/);
        if (columns.length < 4) continue;
        const [pid, parent, name] = columns;
        if (parent !== String(process.pid)) continue;
        if (name !== "log") continue;
        if (!line.includes(" stream --predicate ")) continue;
        if (!line.includes("ENDSWITH")) continue;
        const value = Number(pid);
        if (Number.isInteger(value)) pids.push(value);
    }
    return pids;
}

function commandIdFor(request: SandboxCommandRequest): string {
    const random = randomBytes(16).toString("base64url");
    return `${random}-${request.sessionId}-${request.toolCallId}`.slice(
        0,
        MAX_COMMAND_ID,
    );
}

function baseConfig(): unknown {
    return {
        network: { allowMachLookup: [...DNS_MACH_SERVICES] },
        filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
        ...(seccompApplyPath() === undefined
            ? {}
            : { seccomp: { applyPath: seccompApplyPath() } }),
    };
}

interface CommandFilesystemConfig {
    denyRead: string[];
    allowWrite: string[];
    denyWrite: string[];
}

interface CommandConfig {
    filesystem: CommandFilesystemConfig;
    network?: { allowedDomains: string[]; deniedDomains: string[] };
}

function perCommandConfig(policy: SandboxPolicy): CommandConfig {
    return {
        filesystem: {
            denyRead: [...policy.filesystem.denyRead],
            allowWrite: [...policy.filesystem.allowWrite],
            denyWrite: [...policy.filesystem.denyWrite],
        },
        ...(policy.network === undefined
            ? {}
            : {
                network: {
                    allowedDomains: [...policy.network.allowedDomains],
                    deniedDomains: [...policy.network.deniedDomains],
                },
            }),
    };
}

/** The writable list as srt sees it: the policy's folders plus srt's own. */
function effectiveWritable(allowWrite: readonly string[]): readonly string[] {
    return [...new Set([...allowWrite, ...getDefaultWritePaths()])];
}

// A compiled release bundles srt into the executable, so import.meta.url no
// longer names a directory on disk. The vendor files ship beside the binary.
function seccompApplyPath(): string | undefined {
    if (process.platform !== "linux") return undefined;
    if (process.arch !== "x64" && process.arch !== "arm64") return undefined;
    const path = join(
        dirname(process.execPath),
        "node_modules",
        "@anthropic-ai",
        "sandbox-runtime",
        "vendor",
        "seccomp",
        process.arch,
        "apply-seccomp",
    );
    return existsSync(path) ? path : undefined;
}

function installHint(platform: NodeJS.Platform): string | undefined {
    if (platform === "linux") {
        return "Install bubblewrap, socat and ripgrep with your package manager.";
    }
    return undefined;
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function trimMap(map: Map<string, unknown>, limit: number): void {
    while (map.size > limit) {
        const oldest = map.keys().next().value;
        if (oldest === undefined) return;
        map.delete(oldest);
    }
}
