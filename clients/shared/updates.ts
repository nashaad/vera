import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { startingConfigFile } from "../../src/config-starting.ts";

export type UpdateMode = "ask" | "automatic" | "off";

export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

const UPDATE_MODES: readonly UpdateMode[] = ["ask", "automatic", "off"];
const CHECK_TIMEOUT_MS = 90_000;

export interface UpdateCheck {
    readonly status: "up_to_date" | "available" | "downloaded" | "held" | "unavailable";
    readonly currentVersion: string;
    readonly currentBuild: string;
    readonly latestVersion?: string;
    readonly message?: string;
}

export interface UpdateCheckingProgress { readonly phase: "checking" }
export interface UpdateDownloadingProgress {
    readonly phase: "downloading";
    readonly bytes: number;
    readonly total?: number;
}
export interface UpdateWaitSession { readonly id: string; readonly title: string }
export interface UpdateWaitingProgress {
    readonly phase: "waiting";
    readonly sessions: readonly UpdateWaitSession[];
    readonly waitedMs: number;
    readonly limitMs: number;
}
export interface UpdateSwitchingProgress { readonly phase: "switching" }
export type UpdateProgress =
    | UpdateCheckingProgress
    | UpdateDownloadingProgress
    | UpdateWaitingProgress
    | UpdateSwitchingProgress;

export interface UpdateOutcome {
    readonly result: "done" | "up_to_date" | "held" | "downloaded" | "failed" | "cancelled";
    readonly version?: string;
    readonly build?: string;
    readonly message?: string;
    readonly changed: boolean;
}

export interface UpdateRun {
    // False once switching has started: the switch runs to the end.
    cancel(): boolean;
    readonly done: Promise<UpdateOutcome>;
}

export interface UpdateCommandOptions {
    readonly veraCommand: string;
    readonly env?: Record<string, string | undefined>;
}

export interface UpdateRunOptions extends UpdateCommandOptions {
    readonly downloadOnly?: boolean;
}

export function readUpdateMode(home: string): UpdateMode {
    try {
        const parsed: unknown = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
        const updates = isRecord(parsed) ? parsed.updates : undefined;
        const mode = isRecord(updates) ? updates.mode : undefined;
        return UPDATE_MODES.find((candidate) => candidate === mode) ?? "ask";
    } catch {
        return "ask";
    }
}

// Rewrites config.json whole with every other key kept. A home with no config starts from the engine's starting values.
export function writeUpdateMode(home: string, mode: UpdateMode): void {
    const path = join(home, "config.json");
    let parsed: unknown;
    try {
        if (existsSync(path)) {
            parsed = JSON.parse(readFileSync(path, "utf8"));
        } else {
            parsed = startingConfigFile();
        }
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`Vera config at ${path} could not be read, so the update setting was not saved: ${reason}`);
    }
    if (!isRecord(parsed)) {
        throw new Error(`Vera config at ${path} is not a JSON object, so the update setting was not saved.`);
    }
    const updates = isRecord(parsed.updates) ? parsed.updates : {};
    const written = { ...parsed, updates: { ...updates, mode } };
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = join(dirname(path), `.config-${randomUUID()}.tmp`);
    writeFileSync(temporary, `${JSON.stringify(written, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
}

export function shouldCheckNow(lastCheckedAt: number | undefined, now: number): boolean {
    if (lastCheckedAt === undefined) return true;
    return now < lastCheckedAt || now - lastCheckedAt >= UPDATE_CHECK_INTERVAL_MS;
}

// Never rejects: a check that cannot run answers "unavailable" with the reason.
export async function checkForUpdate(options: UpdateCommandOptions): Promise<UpdateCheck> {
    const unavailable = (message: string): UpdateCheck => ({
        status: "unavailable",
        currentVersion: "",
        currentBuild: "",
        message,
    });
    let captured: CapturedRun;
    try {
        captured = await captureRun(options, ["update", "--check", "--json"], CHECK_TIMEOUT_MS);
    } catch (error) {
        return unavailable(`Could not run ${options.veraCommand}: ${errorText(error)}`);
    }
    const first = captured.stdout.split("\n").find((line) => line.trim().length > 0);
    const record = first === undefined ? undefined : parseObject(first);
    const status = record?.status;
    if (
        record === undefined
        || (status !== "up_to_date" && status !== "available" && status !== "downloaded"
            && status !== "held" && status !== "unavailable")
    ) {
        return unavailable(captured.timedOut
            ? "The update check did not finish."
            : tail(captured.stderr) ?? "The update check gave no answer.");
    }
    return {
        status,
        currentVersion: text(record.current_version) ?? "",
        currentBuild: text(record.current_build) ?? "",
        ...(text(record.latest_version) === undefined ? {} : { latestVersion: text(record.latest_version)! }),
        ...(text(record.message) === undefined ? {} : { message: text(record.message)! }),
    };
}

export function runUpdate(options: UpdateRunOptions, onProgress: (progress: UpdateProgress) => void): UpdateRun {
    const args = ["update", "--json", ...(options.downloadOnly === true ? ["--download-only"] : [])];
    let switching = false;
    let outcome: UpdateOutcome | undefined;
    let stderr = "";
    let child: ReturnType<typeof spawn> | undefined;
    const done = new Promise<UpdateOutcome>((resolve) => {
        const failed = (message: string): UpdateOutcome => ({ result: "failed", message, changed: false });
        try {
            child = spawn(options.veraCommand, args, {
                env: { ...process.env, ...options.env },
                stdio: ["ignore", "pipe", "pipe"],
            });
        } catch (error) {
            resolve(failed(`Could not run ${options.veraCommand}: ${errorText(error)}`));
            return;
        }
        let pending = "";
        const handle = (line: string): void => {
            const record = parseObject(line);
            if (record === undefined) return;
            if (typeof record.result === "string") {
                outcome ??= outcomeOf(record);
                return;
            }
            const progress = progressOf(record);
            if (progress === undefined) return;
            if (progress.phase === "switching") switching = true;
            onProgress(progress);
        };
        child.stdout?.setEncoding("utf8");
        child.stdout?.on("data", (chunk: string) => {
            pending += chunk;
            for (let end = pending.indexOf("\n"); end >= 0; end = pending.indexOf("\n")) {
                handle(pending.slice(0, end));
                pending = pending.slice(end + 1);
            }
        });
        child.stderr?.setEncoding("utf8");
        child.stderr?.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-2_000); });
        child.on("error", (error) => resolve(outcome ?? failed(`Could not run ${options.veraCommand}: ${error.message}`)));
        child.on("close", () => {
            if (pending.trim().length > 0) handle(pending);
            resolve(outcome ?? failed(switching
                ? "The update stopped while switching. Run the update again to finish it."
                : tail(stderr) ?? "The update stopped without a result."));
        });
    });
    return {
        cancel(): boolean {
            if (switching || outcome !== undefined || child === undefined || child.exitCode !== null) return false;
            return child.kill("SIGTERM");
        },
        done,
    };
}

interface CapturedRun {
    readonly stdout: string;
    readonly stderr: string;
    readonly timedOut: boolean;
}

function captureRun(options: UpdateCommandOptions, args: readonly string[], timeoutMs: number): Promise<CapturedRun> {
    return new Promise((resolve, reject) => {
        const child = spawn(options.veraCommand, [...args], {
            env: { ...process.env, ...options.env },
            stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
        }, timeoutMs);
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => { stdout = (stdout + chunk).slice(-64_000); });
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-2_000); });
        child.on("error", (error) => {
            clearTimeout(timer);
            reject(error);
        });
        child.on("close", () => {
            clearTimeout(timer);
            resolve({ stdout, stderr, timedOut });
        });
    });
}

function progressOf(record: Record<string, unknown>): UpdateProgress | undefined {
    switch (record.phase) {
        case "checking":
            return { phase: "checking" };
        case "switching":
            return { phase: "switching" };
        case "downloading": {
            const bytes = count(record.bytes);
            if (bytes === undefined) return undefined;
            const total = count(record.total);
            return { phase: "downloading", bytes, ...(total === undefined ? {} : { total }) };
        }
        case "waiting": {
            const waitedMs = count(record.waited_ms);
            const limitMs = count(record.limit_ms);
            if (waitedMs === undefined || limitMs === undefined || !Array.isArray(record.sessions)) return undefined;
            const sessions: UpdateWaitSession[] = [];
            for (const item of record.sessions) {
                if (isRecord(item) && typeof item.id === "string") {
                    sessions.push({ id: item.id, title: typeof item.title === "string" ? item.title : item.id });
                }
            }
            return { phase: "waiting", sessions, waitedMs, limitMs };
        }
        default:
            return undefined;
    }
}

function outcomeOf(record: Record<string, unknown>): UpdateOutcome {
    const result = record.result;
    const known = result === "done" || result === "up_to_date" || result === "held"
        || result === "downloaded" || result === "failed" || result === "cancelled";
    return {
        result: known ? result : "failed",
        ...(text(record.version) === undefined ? {} : { version: text(record.version)! }),
        ...(text(record.build) === undefined ? {} : { build: text(record.build)! }),
        ...(known
            ? text(record.message) === undefined ? {} : { message: text(record.message)! }
            : { message: "The update reported a result this app does not know." }),
        changed: record.changed === true,
    };
}

function parseObject(line: string): Record<string, unknown> | undefined {
    try {
        const parsed: unknown = JSON.parse(line);
        return isRecord(parsed) ? parsed : undefined;
    } catch {
        return undefined;
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
    return typeof value === "string" && value.length > 0 ? value : undefined;
}

function count(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function tail(value: string): string | undefined {
    const trimmed = value.trim();
    return trimmed.length === 0 ? undefined : trimmed.split("\n").slice(-3).join(" ");
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
