import { spawn, type ChildProcess } from "node:child_process";

import {
    packedAnnexRoot,
    RELEASE_ANNEX_NAME,
    releaseBinaryPath,
    thisProcessReleaseRoot,
} from "../release/layout.ts";
import {
    DEFAULT_ANNEX_PORT,
    readSavedAnnexPort,
    saveAnnexPort,
} from "./annex-port.ts";

const LISTEN_DEADLINE_MS = 10_000;
const STOP_GRACE_MS = 2_000;

export interface AnnexProcess {
    readonly url: string;
    readonly pid: number;
    readonly port: number;
    /** The saved port this home moved off because it was taken. */
    readonly movedFromPort: number | undefined;
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
    readonly onExit?: (reason: string) => void;
}

export async function startAnnexProcess(
    options: StartAnnexProcessOptions,
): Promise<AnnexProcess> {
    const executable = options.command ?? [
        releaseBinaryPath(RELEASE_ANNEX_NAME),
    ];
    const [bin, ...prefix] = executable;
    const savedPort = readSavedAnnexPort(options.home);
    const args = [
        ...prefix,
        "--home",
        options.home,
        "--port",
        String(savedPort ?? DEFAULT_ANNEX_PORT),
        "--any-port-if-busy",
        "--assets",
        options.assets ?? packedAnnexRoot(thisProcessReleaseRoot()),
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
    if (port !== savedPort) {
        try {
            saveAnnexPort(options.home, port);
        } catch {
            // Unsaved, the next start tries the old port again.
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
        movedFromPort: savedPort !== undefined && savedPort !== port
            ? savedPort
            : undefined,
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
