import {
    mkdirSync,
    readFileSync,
    renameSync,
    statSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import {
    defaultVeraHomeDirectory,
    selectedVeraHome,
    VERA_HOME_ENV,
    veraRuntimeDirectoryIn,
} from "../profile-paths.ts";

// A Unix socket path must fit in sun_path: 104 bytes on macOS, 108 elsewhere, terminator included.
export const UNIX_SOCKET_PATH_LIMIT = process.platform === "darwin" ? 104 : 108;
const SOCKET_FILE = "host.sock";
const FAILURE_FILE = "host-startup-failure.json";
const FALLBACK_HOME = "/tmp/vera";

// The longest home whose socket fits: the socket limit less the `/runtime/host.sock` tail.
export function homeSocketPathLimit(): number {
    return UNIX_SOCKET_PATH_LIMIT - 1 - Buffer.byteLength(hostSocketPath("/"));
}

export function socketPlatformName(platform: NodeJS.Platform = process.platform): string {
    if (platform === "darwin") return "macOS";
    if (platform === "linux") return "Linux";
    return "this system";
}

export class HostSocketPathTooLongError extends Error {
    readonly homeLength: number;
    readonly homeLimit: number;
    readonly platform: string;

    constructor(
        readonly socketPath: string,
        readonly home: string,
        readonly suggestedHome: string,
    ) {
        const homeLimit = homeSocketPathLimit();
        const homeLength = Buffer.byteLength(home);
        const platform = socketPlatformName();
        super(
            `Vera's home path is too long.\n`
                + `Home: ${home}\n`
                + `On ${platform} a Vera home path can be at most ${homeLimit} characters, and this one is ${homeLength}.\n`
                + `Start Vera with a shorter home, for example: ${VERA_HOME_ENV}=${suggestedHome} vera\n`
                + `Nothing in this home was moved or deleted.`,
        );
        this.name = "HostSocketPathTooLongError";
        this.homeLength = homeLength;
        this.homeLimit = homeLimit;
        this.platform = platform;
    }
}

export class HostHomeUnusableError extends Error {
    constructor(readonly home: string, readonly reason: string, readonly suggestedHome: string) {
        super(
            `Vera cannot start: ${home} ${reason}.\n`
                + `Fix that, or start Vera from another home, for example: ${VERA_HOME_ENV}=${suggestedHome} vera`,
        );
        this.name = "HostHomeUnusableError";
    }
}

// `VERA_HOME=<home> ` when a home is selected through the environment, so a printed command acts on the same home.
export function homeCommandPrefix(): string {
    const home = process.env[VERA_HOME_ENV]?.trim();
    if (home === undefined || home.length === 0) return "";
    const word = /^[\w@%+=:,./-]+$/.test(home) ? home : `'${home.replace(/'/g, "'\\''")}'`;
    return `${VERA_HOME_ENV}=${word} `;
}

export function hostSocketPath(home: string): string {
    return join(veraRuntimeDirectoryIn(home), SOCKET_FILE);
}

function socketFits(home: string): boolean {
    return Buffer.byteLength(hostSocketPath(home)) < UNIX_SOCKET_PATH_LIMIT;
}

// The default home when it fits and is not the home in trouble; a short folder under /tmp otherwise.
function suggestedHome(home: string): string {
    const usual = defaultVeraHomeDirectory();
    return usual !== home && socketFits(usual) ? usual : FALLBACK_HOME;
}

export function hostSocketPathProblem(
    home: string = selectedVeraHome(),
): HostSocketPathTooLongError | undefined {
    const socketPath = hostSocketPath(home);
    const length = Buffer.byteLength(socketPath);
    if (length < UNIX_SOCKET_PATH_LIMIT) return undefined;
    return new HostSocketPathTooLongError(socketPath, home, suggestedHome(home));
}

// A home or runtime folder that is really a file stops every start with a bare ENOTDIR.
export function hostHomeProblem(
    home: string = selectedVeraHome(),
): HostHomeUnusableError | undefined {
    for (const folder of [home, veraRuntimeDirectoryIn(home)]) {
        const reason = folderProblem(folder);
        if (reason !== undefined) {
            return new HostHomeUnusableError(folder, reason, suggestedHome(home));
        }
    }
    return undefined;
}

function folderProblem(folder: string): string | undefined {
    let stats;
    try {
        stats = statSync(folder);
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return undefined;
        if (code === "ENOTDIR") return "is inside a path where a folder is really a file";
        if (code === "EACCES") return "cannot be read by this user (permission denied)";
        return undefined;
    }
    if (!stats.isDirectory()) return "is a file, and Vera needs a folder there";
    return undefined;
}

export interface HostStartupFailure {
    readonly at: number;
    readonly pid: number;
    readonly message: string;
}

function failurePath(home: string = selectedVeraHome()): string {
    return join(veraRuntimeDirectoryIn(home), FAILURE_FILE);
}

// The host is spawned with its output discarded, so the cause it dies of is left here for the launcher to read.
export function recordHostStartupFailure(message: string, now: number = Date.now()): void {
    try {
        const path = failurePath();
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        const temporary = `${path}.${process.pid}.tmp`;
        const record: HostStartupFailure = { at: now, pid: process.pid, message };
        writeFileSync(temporary, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
        renameSync(temporary, path);
    } catch {
        // A home that cannot be written is already reported by the launcher's own checks.
    }
}

export function readHostStartupFailure(sinceMs: number): HostStartupFailure | undefined {
    try {
        const record = JSON.parse(readFileSync(failurePath(), "utf8")) as Partial<HostStartupFailure>;
        if (
            typeof record.at !== "number"
            || typeof record.pid !== "number"
            || typeof record.message !== "string"
            || record.at < sinceMs
        ) {
            return undefined;
        }
        return { at: record.at, pid: record.pid, message: record.message };
    } catch {
        return undefined;
    }
}

export function clearHostStartupFailure(): void {
    try {
        unlinkSync(failurePath());
    } catch {
        // Nothing to clear.
    }
}
