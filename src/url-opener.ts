import { readFileSync } from "node:fs";

export interface UrlOpenerOptions {
    readonly platform?: NodeJS.Platform;
    readonly env?: Readonly<Record<string, string | undefined>>;
    /** Contents of /proc/version, for tests that cannot rely on the host. */
    readonly procVersion?: string;
    readonly hasCommand?: (command: string) => boolean;
}

export function isWsl(
    env: Readonly<Record<string, string | undefined>> = process.env,
    procVersion?: string,
): boolean {
    if (env.WSL_DISTRO_NAME !== undefined && env.WSL_DISTRO_NAME !== "") {
        return true;
    }
    if (env.WSL_INTEROP !== undefined && env.WSL_INTEROP !== "") {
        return true;
    }
    return procVersion?.toLowerCase().includes("microsoft") ?? false;
}

/**
 * The command that opens `url` in a browser on this platform.
 *
 * WSL has no visible desktop opener of its own: xdg-open exits successfully
 * without opening anything. Use wslview when it is installed and Windows
 * explorer otherwise.
 */
export function urlOpenerCommand(
    url: string,
    options: UrlOpenerOptions = {},
): readonly string[] {
    const platform = options.platform ?? process.platform;
    if (platform === "darwin") return ["open", url];
    if (platform === "win32") return ["explorer.exe", url];
    if (
        isWsl(
            options.env ?? process.env,
            options.procVersion ?? readProcVersion(),
        )
    ) {
        const hasCommand = options.hasCommand ?? commandExists;
        return hasCommand("wslview")
            ? ["wslview", url]
            : ["explorer.exe", url];
    }
    return ["xdg-open", url];
}

/** Opens `url`, resolving false when no opener could be started. */
export async function openUrl(
    url: string,
    options: UrlOpenerOptions = {},
): Promise<boolean> {
    try {
        const opener = Bun.spawn([...urlOpenerCommand(url, options)], {
            stdout: "ignore",
            stderr: "ignore",
        });
        return await opener.exited === 0;
    } catch {
        return false;
    }
}

/** Starts the opener without waiting, for callers that cannot block. */
export function spawnUrl(url: string, options: UrlOpenerOptions = {}): void {
    try {
        Bun.spawn([...urlOpenerCommand(url, options)], {
            detached: true,
            stdout: "ignore",
            stderr: "ignore",
        });
    } catch {
        // A missing platform opener must not interrupt the caller.
    }
}

function commandExists(command: string): boolean {
    return Bun.which(command) !== null;
}

function readProcVersion(): string | undefined {
    try {
        return readFileSync("/proc/version", "utf8");
    } catch {
        return undefined;
    }
}
