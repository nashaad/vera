/** Driving the Outrider CLI: asking where it is, putting it on the machine, and bringing a profile up. Outrider is the only local runtime today, so this module is the one implementation a `local_runtime` definition names. */

import {
    mergeProgress,
    OUTRIDER_BINARY,
    outriderInstallCommand,
    outriderListCommand,
    outriderLogsCommand,
    outriderMarkerPaths,
    outriderServeCommand,
    outriderStartCommand,
    outriderStopCommand,
    outriderServiceCommand,
    outriderShowCommand,
    outriderAppBinaryPaths,
    outriderRegisterCommand,
    outriderStatusCommand,
    outriderUseCommand,
    parseOutriderProgress,
    readInstallMarker,
    readOutriderLog,
    readOutriderProfileDetail,
    readOutriderProfiles,
    readOutriderService,
    readOutriderStatus,
    readOutriderUse,
    type OutriderLog,
    type OutriderPresence,
    type OutriderProcess,
    type OutriderProfileDetail,
    type OutriderProgress,
    type OutriderService,
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

/** An Outrider command sitting in an installed app that no install registered. Worth knowing only when nothing else turned a binary up, because a registered install already answers first. */
export function unregisteredOutriderBinary(): string | undefined {
    return outriderAppBinaryPaths(homedir()).find((path) => existsSync(path));
}

/** Where Outrider is. No binary anywhere is the one state Vera can act on by installing. */
export async function outriderPresence(
    driver: OutriderDriver = defaultOutriderDriver,
    findUnregistered: () => string | undefined = unregisteredOutriderBinary,
): Promise<OutriderPresence> {
    const binary = driver.binary();
    if (binary === undefined) {
        const unregistered = findUnregistered();
        return {
            state: "absent",
            ...(unregistered === undefined ? {} : { unregistered }),
        };
    }
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
/** Points the install target at a binary that is already on the machine, rather than fetching another copy. */
export function registerOutrider(
    binary: string,
    onProgress: (line: OutriderProgress) => void,
    driver: OutriderDriver = defaultOutriderDriver,
): RuntimeCommand {
    return driver.run(outriderRegisterCommand(binary), onProgress);
}

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

/** Bring the gateway back up on the profile it last served. Nothing is fetched, so this is the quick path after a reboot. */
export function startOutrider(
    onProgress: (line: OutriderProgress) => void,
    driver: OutriderDriver = defaultOutriderDriver,
): RuntimeCommand {
    return driver.run(
        outriderStartCommand(driver.binary() ?? OUTRIDER_BINARY),
        onProgress,
    );
}

/** Take the gateway down. Nothing to stop is not a failure, so a refusal is read as the state it leaves behind rather than an error to show. */
export function stopOutrider(
    onProgress: (line: OutriderProgress) => void,
    driver: OutriderDriver = defaultOutriderDriver,
): RuntimeCommand {
    return driver.run(
        outriderStopCommand(driver.binary() ?? OUTRIDER_BINARY),
        onProgress,
    );
}

/** Both processes in one reading. Nothing here starts anything, so it is safe on every refresh. */
export async function outriderService(
    driver: OutriderDriver = defaultOutriderDriver,
): Promise<OutriderService | undefined> {
    const binary = driver.binary();
    if (binary === undefined) return undefined;
    const result = await driver.run(outriderServiceCommand(binary), () => {})
        .finished;
    return result.ok ? readOutriderService(result.stdout) : undefined;
}

/** The recipe behind one profile, and whether its weights are already here. */
export async function outriderProfileDetail(
    profile: string,
    driver: OutriderDriver = defaultOutriderDriver,
): Promise<OutriderProfileDetail | undefined> {
    const binary = driver.binary();
    if (binary === undefined) return undefined;
    const result = await driver.run(outriderShowCommand(profile, binary), () => {})
        .finished;
    return result.ok ? readOutriderProfileDetail(result.stdout) : undefined;
}

/** The tail of the active log, so the common case does not need the Outrider window. */
export interface LogTail extends OutriderLog {
    /** Why there are no lines. Outrider refuses with plain text when nothing has run yet, and an empty tail on its own cannot say that. */
    readonly detail?: string;
}

export async function outriderLogs(
    lines: number,
    driver: OutriderDriver = defaultOutriderDriver,
): Promise<LogTail> {
    const binary = driver.binary();
    if (binary === undefined) return { lines: [], detail: "Outrider is not installed" };
    const result = await driver.run(outriderLogsCommand(lines, binary), () => {})
        .finished;
    if (!result.ok) return { lines: [], ...(result.detail === "" ? {} : { detail: result.detail }) };
    return readOutriderLog(result.stdout);
}

/** What a swap left behind, or the reason it did not happen. `use` needs a gateway already up; `serveOutrider` is the one that brings one up. */
export interface SwapResult {
    readonly ok: boolean;
    readonly model?: OutriderProcess;
    readonly detail: string;
}

export function useOutriderProfile(
    profile: string,
    onProgress: (line: OutriderProgress) => void,
    driver: OutriderDriver = defaultOutriderDriver,
): { readonly finished: Promise<SwapResult>; stop(): void } {
    const run = driver.run(
        outriderUseCommand(profile, driver.binary() ?? OUTRIDER_BINARY),
        onProgress,
    );
    const finished = run.finished.then((result): SwapResult =>
        result.ok
            ? { ok: true, model: readOutriderUse(result.stdout), detail: result.detail }
            : { ok: false, detail: result.detail }
    );
    return { finished, stop: run.stop };
}

export { mergeProgress };
