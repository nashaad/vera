/** Driving the Outrider CLI: asking where it is, putting it on the machine, and bringing a profile up. Outrider is the only local runtime today, so this module is the one implementation a `local_runtime` definition names. */

import {
    mergeProgress,
    OUTRIDER_BINARY,
    outriderInstallCommand,
    outriderListCommand,
    outriderMarkerPaths,
    outriderServeCommand,
    outriderStatusCommand,
    parseOutriderProgress,
    readInstallMarker,
    readOutriderProfiles,
    readOutriderStatus,
    type OutriderPresence,
    type OutriderProgress,
} from "../../../src/providers/outrider.ts";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";

export interface RuntimeRun {
    readonly ok: boolean;
    readonly stdout: string;
    /** The last thing the command said that was not progress, which is what a failure is explained by. */
    readonly detail: string;
}

/** A command in flight, so the screen that started it can also stop it. */
export interface RuntimeCommand {
    readonly finished: Promise<RuntimeRun>;
    stop(): void;
}

/** Runs the command and hands every progress line to the caller as it arrives. Anything on that stream that is not a progress line is kept for the failure message. */
export function runOutrider(
    command: readonly string[],
    onProgress: (line: OutriderProgress) => void,
): RuntimeCommand {
    const child = Bun.spawn([...command], {
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
    });
    const said: string[] = [];
    const finished = (async (): Promise<RuntimeRun> => {
        const reading = (async () => {
            const decoder = new TextDecoder();
            let buffer = "";
            for await (const chunk of child.stderr) {
                buffer += decoder.decode(chunk, { stream: true });
                const lines = buffer.split("\n");
                buffer = lines.pop() ?? "";
                for (const line of lines) {
                    const progress = parseOutriderProgress(line);
                    if (progress !== undefined) onProgress(progress);
                    else if (line.trim() !== "") said.push(line.trim());
                }
            }
        })();
        const stdout = await new Response(child.stdout).text();
        await reading;
        const code = await child.exited;
        return { ok: code === 0, stdout, detail: said.at(-1) ?? "" };
    })();
    return { finished, stop: () => child.kill() };
}

/** The two things driving Outrider needs from the machine: where the binary is, and a way to run it. A caller that supplies its own answers can exercise the install and serve paths without one on the machine. */
export interface OutriderDriver {
    binary(): string | undefined;
    run(
        command: readonly string[],
        onProgress: (line: OutriderProgress) => void,
    ): RuntimeCommand;
}

/** The path the last install reported. */
let installedBinary: string | undefined;

/** Hold on to where an install put the binary. The directory it lands in need not be on PATH, and nothing an install does changes the PATH of the process that ran it. */
export function rememberOutriderBinary(path: string): void {
    installedBinary = path;
}

/** Where a past install put the binary, read back from the record Outrider keeps of its own installs. A new run of Vera has no memory of an install, and the directory the binary sits in need not be on PATH. */
function markedBinary(): string | undefined {
    for (const marker of outriderMarkerPaths(homedir())) {
        let text: string;
        try {
            text = readFileSync(marker, "utf8");
        } catch {
            continue;
        }
        const target = readInstallMarker(text);
        if (target !== undefined && existsSync(target)) return target;
    }
    return undefined;
}

/** What to run: the binary an install placed, else whatever the search path turns up, else the one an earlier install recorded. */
export function outriderBinary(): string | undefined {
    if (installedBinary !== undefined && existsSync(installedBinary)) {
        return installedBinary;
    }
    return Bun.which(OUTRIDER_BINARY) ?? markedBinary();
}

export const defaultOutriderDriver: OutriderDriver = {
    binary: outriderBinary,
    run: runOutrider,
};

/** Where Outrider is. No binary anywhere is the one state Vera can act on by installing. */
export async function outriderPresence(
    driver: OutriderDriver = defaultOutriderDriver,
): Promise<OutriderPresence> {
    const binary = driver.binary();
    if (binary === undefined) return { state: "absent" };
    const run = driver.run(outriderStatusCommand(binary), () => {});
    const result = await run.finished;
    return result.ok ? readOutriderStatus(result.stdout) : { state: "stopped" };
}

/** The profiles this machine's Outrider will serve, or nothing when there is no binary to ask. */
export async function outriderProfiles(
    driver: OutriderDriver = defaultOutriderDriver,
): Promise<readonly string[]> {
    const binary = driver.binary();
    if (binary === undefined) return [];
    const result = await driver.run(outriderListCommand(binary), () => {})
        .finished;
    return result.ok ? readOutriderProfiles(result.stdout) : [];
}

export function installOutrider(
    onProgress: (line: OutriderProgress) => void,
    driver: OutriderDriver = defaultOutriderDriver,
): RuntimeCommand {
    return driver.run(outriderInstallCommand(), onProgress);
}

/** One command fetches what is missing and brings the gateway up on that profile. */
export function serveOutrider(
    profile: string,
    onProgress: (line: OutriderProgress) => void,
    driver: OutriderDriver = defaultOutriderDriver,
): RuntimeCommand {
    return driver.run(
        outriderServeCommand(profile, driver.binary() ?? OUTRIDER_BINARY),
        onProgress,
    );
}

export { mergeProgress };
