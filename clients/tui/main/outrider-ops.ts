/** Driving the Outrider CLI: asking where it is, putting it on the machine, and bringing a profile up. Outrider is the only local runtime today, so this module is the one implementation a `local_runtime` definition names. */

import {
    mergeProgress,
    OUTRIDER_BINARY,
    outriderInstallCommand,
    outriderListCommand,
    outriderServeCommand,
    outriderStatusCommand,
    parseOutriderProgress,
    readOutriderProfiles,
    readOutriderStatus,
    type OutriderPresence,
    type OutriderProgress,
} from "../../../src/providers/outrider.ts";
import { existsSync } from "node:fs";

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

/** The path the last install reported. */
let installedBinary: string | undefined;

/** Hold on to where an install put the binary. The directory it lands in need not be on PATH, and nothing an install does changes the PATH of the process that ran it. */
export function rememberOutriderBinary(path: string): void {
    installedBinary = path;
}

/** What to run: the binary an install placed, else whatever the search path turns up. */
export function outriderBinary(): string | undefined {
    if (installedBinary !== undefined && existsSync(installedBinary)) {
        return installedBinary;
    }
    return Bun.which(OUTRIDER_BINARY) ?? undefined;
}

/** Where Outrider is. No binary anywhere is the one state Vera can act on by installing. */
export async function outriderPresence(): Promise<OutriderPresence> {
    const binary = outriderBinary();
    if (binary === undefined) return { state: "absent" };
    const run = runOutrider(outriderStatusCommand(binary), () => {});
    const result = await run.finished;
    return result.ok ? readOutriderStatus(result.stdout) : { state: "stopped" };
}

/** The profiles this machine's Outrider will serve, or nothing when there is no binary to ask. */
export async function outriderProfiles(): Promise<readonly string[]> {
    const binary = outriderBinary();
    if (binary === undefined) return [];
    const result = await runOutrider(outriderListCommand(binary), () => {})
        .finished;
    return result.ok ? readOutriderProfiles(result.stdout) : [];
}

export function installOutrider(
    onProgress: (line: OutriderProgress) => void,
): RuntimeCommand {
    return runOutrider(outriderInstallCommand(), onProgress);
}

/** One command fetches what is missing and brings the gateway up on that profile. */
export function serveOutrider(
    profile: string,
    onProgress: (line: OutriderProgress) => void,
): RuntimeCommand {
    return runOutrider(
        outriderServeCommand(profile, outriderBinary() ?? OUTRIDER_BINARY),
        onProgress,
    );
}

export { mergeProgress };
