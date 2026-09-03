/** Driving the Outrider CLI: asking where it is, putting it on the machine, and bringing a profile up. Outrider is the only local runtime today, so this module is the one implementation a `local_runtime` definition names. */

import {
    mergeProgress,
    outriderInstallCommand,
    outriderServeCommand,
    outriderStatusCommand,
    parseOutriderProgress,
    readOutriderStatus,
    type OutriderPresence,
    type OutriderProgress,
} from "../../../src/providers/outrider.ts";

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

/** Where Outrider is. Nothing on PATH is the one state Vera can act on by installing. */
export async function outriderPresence(): Promise<OutriderPresence> {
    const command = outriderStatusCommand();
    if (Bun.which(command[0] ?? "") === null) return { state: "absent" };
    const run = runOutrider(command, () => {});
    const result = await run.finished;
    return result.ok ? readOutriderStatus(result.stdout) : { state: "stopped" };
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
    return runOutrider(outriderServeCommand(profile), onProgress);
}

export { mergeProgress };
