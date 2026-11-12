import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HostBootLoopError } from "../../clients/host/boot-failures.ts";
import { findOrStartResidentHost, HostStartFailedError, startNamingCause } from "../../clients/host/launch.ts";
import { HostStartDeadlineError } from "../../src/host/discovery.ts";
import type { HostLockRecord } from "../../src/host/lockfile.ts";
import {
    clearHostStartupFailure,
    homeCommandPrefix,
    homeSocketPathLimit,
    HostHomeUnusableError,
    hostHomeProblem,
    HostSocketPathTooLongError,
    hostSocketPath,
    hostSocketPathProblem,
    readHostStartupFailure,
    recordHostStartupFailure,
    socketPlatformName,
    UNIX_SOCKET_PATH_LIMIT,
} from "../../src/host/startup-failure.ts";

let scratch: string;
let savedHome: string | undefined;

beforeEach(() => {
    scratch = mkdtempSync(join(process.env.VERA_TEST_TEMP_BASE ?? tmpdir(), "vera-sf-"));
    savedHome = process.env.VERA_HOME;
});

afterEach(() => {
    if (savedHome === undefined) delete process.env.VERA_HOME;
    else process.env.VERA_HOME = savedHome;
    rmSync(scratch, { recursive: true, force: true });
});

// A home whose socket path is exactly `bytes` long.
function homeWithSocketOf(bytes: number): string {
    const fixed = Buffer.byteLength(hostSocketPath(join(scratch, "x"))) - 1;
    const name = "h".repeat(bytes - fixed);
    return join(scratch, name);
}

test("a socket path under the limit raises no problem and one at the limit names its length", () => {
    const fits = homeWithSocketOf(UNIX_SOCKET_PATH_LIMIT - 1);
    expect(hostSocketPathProblem(fits)).toBeUndefined();

    const atLimit = homeWithSocketOf(UNIX_SOCKET_PATH_LIMIT);
    const problem = hostSocketPathProblem(atLimit);
    expect(problem).toBeInstanceOf(HostSocketPathTooLongError);
    expect(problem?.homeLength).toBe(Buffer.byteLength(atLimit));
    expect(problem?.homeLimit).toBe(homeSocketPathLimit());
});

test("a long home is refused with the home, its length, the limit and a shorter VERA_HOME to use, and no stash", () => {
    const home = homeWithSocketOf(130);
    const problem = hostSocketPathProblem(home)!;
    expect(problem.message).toBe([
        "Vera's home path is too long.",
        `Home: ${home}`,
        `On ${socketPlatformName()} a Vera home path can be at most ${homeSocketPathLimit()} characters,`
            + ` and this one is ${Buffer.byteLength(home)}.`,
        `Start Vera with a shorter home, for example: VERA_HOME=${problem.suggestedHome} vera`,
        "Nothing in this home was moved or deleted.",
    ].join("\n"));
    expect(problem.message).toMatch(/for example: VERA_HOME=\S+ vera\n/);
    expect(problem.message).not.toContain("socket");
    expect(problem.message.toLowerCase()).not.toContain("stash");
    expect(Buffer.byteLength(hostSocketPath(problem.suggestedHome))).toBeLessThan(UNIX_SOCKET_PATH_LIMIT);
    expect(problem.suggestedHome).not.toBe(home);
});

test("a home that is a file, or a runtime folder that is a file, is named instead of failing with ENOTDIR", () => {
    const file = join(scratch, "afile");
    writeFileSync(file, "x");
    const asHome = hostHomeProblem(file);
    expect(asHome).toBeInstanceOf(HostHomeUnusableError);
    expect(asHome?.message).toContain(`${file} is a file, and Vera needs a folder there`);
    expect(asHome?.message).toMatch(/for example: VERA_HOME=\S+ vera$/);

    const home = join(scratch, "home");
    mkdirSync(home);
    writeFileSync(join(home, "runtime"), "x");
    expect(hostHomeProblem(home)?.message).toContain(`${join(home, "runtime")} is a file`);

    expect(hostHomeProblem(join(scratch, "missing"))).toBeUndefined();
});

test("findOrStartResidentHost refuses a long home before it inspects or spawns anything", async () => {
    process.env.VERA_HOME = homeWithSocketOf(140);
    await expect(findOrStartResidentHost({})).rejects.toBeInstanceOf(HostSocketPathTooLongError);
});

test("a recorded host failure is read back only when it is newer than the start that asked", () => {
    const home = join(scratch, "home");
    process.env.VERA_HOME = home;
    expect(readHostStartupFailure(0)).toBeUndefined();

    recordHostStartupFailure("config.json: model: expected a non-empty string", 5_000);
    expect(readHostStartupFailure(4_000)?.message).toBe("config.json: model: expected a non-empty string");
    expect(readHostStartupFailure(6_000)).toBeUndefined();

    clearHostStartupFailure();
    expect(readHostStartupFailure(0)).toBeUndefined();
});

test("a start that ran out of time names the cause the host recorded", async () => {
    process.env.VERA_HOME = join(scratch, "home");
    const timedOut = async (): Promise<HostLockRecord> => {
        recordHostStartupFailure("The host could not load its config.");
        throw new HostStartDeadlineError();
    };
    const error = await startNamingCause(timedOut).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HostStartFailedError);
    expect((error as Error).message).toBe("The Vera host stopped while starting: The host could not load its config.");
});

test("a start that ran out of time with nothing recorded keeps its own message, and other errors pass through", async () => {
    process.env.VERA_HOME = join(scratch, "home");
    await expect(startNamingCause(async () => { throw new HostStartDeadlineError(); }))
        .rejects.toThrow("Resident host did not start before its deadline");
    recordHostStartupFailure("old failure", Date.now() - 60_000);
    await expect(startNamingCause(async () => { throw new HostStartDeadlineError(); }))
        .rejects.toBeInstanceOf(HostStartDeadlineError);
    await expect(startNamingCause(async () => { throw new Error("another cause"); }))
        .rejects.toThrow("another cause");
});

test("the boot loop message carries what the host reported", () => {
    expect(new HostBootLoopError(2, "model: expected a non-empty string").message)
        .toContain("The host reported: model: expected a non-empty string");
    expect(new HostBootLoopError(2).message).not.toContain("The host reported");
});

test("a printed command carries VERA_HOME only when the environment selects a home", () => {
    delete process.env.VERA_HOME;
    expect(homeCommandPrefix()).toBe("");
    process.env.VERA_HOME = "/tmp/vera-dev/x";
    expect(homeCommandPrefix()).toBe("VERA_HOME=/tmp/vera-dev/x ");
    process.env.VERA_HOME = "/tmp/my home";
    expect(homeCommandPrefix()).toBe("VERA_HOME='/tmp/my home' ");
});
