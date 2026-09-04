/** Outrider's CLI seam. Vera runs the commands and reads what comes back; it reimplements none of it. Everything here is pure, so the shapes can be tested without a binary on the machine. */

/** Where the gateway is, in Outrider's own words. `absent` means no binary on this machine, which is the only state Vera can act on by installing. */
export type OutriderState = "absent" | "stopped" | "running";

export interface OutriderPresence {
    readonly state: OutriderState;
    readonly endpoint?: string;
    /** The profile the running gateway is serving. */
    readonly profile?: string;
}

/**
 * One line of the progress stream. A line with a `total` is a download and
 * draws as a bar; one without is a step and draws as a check. The fields
 * mirror `DownloadProgress` in `internal/llama/download.go`, snake_case on the
 * wire, with the duration spelled in seconds because a Go duration marshals as
 * nanoseconds.
 */
export interface OutriderProgress {
    readonly name: string;
    readonly done: boolean;
    readonly downloaded?: number;
    readonly total?: number;
    readonly bytesPerSecond?: number;
    readonly etaSeconds?: number;
}

export const OUTRIDER_BINARY = "outrider";

/** `ps` is the status command; `status` is its compatibility alias. */
export function outriderStatusCommand(): readonly string[] {
    return [OUTRIDER_BINARY, "--json", "ps"];
}

/** One command fetches the runtime, fetches the weights, and brings the gateway up on that profile. There is no separate install or pull. */
export function outriderServeCommand(profile: string): readonly string[] {
    return [OUTRIDER_BINARY, "--json", "serve", profile];
}

/** Does this profile fit this machine, in Outrider's own reckoning rather than ours. */
export function outriderCheckCommand(profile: string): readonly string[] {
    return [OUTRIDER_BINARY, "--json", "check", profile];
}

export const OUTRIDER_INSTALL_URL = "https://get.corvines.com/outrider";

/** The binary cannot place itself, so the one thing Vera does not get from the CLI is the CLI. */
export function outriderInstallCommand(): readonly string[] {
    return ["sh", "-c", `curl -fsSL ${OUTRIDER_INSTALL_URL} | sh`];
}

interface StatusPayload {
    readonly kind?: unknown;
    readonly endpoint?: unknown;
    readonly preset?: unknown;
    readonly health?: unknown;
}

/**
 * What `ps` said. Running means the process is up and healthy: a gateway that
 * is up and failing its own health check is not something to point a provider
 * row at, so it reads as stopped.
 */
export function readOutriderStatus(stdout: string): OutriderPresence {
    let payload: StatusPayload;
    try {
        payload = JSON.parse(stdout) as StatusPayload;
    } catch {
        return { state: "stopped" };
    }
    const running = payload.kind === "running" && payload.health !== false;
    return {
        state: running ? "running" : "stopped",
        ...(typeof payload.endpoint === "string" && payload.endpoint !== ""
            ? { endpoint: payload.endpoint }
            : {}),
        ...(typeof payload.preset === "string" && payload.preset !== ""
            ? { profile: payload.preset }
            : {}),
    };
}

function count(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) && value >= 0
        ? value
        : undefined;
}

/**
 * One progress line, or nothing. The human renderer writes a bar on the same
 * stream, so anything that is not a progress object is skipped rather than
 * treated as a failure.
 */
export function parseOutriderProgress(
    line: string,
): OutriderProgress | undefined {
    const text = line.trim();
    if (!text.startsWith("{")) return undefined;
    let payload: Record<string, unknown>;
    try {
        payload = JSON.parse(text) as Record<string, unknown>;
    } catch {
        return undefined;
    }
    const name = payload.name;
    if (typeof name !== "string" || name === "") return undefined;
    const downloaded = count(payload.downloaded);
    const total = count(payload.total);
    const rate = count(payload.bytes_per_second);
    const eta = count(payload.eta_seconds);
    return {
        name,
        done: payload.done === true,
        ...(downloaded === undefined ? {} : { downloaded }),
        ...(total === undefined || total === 0 ? {} : { total }),
        ...(rate === undefined ? {} : { bytesPerSecond: rate }),
        ...(eta === undefined ? {} : { etaSeconds: eta }),
    };
}

/** One line per named piece, newest wins, first-seen order kept. A download reports many times and should not stack up. */
export function mergeProgress(
    lines: readonly OutriderProgress[],
    line: OutriderProgress,
): readonly OutriderProgress[] {
    const at = lines.findIndex((entry) => entry.name === line.name);
    if (at === -1) return [...lines, line];
    return lines.map((entry, index) => index === at ? line : entry);
}

/** One decimal in the unit the download is actually in, so a runtime is megabytes and a model is gigabytes. */
export function downloadSize(bytes: number): string {
    if (bytes < 1_000_000_000) {
        return `${(bytes / 1_000_000).toFixed(1)} MB`;
    }
    return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
}

/** How long is left, rounded to the unit a person waits in. */
export function remaining(seconds: number): string {
    if (seconds < 60) return `~${Math.max(1, Math.round(seconds))} sec`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `~${minutes} min`;
    return `~${Math.round(minutes / 6) / 10} hr`;
}

/** One line of a `check` report. `warn` is not a refusal: the profile still runs, and a report can carry several. */
export type OutriderCheckResult = "pass" | "warn" | "fail";

export interface OutriderCheck {
    readonly id: string;
    readonly result: OutriderCheckResult;
    readonly measured?: string;
    readonly required?: string;
    readonly nextAction?: string;
}

export interface OutriderVerdict {
    /** Outrider's own word for the whole report. */
    readonly verdict: string;
    readonly checks: readonly OutriderCheck[];
}

function checkResult(value: unknown): OutriderCheckResult | undefined {
    return value === "pass" || value === "warn" || value === "fail"
        ? value
        : undefined;
}

function text(value: unknown): string | undefined {
    return typeof value === "string" && value !== "" ? value : undefined;
}

/** What `check` said, sub-checks kept. A report read as one word cannot tell a machine that is too small from a runtime that has not been fetched yet, and those need opposite answers. */
export function readOutriderVerdict(stdout: string): OutriderVerdict {
    let payload: { class?: unknown; checks?: unknown };
    try {
        payload = JSON.parse(stdout) as { class?: unknown; checks?: unknown };
    } catch {
        return { verdict: "unknown", checks: [] };
    }
    const raw = Array.isArray(payload.checks) ? payload.checks : [];
    const checks = raw.flatMap((entry): OutriderCheck[] => {
        if (typeof entry !== "object" || entry === null) return [];
        const line = entry as Record<string, unknown>;
        const id = text(line.id);
        const result = checkResult(line.result);
        if (id === undefined || result === undefined) return [];
        const measured = text(line.measured);
        const required = text(line.required);
        const nextAction = text(line.nextAction);
        return [{
            id,
            result,
            ...(measured === undefined ? {} : { measured }),
            ...(required === undefined ? {} : { required }),
            ...(nextAction === undefined ? {} : { nextAction }),
        }];
    });
    return { verdict: text(payload.class) ?? "unknown", checks };
}

/** The sub-check that says the gateway has no runtime yet. Every profile reports it on a machine that has never served one, so it says nothing about the profile. */
const RUNTIME_CHECK = "runtime_capabilities";

/** The sub-check that measures this machine against what the profile was qualified on. */
const MEMORY_CHECK = "physical_memory";

function warned(verdict: OutriderVerdict, id: string): boolean {
    return verdict.checks.some((check) =>
        check.id === id && check.result !== "pass"
    );
}

/** The report is held back only by a runtime that is not fetched yet, which `serve` fixes on its way to the model. Asking before that point tells you nothing, so a caller may go ahead. */
export function awaitingRuntime(verdict: OutriderVerdict): boolean {
    return warned(verdict, RUNTIME_CHECK);
}

/** This machine is under the memory the profile was qualified on. Unlike the runtime warning, nothing Vera does next clears it. */
export function shortOfMemory(verdict: OutriderVerdict): boolean {
    return warned(verdict, MEMORY_CHECK);
}
