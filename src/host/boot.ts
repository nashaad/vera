import type { HostLockRecord } from "./lockfile.ts";

export type BootStatus = "ok" | "fixed" | "warn" | "failed";
// "single" runs the host as one process with no session workers.
export type HostMode = "default" | "single";

export interface BootCheck {
    readonly label: string;
    readonly status: BootStatus;
    readonly detail?: string;
}

export interface BootInspection {
    // The Vera home this boot serves; always shown first.
    readonly home: string;
    // A host answered on this home's socket.
    readonly hostAnswers: boolean;
    readonly lock: "absent" | "live" | "stale" | "damaged";
    // Vera processes for this home with no answering host behind them.
    readonly orphans: number;
    // Processes that may belong to this home but could not be proven to.
    readonly unproven: number;
    // One line per unidentified process, with any session files it holds open.
    readonly unknownProcesses?: readonly string[];
    // A message when the active release cannot run; undefined when it can or when no release is installed.
    readonly releaseProblem?: string;
    readonly bootLoop: boolean;
}

export interface RecoveryResult {
    readonly ok: boolean;
    // False when there was nothing to repair.
    readonly changed?: boolean;
    readonly lines: readonly string[];
}

export interface BootDependencies {
    // Cheap test for a published, live host; when true the full inspection is skipped.
    hostPublished?(): Promise<boolean>;
    inspect(): Promise<BootInspection>;
    // Backs up records, stops this home's leftover processes and clears stale runtime files.
    recover(): Promise<RecoveryResult>;
    start(mode: HostMode): Promise<HostLockRecord>;
    // Moves current to the last known good release; returns its build or undefined when there is none.
    rollback(): Promise<string | undefined>;
    clearBootFailures(): void;
    // Asked only when a live host may be running turns.
    confirm(question: BootQuestion): Promise<boolean>;
    // Last resort: moves the runtime folder aside and starts an empty one.
    stash?(unknownProcesses: readonly string[]): Promise<{ readonly path: string; readonly notCarried: readonly string[] }>;
    restoreStash?(path: string): Promise<void>;
    stopHost?(host: HostLockRecord): Promise<void>;
    render(checks: readonly BootCheck[]): void;
    // Called for each check as it is decided, for clients that draw their own box.
    onCheck?(check: BootCheck): void;
    // Run every check and show the box even when a healthy host is already running.
    full?: boolean;
}

export interface BootQuestion {
    readonly id: "restart_running_host" | "stash_runtime" | "keep_fresh_runtime";
    readonly text: string;
}

export class BootFailedError extends Error {
    constructor(readonly checks: readonly BootCheck[], cause: unknown) {
        super(`Vera could not start a host: ${errorText(cause)}`);
        this.name = "BootFailedError";
    }
}

// Starts the resident host. Checks the home first, repairs what it can, and falls
// back to single process mode and then to the previous release before giving up.
export async function bootResidentHost(deps: BootDependencies): Promise<HostLockRecord> {
    const checks = new CheckList(deps.onCheck);
    if (deps.full !== true && deps.hostPublished !== undefined && await deps.hostPublished().catch(() => false)) {
        try {
            return await deps.start("default");
        } catch {
            // Falls through to the full check below.
        }
    }
    const inspection = await deps.inspect();
    const healthy = inspection.hostAnswers && inspection.lock === "live";
    if (healthy) {
        try {
            const host = await deps.start("default");
            if (deps.full === true) {
                checks.push(...describe(inspection));
                checks.push({ label: "Host", status: "ok", detail: `PID ${host.pid}${host.build_id === undefined ? "" : `, build ${host.build_id}`}` });
                deps.render(checks);
            }
            return host;
        } catch (error) {
            checks.push({ label: "Running host", status: "failed", detail: errorText(error) });
            if (!await deps.confirm({ id: "restart_running_host", text: "The running Vera host is not responding properly. Stop it and start a fresh one?" })) {
                deps.render(checks);
                throw new BootFailedError(checks, error);
            }
        }
    } else {
        checks.push(...describe(inspection));
    }

    if (!healthy && needsRepair(inspection)) {
        await recoverInto(deps, checks);
    } else if (healthy) {
        await recoverInto(deps, checks);
    }
    if (inspection.releaseProblem !== undefined) {
        await rollbackInto(deps, checks);
    }

    let lastError: unknown;
    const attempts: Array<{ mode: HostMode; label: string }> = [
        { mode: "default", label: "Host start" },
        { mode: "single", label: "Host start, single process" },
    ];
    for (const attempt of attempts) {
        try {
            const host = await deps.start(attempt.mode);
            checks.push({ label: attempt.label, status: "ok", detail: `PID ${host.pid}${host.build_id === undefined ? "" : `, build ${host.build_id}`}` });
            if (deps.full === true || checks.some((check) => check.status !== "ok")) deps.render(checks);
            return host;
        } catch (error) {
            lastError = error;
            checks.push({ label: attempt.label, status: "failed", detail: errorText(error) });
            await recoverInto(deps, checks);
        }
    }
    if (inspection.releaseProblem === undefined && await rollbackInto(deps, checks)) {
        try {
            const host = await deps.start("single");
            checks.push({ label: "Host start, previous release", status: "ok", detail: `PID ${host.pid}` });
            deps.render(checks);
            return host;
        } catch (error) {
            lastError = error;
            checks.push({ label: "Host start, previous release", status: "failed", detail: errorText(error) });
        }
    }
    const fresh = await startFromStash(deps, checks, inspection);
    if (fresh !== undefined) return fresh;
    deps.render(checks);
    throw new BootFailedError(checks, lastError);
}

// Every other step failed. With the user's consent the runtime folder is stashed and a host
// starts in an empty one; the user then keeps it or rolls the stash back.
async function startFromStash(
    deps: BootDependencies,
    checks: BootCheck[],
    inspection: BootInspection,
): Promise<HostLockRecord | undefined> {
    if (deps.stash === undefined || deps.restoreStash === undefined) return undefined;
    const unknown = inspection.unknownProcesses ?? [];
    const before = [
        "Vera could not start with its current runtime folder.",
        ...(unknown.length === 0 ? [] : ["These processes could not be identified and will be left running:", ...unknown.map((line) => `  ${line}`)]),
        "Move the runtime folder to a stash and start fresh? The inbox, schedules and session blocks are copied over, and the stash can be put back.",
    ].join("\n");
    if (!await deps.confirm({ id: "stash_runtime", text: before })) {
        checks.push({ label: "Fresh runtime", status: "warn", detail: "declined; nothing was moved" });
        return undefined;
    }
    let stash: { readonly path: string; readonly notCarried: readonly string[] };
    try {
        stash = await deps.stash(unknown);
    } catch (error) {
        checks.push({ label: "Fresh runtime", status: "failed", detail: errorText(error) });
        return undefined;
    }
    checks.push({
        label: "Fresh runtime",
        status: "fixed",
        detail: `stashed to ${stash.path}${stash.notCarried.length === 0 ? "" : `; left in the stash: ${stash.notCarried.join(", ")}`}`,
    });
    for (const mode of ["default", "single"] as const) {
        let host: HostLockRecord;
        try {
            host = await deps.start(mode);
        } catch (error) {
            checks.push({ label: `Host start on fresh runtime${mode === "single" ? ", single process" : ""}`, status: "failed", detail: errorText(error) });
            continue;
        }
        checks.push({ label: `Host start on fresh runtime${mode === "single" ? ", single process" : ""}`, status: "ok", detail: `PID ${host.pid}` });
        const keep = await deps.confirm({
            id: "keep_fresh_runtime",
            text: `Vera started on a fresh runtime folder (host PID ${host.pid}). Keep it? Answer no to stop this host and put the stash back.`,
        });
        if (keep) {
            checks.push({ label: "Stash", status: "ok", detail: `kept at ${stash.path}` });
            deps.render(checks);
            return host;
        }
        await rollBackStash(deps, checks, stash.path, host);
        deps.render(checks);
        throw new BootFailedError(checks, new Error("The fresh runtime was rolled back at your request."));
    }
    await rollBackStash(deps, checks, stash.path, undefined);
    return undefined;
}

async function rollBackStash(
    deps: BootDependencies,
    checks: BootCheck[],
    path: string,
    host: HostLockRecord | undefined,
): Promise<void> {
    try {
        if (host !== undefined) await deps.stopHost?.(host);
        await deps.restoreStash!(path);
        checks.push({ label: "Stash", status: "warn", detail: "rolled back; the runtime folder is as it was" });
    } catch (error) {
        checks.push({ label: "Stash", status: "failed", detail: `could not roll back: ${errorText(error)}; it is still at ${path}` });
    }
}

function needsRepair(inspection: BootInspection): boolean {
    return inspection.orphans > 0 || inspection.lock === "stale" || inspection.lock === "damaged"
        || (inspection.lock === "live" && !inspection.hostAnswers) || inspection.bootLoop;
}

class CheckList extends Array<BootCheck> {
    constructor(private readonly onCheck?: (check: BootCheck) => void) {
        super();
    }

    override push(...items: BootCheck[]): number {
        for (const item of items) this.onCheck?.(item);
        return super.push(...items);
    }

    static override get [Symbol.species](): ArrayConstructor {
        return Array;
    }
}

function describe(inspection: BootInspection): BootCheck[] {
    const checks: BootCheck[] = [{ label: "Vera home", status: "ok", detail: inspection.home }];
    checks.push(inspection.releaseProblem === undefined
        ? { label: "Release", status: "ok" }
        : { label: "Release", status: "failed", detail: inspection.releaseProblem });
    const lock: Record<BootInspection["lock"], BootCheck> = {
        absent: { label: "Host lock", status: "ok", detail: "no host running" },
        live: { label: "Host lock", status: inspection.hostAnswers ? "ok" : "failed", detail: inspection.hostAnswers ? undefined : "names a live process that does not answer" },
        stale: { label: "Host lock", status: "failed", detail: "names a process that has exited" },
        damaged: { label: "Host lock", status: "failed", detail: "unreadable" },
    };
    checks.push(lock[inspection.lock]);
    checks.push(inspection.orphans === 0
        ? { label: "Leftover processes", status: "ok" }
        : { label: "Leftover processes", status: "failed", detail: `${inspection.orphans} Vera process${inspection.orphans === 1 ? "" : "es"} for this home with no working host` });
    if (inspection.unproven > 0) {
        checks.push({ label: "Unidentified processes", status: "warn", detail: `${inspection.unproven} could not be proven to belong to this home and were left alone` });
    }
    if (inspection.bootLoop) {
        checks.push({ label: "Recent start failures", status: "failed", detail: "the host exited during startup more than once" });
    }
    return checks;
}

async function recoverInto(deps: BootDependencies, checks: BootCheck[]): Promise<void> {
    deps.clearBootFailures();
    try {
        const result = await deps.recover();
        checks.push({
            label: "Recovery",
            status: !result.ok ? "warn" : result.changed === false ? "ok" : "fixed",
            ...(result.lines.length === 0 ? {} : { detail: result.lines.join(" ") }),
        });
    } catch (error) {
        checks.push({ label: "Recovery", status: "warn", detail: errorText(error) });
    }
}

async function rollbackInto(deps: BootDependencies, checks: BootCheck[]): Promise<boolean> {
    try {
        const build = await deps.rollback();
        if (build === undefined) return false;
        checks.push({ label: "Previous release", status: "fixed", detail: `current moved back to ${build}` });
        return true;
    } catch (error) {
        checks.push({ label: "Previous release", status: "warn", detail: errorText(error) });
        return false;
    }
}

const MARK: Record<BootStatus, string> = { ok: "[ok]", fixed: "[fixed]", warn: "[warn]", failed: "[fail]" };

export function renderBootBox(checks: readonly BootCheck[], width = 72): string {
    const inner = width - 4;
    const lines: string[] = ["Vera startup check", ""];
    for (const check of checks) {
        lines.push(...wrap(`${MARK[check.status].padEnd(8)}${check.label}${check.detail === undefined ? "" : `: ${check.detail}`}`, inner, 8));
    }
    const failed = checks.some((check) => check.status === "failed") && !checks.some((check) => check.label.startsWith("Host start") && check.status === "ok");
    const repaired = checks.some((check) => check.status === "fixed" || check.status === "failed");
    lines.push("", failed
        ? "Vera could not start. Records were backed up under runtime/backups."
        : repaired ? "Vera repaired its startup and is continuing." : "Vera is running.");
    const top = `+${"-".repeat(width - 2)}+`;
    return [top, ...lines.map((line) => `| ${line.padEnd(inner)} |`), top, ""].join("\n");
}

function wrap(text: string, width: number, indent: number): string[] {
    const out: string[] = [];
    let rest = text;
    let first = true;
    while (rest.length > 0) {
        const room = first ? width : width - indent;
        let cut = rest.length <= room ? rest.length : rest.lastIndexOf(" ", room);
        if (cut <= 0) cut = Math.min(room, rest.length);
        out.push(`${first ? "" : " ".repeat(indent)}${rest.slice(0, cut)}`);
        rest = rest.slice(cut).trimStart();
        first = false;
    }
    return out;
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
