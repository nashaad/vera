import { afterEach, beforeEach, expect, test } from "bun:test";
import {
    existsSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli, runCliMain } from "../clients/cli/main.ts";
import { defaultVeraConfigPath, loadOptionalVeraConfig } from "../src/config.ts";

let home: string;
let previousHome: string | undefined;

beforeEach(() => {
    previousHome = process.env.VERA_HOME;
    home = mkdtempSync(join(tmpdir(), "vcr-"));
    process.env.VERA_HOME = home;
});

afterEach(() => {
    if (previousHome === undefined) delete process.env.VERA_HOME;
    else process.env.VERA_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
});

const GOOD = { schema_version: 1, model: "stub/example-model" };
const BAD = { ...GOOD, extensions: [{ path: "/opt/vera-a" }, { enabled: true }] };

function writeConfig(value: unknown): string {
    const path = defaultVeraConfigPath();
    writeFileSync(path, JSON.stringify(value, null, 2));
    return path;
}

function backups(): string[] {
    return readdirSync(home).filter((name) => name.endsWith(".bak"));
}

// A start that reads the config the way a real one does, so the retry sees the rewritten file.
function capture(options: {
    readonly interactive: boolean;
    readonly answers?: boolean[];
}) {
    const run = {
        out: "",
        err: "",
        questions: [] as string[],
        starts: 0,
        dependencies: {} as Parameters<typeof runCliMain>[1],
    };
    run.dependencies = {
        configRecoveryInteractive: options.interactive,
        confirmConfigSetAside: async (question: string) => {
            run.questions.push(question);
            return options.answers?.[run.questions.length - 1] ?? false;
        },
        runTui: async () => {
            run.starts += 1;
            loadOptionalVeraConfig();
        },
        stdout: { write: (text: string) => { run.out += text; } },
        stderr: { write: (text: string) => { run.err += text; } },
    };
    return run;
}

test("@core vera offers to set aside the failing extension entry and starts after yes", async () => {
    const path = writeConfig(BAD);
    const before = readFileSync(path, "utf8");
    const run = capture({ interactive: true, answers: [true] });

    expect(await runCliMain([], run.dependencies)).toBe(0);

    expect(run.starts).toBe(2);
    expect(run.questions).toHaveLength(1);
    expect(run.questions[0]).toContain("Set aside extensions[1]");
    expect(run.err).toContain("extensions[1]: path is missing; it must be an absolute path");
    expect(run.err).toContain("The whole file before the change is at");
    expect(backups()).toHaveLength(1);
    expect(readFileSync(join(home, backups()[0]!), "utf8")).toBe(before);
    expect(loadOptionalVeraConfig()?.model).toBe(GOOD.model);
});

test("declining the offer leaves the file alone and exits nonzero with the way out", async () => {
    const path = writeConfig(BAD);
    const before = readFileSync(path, "utf8");
    const run = capture({ interactive: true, answers: [false] });

    expect(await runCliMain([], run.dependencies)).toBe(1);

    expect(run.starts).toBe(1);
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(backups()).toEqual([]);
    expect(run.err).toContain(`Fix or remove ${path} and run Vera again.`);
    expect(run.err).toContain("vera doctor --config --yes");
});

test("without a terminal there is no prompt, only the cause and one command", async () => {
    const path = writeConfig(BAD);
    const run = capture({ interactive: false });

    expect(await runCliMain([], run.dependencies)).toBe(1);

    expect(run.questions).toEqual([]);
    expect(run.starts).toBe(1);
    expect(backups()).toEqual([]);
    expect(run.err).toContain("extensions[1]: path is missing");
    expect(run.err).toContain(`Fix or remove ${path} and run Vera again.`);
    expect(run.err).toContain(
        "To set aside extensions[1] and keep the rest (a copy of the file is saved first), run:"
        + ` VERA_HOME=${home} vera doctor --config --yes`,
    );
});

test("vera -p never prompts, even on a terminal", async () => {
    writeConfig(BAD);
    const run = capture({ interactive: true, answers: [true] });
    const exitCode = await runCliMain(["-p", "hello"], {
        ...run.dependencies,
        runOnce: async () => {
            loadOptionalVeraConfig();
            throw new Error("the config loaded");
        },
    });

    expect(exitCode).toBe(1);
    expect(run.questions).toEqual([]);
    expect(run.err).toContain("vera doctor --config --yes");
    expect(backups()).toEqual([]);
});

test("a config that is missing a required key offers first-run setup", async () => {
    const path = writeConfig({ schema_version: 1 });
    const run = capture({ interactive: true, answers: [true] });

    expect(await runCliMain([], run.dependencies)).toBe(0);

    expect(run.questions[0]).toContain("first-run setup");
    expect(existsSync(path)).toBe(false);
    expect(backups()).toHaveLength(1);
});

test("vera doctor --config --yes sets aside the failing entry and touches nothing else", async () => {
    writeConfig(BAD);
    const run = capture({ interactive: false });

    const exitCode = await runCli(["doctor", "--config", "--yes"], {
        ...run.dependencies,
        doctor: async () => { throw new Error("must not inspect processes"); },
        tmuxSockets: async () => { throw new Error("must not inspect tmux"); },
        sweepTmuxSockets: async () => { throw new Error("must not sweep tmux"); },
        stopStrayProcesses: async () => { throw new Error("must not stop processes"); },
        providerDoctor: async () => { throw new Error("must not contact providers"); },
    });

    expect(exitCode).toBe(0);
    expect(run.questions).toEqual([]);
    expect(run.out).toContain("Removed extensions[1]");
    expect(run.out).toContain("Vera's config loads.");
    expect(backups()).toHaveLength(1);
    expect(loadOptionalVeraConfig()?.model).toBe(GOOD.model);
});

test("vera doctor --config on a healthy config only says it loads", async () => {
    writeConfig(GOOD);
    const run = capture({ interactive: false });

    expect(await runCli(["doctor", "--config"], run.dependencies)).toBe(0);

    expect(run.out).toBe("Vera's config loads.\n");
    expect(backups()).toEqual([]);
});

test("vera doctor --config without a terminal or --yes reports the failure and changes nothing", async () => {
    const path = writeConfig(BAD);
    const before = readFileSync(path, "utf8");
    const run = capture({ interactive: false });

    const exitCode = await runCli(["doctor", "--config"], run.dependencies);

    expect(exitCode).toBe(1);
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(backups()).toEqual([]);
    expect(run.err).toContain("extensions[1]: path is missing");
    expect(run.err).toContain("vera doctor --config --yes");
});

test("vera boot names the refused config field and the command that fixes it, and starts no host", async () => {
    const path = writeConfig(BAD);
    const run = capture({ interactive: false });

    expect(await runCliMain(["boot"], run.dependencies)).toBe(1);

    expect(run.err).toContain("extensions[1]: path is missing; it must be an absolute path");
    expect(run.err).toContain(`Fix or remove ${path} and run Vera again.`);
    expect(run.err).toContain(`VERA_HOME=${home} vera doctor --config --yes`);
    expect(existsSync(join(home, "runtime", "host.json"))).toBe(false);
    expect(backups()).toEqual([]);
});
