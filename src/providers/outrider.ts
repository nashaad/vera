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
export function outriderStatusCommand(
    binary: string = OUTRIDER_BINARY,
): readonly string[] {
    return [binary, "--json", "ps"];
}

/** One command fetches the runtime, fetches the weights, and brings the gateway up on that profile. There is no separate install or pull. */
export function outriderServeCommand(
    profile: string,
    binary: string = OUTRIDER_BINARY,
): readonly string[] {
    return [binary, "--json", "serve", profile];
}

/** Does this profile fit this machine, in Outrider's own reckoning rather than ours. */
export function outriderCheckCommand(
    profile: string,
    binary: string = OUTRIDER_BINARY,
): readonly string[] {
    return [binary, "--json", "check", profile];
}

/** The profiles this binary will serve. Development profiles are hidden unless `OUTRIDER_DEV` is set, so a default catalog is short on purpose. */
export function outriderListCommand(
    binary: string = OUTRIDER_BINARY,
): readonly string[] {
    return [binary, "ls", "--json"];
}

export const OUTRIDER_INSTALL_URL_DEFAULT = "https://get.corvines.com/outrider";

/** Where the installer is fetched from. `OUTRIDER_INSTALL_URL` points it at a local server, which is what makes the install path drivable before anything is published. */
export function outriderInstallUrl(): string {
    const override = process.env.OUTRIDER_INSTALL_URL;
    return override === undefined || override === ""
        ? OUTRIDER_INSTALL_URL_DEFAULT
        : override;
}

/** Fetch first, then run, because a pipeline reports the exit status of its last command: `curl | sh` answers for the `sh`, which succeeds on empty input, so a download that never arrived reads as an install that worked. */
const INSTALL_SCRIPT =
    'set -e; f=$(mktemp); trap \'rm -f "$f"\' EXIT; curl -fsSL "$1" > "$f"; sh "$f"';

/** The binary cannot place itself, so the one thing Vera does not get from the CLI is the CLI. The URL arrives as an argument rather than spliced into the script, so a value read from the environment stays a URL and cannot become a second command. */
export function outriderInstallCommand(): readonly string[] {
    return ["sh", "-c", INSTALL_SCRIPT, "sh", outriderInstallUrl()];
}

/** The key the installer writes its target path under, on stdout, ahead of anything a person reads. */
const INSTALL_PATH_PREFIX = "outrider-install-path=";

/** Where the installer says it put the binary. The install directory is not always on PATH, and an install does not change the PATH of the process that started it, so a lookup right after one finds nothing. Absent on an older installer, which leaves the caller its lookup. */
export function readInstallPath(stdout: string): string | undefined {
    for (const line of stdout.split("\n")) {
        const text = line.trim();
        if (!text.startsWith(INSTALL_PATH_PREFIX)) continue;
        const path = text.slice(INSTALL_PATH_PREFIX.length).trim();
        if (path !== "") return path;
    }
    return undefined;
}

/** Outrider records where it put itself, under the home for a per-user install and under `/usr/local` for a packaged one. */
const USER_MARKER_RELATIVE = ".local/share/outrider/install.json";
const SYSTEM_MARKER = "/usr/local/share/outrider/install.json";

/** Both marker files, per-user first, in the order a caller should try them. */
export function outriderMarkerPaths(home: string): readonly string[] {
    return home === ""
        ? [SYSTEM_MARKER]
        : [`${home}/${USER_MARKER_RELATIVE}`, SYSTEM_MARKER];
}

/** The binary a marker file points at. Mirrors `Marker` in `internal/installer/installer.go`. */
export function readInstallMarker(text: string): string | undefined {
    let payload: { target?: unknown };
    try {
        payload = JSON.parse(text) as { target?: unknown };
    } catch {
        return undefined;
    }
    const target = payload.target;
    return typeof target === "string" && target !== "" ? target : undefined;
}

/** The profile ids `ls` reported, in the order it reported them. Vera takes the roster from Outrider and keeps its own words for the ids it has words for. */
export function readOutriderProfiles(stdout: string): readonly string[] {
    let payload: { profiles?: unknown };
    try {
        payload = JSON.parse(stdout) as { profiles?: unknown };
    } catch {
        return [];
    }
    if (!Array.isArray(payload.profiles)) return [];
    return payload.profiles.flatMap((entry): string[] => {
        if (typeof entry !== "object" || entry === null) return [];
        const id = (entry as Record<string, unknown>).id;
        return typeof id === "string" && id !== "" ? [id] : [];
    });
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

/**
 * One process as Outrider reports it. Mirrors `Status` in
 * `internal/process/process.go`. `healthy` is absent when the gateway never
 * answered, which is not the same as answering unhealthy.
 */
export interface OutriderProcess {
    readonly kind: string;
    readonly endpoint?: string;
    readonly profile?: string;
    readonly healthy?: boolean;
    readonly pid?: number;
    readonly detail?: string;
    readonly logFile?: string;
    readonly startedAt?: string;
    readonly residentBytes?: number;
    readonly timeToHealthMs?: number;
}

/** The gateway and the model it is serving. `status` reports both; they move independently, so a gateway can be up with no model loaded. */
export interface OutriderService {
    readonly gateway: OutriderProcess;
    readonly model: OutriderProcess;
}

/** The weights for one profile, as they sit on this machine. */
export interface OutriderCache {
    readonly state: string;
    readonly path?: string;
    readonly sizeBytes?: number;
}

/**
 * What `show` said about one profile: the tested recipe, plus whether its
 * weights are here. `show` prints `manifest.Profile` itself, so the field
 * names are the manifest's, not the shorter ones `ls` and `plan` project.
 */
export interface OutriderProfileDetail {
    readonly id: string;
    readonly description?: string;
    /** The window the profile runs at, which is not the window it was trained for. */
    readonly context?: number;
    readonly trainingContext?: number;
    readonly quant?: string;
    readonly repository?: string;
    readonly file?: string;
    readonly sizeBytes?: number;
    readonly kvKeyType?: string;
    readonly kvValueType?: string;
    /** The memory the profile was qualified on, in MiB. Absent means it was never pinned to a machine size. */
    readonly validatedMemoryMiB?: number;
    readonly cache: OutriderCache;
}

export interface OutriderLog {
    readonly logFile?: string;
    readonly lines: readonly string[];
}

/** Both processes, richer than `ps` and without starting anything. */
export function outriderServiceCommand(
    binary: string = OUTRIDER_BINARY,
): readonly string[] {
    return [binary, "--json", "status"];
}

/** One profile in full, including whether its weights are already on disk. */
export function outriderShowCommand(
    profile: string,
    binary: string = OUTRIDER_BINARY,
): readonly string[] {
    return [binary, "--json", "show", profile];
}

/** Point the running gateway at another profile. Unlike `serve` this does not bring a gateway up. */
export function outriderUseCommand(
    profile: string,
    binary: string = OUTRIDER_BINARY,
): readonly string[] {
    return [binary, "--json", "use", profile];
}

/** The tail of whichever log the active process is writing. Outrider refuses a count outside its own range rather than clamping, so clamp here. */
export function outriderLogsCommand(
    lines: number,
    binary: string = OUTRIDER_BINARY,
): readonly string[] {
    const count = Math.min(10_000, Math.max(1, Math.trunc(lines)));
    return [binary, "--json", "logs", "--lines", String(count)];
}

function record(value: unknown): Record<string, unknown> {
    return typeof value === "object" && value !== null
        ? value as Record<string, unknown>
        : {};
}

function flag(value: unknown): boolean | undefined {
    return typeof value === "boolean" ? value : undefined;
}

function parseJson(stdout: string): Record<string, unknown> {
    try {
        return record(JSON.parse(stdout));
    } catch {
        return {};
    }
}

/** One process out of whatever payload carries it. An absent `kind` reads as stopped, which is what a caller does with a process it cannot see. */
function readProcess(value: unknown): OutriderProcess {
    const payload = record(value);
    const timings = record(payload.timings);
    const kind = text(payload.kind) ?? "stopped";
    const endpoint = text(payload.endpoint);
    const profile = text(payload.preset);
    const detail = text(payload.detail);
    const logFile = text(payload.logFile);
    const startedAt = text(payload.startedAt);
    const healthy = flag(payload.health);
    const pid = count(payload.pid);
    const residentBytes = count(payload.residentBytes);
    const timeToHealthMs = count(timings.timeToHealthMs);
    return {
        kind,
        ...(endpoint === undefined ? {} : { endpoint }),
        ...(profile === undefined ? {} : { profile }),
        ...(healthy === undefined ? {} : { healthy }),
        ...(pid === undefined ? {} : { pid }),
        ...(detail === undefined ? {} : { detail }),
        ...(logFile === undefined ? {} : { logFile }),
        ...(startedAt === undefined ? {} : { startedAt }),
        ...(residentBytes === undefined ? {} : { residentBytes }),
        ...(timeToHealthMs === undefined ? {} : { timeToHealthMs }),
    };
}

export function readOutriderService(stdout: string): OutriderService {
    const payload = parseJson(stdout);
    return {
        gateway: readProcess(payload.gateway),
        model: readProcess(payload.model),
    };
}

/** Where `use` left the gateway. The model status is the one that says whether the swap actually took. */
export function readOutriderUse(stdout: string): OutriderProcess {
    const payload = parseJson(stdout);
    return readProcess(payload.model);
}

function readCache(value: unknown): OutriderCache {
    const payload = record(value);
    const path = text(payload.path);
    const sizeBytes = count(payload.sizeBytes);
    return {
        state: text(payload.state) ?? "missing",
        ...(path === undefined ? {} : { path }),
        ...(sizeBytes === undefined ? {} : { sizeBytes }),
    };
}

export function readOutriderProfileDetail(
    stdout: string,
): OutriderProfileDetail | undefined {
    const payload = parseJson(stdout);
    const profile = record(payload.profile);
    const id = text(profile.id);
    if (id === undefined) return undefined;
    const model = record(profile.model);
    const context = record(profile.context);
    const kv = record(profile.kvCache);
    const admission = record(profile.admission);
    const description = text(profile.description);
    const size = count(context.size);
    const original = count(context.original);
    const quant = text(model.quant);
    const repository = text(model.repo);
    const file = text(model.file);
    const sizeBytes = count(model.sizeBytes);
    const kvKeyType = text(kv.keyType);
    const kvValueType = text(kv.valueType);
    const validatedMemoryMiB = count(admission.validatedPhysicalMemoryMiB);
    return {
        id,
        ...(description === undefined ? {} : { description }),
        ...(size === undefined ? {} : { context: size }),
        ...(original === undefined ? {} : { trainingContext: original }),
        ...(quant === undefined ? {} : { quant }),
        ...(repository === undefined ? {} : { repository }),
        ...(file === undefined ? {} : { file }),
        ...(sizeBytes === undefined ? {} : { sizeBytes }),
        ...(kvKeyType === undefined ? {} : { kvKeyType }),
        ...(kvValueType === undefined ? {} : { kvValueType }),
        ...(validatedMemoryMiB === undefined ? {} : { validatedMemoryMiB }),
        cache: readCache(payload.cache),
    };
}

export function readOutriderLog(stdout: string): OutriderLog {
    const payload = parseJson(stdout);
    const logFile = text(payload.logFile);
    const lines = Array.isArray(payload.lines)
        ? payload.lines.filter((line): line is string => typeof line === "string")
        : [];
    return { ...(logFile === undefined ? {} : { logFile }), lines };
}
