import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
    childReleaseRoot,
    packedAnnexRoot,
    RELEASE_ANNEX_NAME,
    checkoutPackRoot,
    sourceCheckoutRoot,
    releaseBinaryPath,
} from "../release/layout.ts";
import { defaultVeraHomeDirectory } from "../profile-paths.ts";
import { saveAnnexPort, wantedAnnexPort } from "./annex-port.ts";

const LISTEN_DEADLINE_MS = 10_000;
const STOP_GRACE_MS = 2_000;

export interface AnnexProcess {
    readonly url: string;
    readonly pid: number;
    readonly port: number;
    /** The port this home wanted, when something else held it for this run. */
    readonly busyPort: number | undefined;
    close(): Promise<void>;
}

export interface StartAnnexProcessOptions {
    readonly home: string;
    readonly assets?: string;
    /** Extension directories that contribute annex pages. */
    readonly extensionDirectories?: readonly string[];
    /** Page servers call their extension's host handlers through it. */
    readonly hostSocketPath?: string;
    readonly command?: readonly string[];
    /** The home that may use the default port. Defaults to the one used without VERA_HOME. */
    readonly defaultHome?: string;
    readonly onExit?: (reason: string) => void;
}

export interface AnnexLaunchOptions {
    readonly root: string | undefined;
    readonly checkoutRoot?: string;
    readonly command?: readonly string[];
    readonly assets?: string;
}

export interface AnnexLaunch {
    readonly command: readonly string[];
    readonly assets: string;
}

export function residentAnnexEntrypoint(): string {
    return fileURLToPath(new URL("../annex/main.ts", import.meta.url));
}

// An undefined root runs the checkout's annex, which serves the page `bun run pack:web` builds.
export function annexLaunch(options: AnnexLaunchOptions): AnnexLaunch {
    if (options.root !== undefined) {
        return {
            command: options.command
                ?? [releaseBinaryPath(RELEASE_ANNEX_NAME, options.root)],
            assets: options.assets ?? packedAnnexRoot(options.root),
        };
    }
    const checkoutRoot = options.checkoutRoot ?? sourceCheckoutRoot();
    const checkoutAssets = join(checkoutPackRoot(checkoutRoot), "annex");
    if (
        options.assets === undefined
        && !existsSync(join(checkoutAssets, "index.html"))
    ) {
        throw new Error(
            "This checkout has no built annex page. Run `bun run pack:web` in "
                + checkoutRoot
                + ".",
        );
    }
    return {
        command: options.command ?? [process.execPath, residentAnnexEntrypoint()],
        assets: options.assets ?? checkoutAssets,
    };
}

export async function startAnnexProcess(
    options: StartAnnexProcessOptions,
): Promise<AnnexProcess> {
    const launch = annexLaunch({
        root: childReleaseRoot(),
        command: options.command,
        assets: options.assets,
    });
    const executable = launch.command;
    const [bin, ...prefix] = executable;
    const wanted = wantedAnnexPort(
        options.home,
        options.defaultHome ?? defaultVeraHomeDirectory(),
    );
    const args = [
        ...prefix,
        "--home",
        options.home,
        "--port",
        String(wanted.port ?? 0),
        "--any-port-if-busy",
        "--assets",
        launch.assets,
        ...(options.extensionDirectories ?? []).flatMap((directory) => [
            "--extension",
            directory,
        ]),
        ...(options.hostSocketPath === undefined
            ? []
            : ["--host-socket", options.hostSocketPath]),
    ];
    const child: ChildProcess = spawn(bin as string, args, {
        argv0: "vera-annex",
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env },
    });
    const pid = child.pid;
    if (pid === undefined || child.stdout === null || child.stderr === null) {
        throw new Error("The annex process did not start");
    }

    const url = await waitForAnnexUrl(child);
    const port = Number(new URL(url).port);
    const busyPort = wanted.port !== undefined && wanted.port !== port
        ? wanted.port
        : undefined;
    // A stand-in port is never saved, so the next start asks for the wanted one again.
    if (!wanted.saved && busyPort === undefined) {
        try {
            saveAnnexPort(options.home, port);
        } catch {
            // Unsaved, the next start chooses again.
        }
    }
    let closing = false;
    child.once("exit", (code, signal) => {
        if (closing) return;
        const reason = signal !== null
            ? `The annex exited on ${signal}.`
            : `The annex exited with code ${code ?? "unknown"}.`;
        options.onExit?.(reason);
    });

    return {
        url,
        pid,
        port,
        busyPort,
        async close() {
            closing = true;
            await stopAnnexChild(child);
        },
    };
}

function waitForAnnexUrl(child: ChildProcess): Promise<string> {
    return new Promise((resolve, reject) => {
        let stdout = "";
        let stderr = "";
        let settled = false;
        const finish = (error: Error | undefined, url?: string): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (error !== undefined) {
                reject(error);
                return;
            }
            resolve(url as string);
        };
        const timer = setTimeout(() => {
            child.kill("SIGKILL");
            const detail = stderr.trim();
            finish(new Error(
                detail.length > 0
                    ? `Annex did not listen in time: ${detail}`
                    : "Annex did not listen in time",
            ));
        }, LISTEN_DEADLINE_MS);

        child.stdout?.setEncoding("utf8");
        child.stdout?.on("data", (chunk: string) => {
            stdout += chunk;
            const line = stdout.split("\n")[0]?.trim() ?? "";
            if (line.startsWith("http://127.0.0.1:")) {
                finish(
                    undefined,
                    line.endsWith("/") ? line : `${line}/`,
                );
            }
        });
        child.stderr?.setEncoding("utf8");
        child.stderr?.on("data", (chunk: string) => {
            stderr += chunk;
        });
        child.once("error", (error) => {
            finish(new Error(`Annex failed to start: ${error.message}`));
        });
        child.once("exit", (code, signal) => {
            const detail = stderr.trim();
            const status = signal !== null ? signal : `exit ${code ?? "unknown"}`;
            finish(new Error(
                detail.length > 0
                    ? `Annex exited before listening (${status}): ${detail}`
                    : `Annex exited before listening (${status})`,
            ));
        });
    });
}

async function stopAnnexChild(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) {
        return;
    }
    const exited = new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
    });
    child.kill("SIGTERM");
    const timedOut = await Promise.race([
        exited.then(() => false),
        new Promise<boolean>((resolve) => {
            setTimeout(() => resolve(true), STOP_GRACE_MS);
        }),
    ]);
    if (timedOut && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await exited;
    }
}
