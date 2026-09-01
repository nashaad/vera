import { unlinkSync } from "node:fs";
import { readdir, unlink } from "node:fs/promises";
import { basename, join } from "node:path";

export function tmuxSocketDirectory(): string {
    const uid = process.getuid?.();
    const root = process.env.TMUX_TMPDIR?.trim() || "/tmp";
    return join(root, `tmux-${uid ?? 0}`);
}

export function tmuxSocketPath(name: string): string {
    return join(tmuxSocketDirectory(), name);
}

export function unlinkTmuxSocketFile(name: string): void {
    if (name === PROTECTED_TMUX_SOCKET_NAME || name.length === 0) return;
    try {
        unlinkSync(tmuxSocketPath(name));
    } catch (error) {
        if (!isMissingFileError(error)) throw error;
    }
}

export const PROTECTED_TMUX_SOCKET_NAME = "default";

const VERA_UAT_SOCKET_NAMES: ReadonlySet<string> = new Set([
    "apprcolor",
    "drive120",
    "drive2",
    "drive3",
    "drive4",
    "drive5",
    "drive6",
    "drive70",
    "esc-rewind-uat",
    "evictuat",
    "evictuat2",
    "hudux",
    "kdig",
    "leak",
    "memtest",
    "memtest2",
    "otps",
    "spike",
    "uat",
    "veradash",
    "veranoext",
    "verify",
    "vkill",
    "vuat",
]);

export interface DiagnosedTmuxSocket {
    readonly name: string;
    readonly live: boolean;
    readonly veraOwned: boolean;
    readonly stray: boolean;
}

export interface TmuxSocketReport {
    readonly healthy: boolean;
    readonly directory: string;
    readonly sockets: readonly DiagnosedTmuxSocket[];
}

export interface TmuxSocketSweepResult {
    readonly killedServers: number;
    readonly unlinkedFiles: number;
}

export interface TmuxSocketDoctorOptions {
    readonly directory?: string;
    readonly listNames?: () => Promise<readonly string[]>;
    readonly sampleLiveNames?: () => Promise<ReadonlySet<string>>;
    readonly killServer?: (name: string) => Promise<void> | void;
    readonly unlinkSocket?: (path: string) => Promise<void> | void;
}

export function veraOwnsTmuxSocketName(name: string): boolean {
    return name.startsWith("vera-") || VERA_UAT_SOCKET_NAMES.has(name);
}

export function liveTmuxSocketName(command: string): string | undefined {
    const trimmed = command.trim();
    if (!/^(?:\S*\/)?tmux(?:\s|$)/.test(trimmed)) return undefined;
    const named = trimmed.match(/(?:^|\s)-L\s+(\S+)/);
    if (named?.[1] !== undefined) return named[1];
    const socketPath = trimmed.match(/(?:^|\s)-S\s+(\S+)/);
    if (socketPath?.[1] !== undefined) return basename(socketPath[1]);
    return PROTECTED_TMUX_SOCKET_NAME;
}

export function parseLiveTmuxSocketNames(source: string): Set<string> {
    const names = new Set<string>();
    for (const line of source.split("\n")) {
        const match = line.match(/^\s*\d+\s+(.*)$/);
        const command = match?.[1] ?? line;
        const name = liveTmuxSocketName(command);
        if (name !== undefined) names.add(name);
    }
    return names;
}

export function classifyTmuxSocket(
    name: string,
    liveNames: ReadonlySet<string>,
): DiagnosedTmuxSocket {
    const live = liveNames.has(name);
    const veraOwned = veraOwnsTmuxSocketName(name);
    const stray = name !== PROTECTED_TMUX_SOCKET_NAME && veraOwned && !live;
    return { name, live, veraOwned, stray };
}

export async function diagnoseTmuxSockets(
    options: TmuxSocketDoctorOptions = {},
): Promise<TmuxSocketReport> {
    const directory = options.directory ?? tmuxSocketDirectory();
    const names = await (options.listNames ?? listSocketNames)(directory);
    const liveNames = await (options.sampleLiveNames ?? sampleLiveTmuxSocketNames)();
    const sockets = names
        .map((name) => classifyTmuxSocket(name, liveNames))
        .sort((left, right) => left.name.localeCompare(right.name));
    return {
        healthy: !sockets.some((socket) => socket.stray),
        directory,
        sockets,
    };
}

export function renderTmuxSocketDoctor(report: TmuxSocketReport): string {
    const strays = report.sockets.filter((socket) => socket.stray);
    const live = report.sockets.filter((socket) => socket.live);
    const liveLeftovers = strays.filter((socket) => socket.live);
    const lines = [
        "Tmux sockets",
        `  Directory: ${report.directory}`,
        `  Files: ${report.sockets.length} (${live.length} live server${live.length === 1 ? "" : "s"}, ${strays.length} leftover Vera socket${strays.length === 1 ? "" : "s"})`,
    ];
    if (liveLeftovers.length > 0) {
        lines.push(
            `  Leftover live Vera servers: ${
                liveLeftovers.map((socket) => socket.name).join(", ")
            }`,
        );
    }
    lines.push(
        strays.length > 0
            ? `${strays.length} leftover tmux socket${strays.length === 1 ? "" : "s"} can be removed.`
            : "No leftover tmux sockets found.",
    );
    return `${lines.join("\n")}\n`;
}

export async function sweepStaleTmuxSockets(
    reportOrOptions: TmuxSocketReport | TmuxSocketDoctorOptions = {},
): Promise<TmuxSocketSweepResult> {
    const report = isTmuxSocketReport(reportOrOptions)
        ? reportOrOptions
        : await diagnoseTmuxSockets(reportOrOptions);
    const options = isTmuxSocketReport(reportOrOptions) ? {} : reportOrOptions;
    const killServer = options.killServer ?? killTmuxServerByName;
    const unlinkSocket = options.unlinkSocket ?? unlinkPath;
    let killedServers = 0;
    let unlinkedFiles = 0;
    for (const socket of report.sockets) {
        if (!socket.stray) continue;
        if (socket.live) {
            await killServer(socket.name);
            killedServers += 1;
        }
        try {
            await unlinkSocket(join(report.directory, socket.name));
            unlinkedFiles += 1;
        } catch (error) {
            if (!isMissingFileError(error)) throw error;
        }
    }
    return { killedServers, unlinkedFiles };
}

function isTmuxSocketReport(
    value: TmuxSocketReport | TmuxSocketDoctorOptions,
): value is TmuxSocketReport {
    return "sockets" in value && "healthy" in value && "directory" in value;
}

async function listSocketNames(directory: string): Promise<readonly string[]> {
    try {
        return await readdir(directory);
    } catch (error) {
        if (isMissingFileError(error)) return [];
        throw error;
    }
}

async function sampleLiveTmuxSocketNames(): Promise<Set<string>> {
    const child = Bun.spawn(["ps", "-axo", "pid=,command="], {
        stdout: "pipe",
        stderr: "pipe",
    });
    const [exitCode, output] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
    ]);
    if (exitCode !== 0) return new Set();
    return parseLiveTmuxSocketNames(output);
}

function killTmuxServerByName(name: string): void {
    Bun.spawnSync(["tmux", "-L", name, "kill-server"], {
        stdout: "ignore",
        stderr: "ignore",
    });
}

async function unlinkPath(path: string): Promise<void> {
    await unlink(path);
}

function isMissingFileError(error: unknown): boolean {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
}
