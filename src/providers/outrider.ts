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
    return [OUTRIDER_BINARY, "ps"];
}

/** One command fetches the runtime, fetches the weights, and brings the gateway up on that profile. There is no separate install or pull. */
export function outriderServeCommand(profile: string): readonly string[] {
    return [OUTRIDER_BINARY, "serve", profile];
}

/** Does this profile fit this machine, in Outrider's own reckoning rather than ours. */
export function outriderCheckCommand(profile: string): readonly string[] {
    return [OUTRIDER_BINARY, "check", profile];
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

/** Gigabytes to one decimal, the unit a model download is read in. */
export function gigabytes(bytes: number): string {
    return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
}

/** How long is left, rounded to the unit a person waits in. */
export function remaining(seconds: number): string {
    if (seconds < 60) return `~${Math.max(1, Math.round(seconds))} sec`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `~${minutes} min`;
    return `~${Math.round(minutes / 6) / 10} hr`;
}
