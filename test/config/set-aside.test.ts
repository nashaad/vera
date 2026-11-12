import { afterEach, beforeEach, expect, test } from "bun:test";
import {
    existsSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { recoverConfig } from "../../clients/cli/config-recovery.ts";
import {
    defaultVeraConfigPath,
    loadOptionalVeraConfig,
    VeraConfigError,
} from "../../src/config.ts";
import {
    applyConfigSetAside,
    planConfigSetAside,
} from "../../src/config/set-aside.ts";

let home: string;
let previousHome: string | undefined;

beforeEach(() => {
    previousHome = process.env.VERA_HOME;
    home = mkdtempSync(join(tmpdir(), "vsa-"));
    process.env.VERA_HOME = home;
});

afterEach(() => {
    if (previousHome === undefined) delete process.env.VERA_HOME;
    else process.env.VERA_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
});

const GOOD = { schema_version: 1, model: "stub/example-model" };

function writeConfig(value: unknown): string {
    const path = defaultVeraConfigPath();
    writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value, null, 2));
    return path;
}

function refusal(): VeraConfigError {
    try {
        loadOptionalVeraConfig();
    } catch (error) {
        if (error instanceof VeraConfigError) return error;
        throw error;
    }
    throw new Error("the config loaded");
}

function backups(): string[] {
    return readdirSync(home).filter((name) => name.endsWith(".bak")).sort();
}

function rewrittenConfig(): Record<string, unknown> {
    return JSON.parse(readFileSync(defaultVeraConfigPath(), "utf8")) as Record<string, unknown>;
}

function ask(answers: readonly boolean[]) {
    const questions: string[] = [];
    const written: string[] = [];
    return {
        questions,
        written,
        io: {
            write: (text: string) => { written.push(text); },
            confirm: async (question: string) => {
                questions.push(question);
                return answers[questions.length - 1] ?? false;
            },
        },
    };
}

test("@core setting aside a bad extension entry saves a backup, removes only that entry and lets Vera start", async () => {
    const original = JSON.stringify({
        ...GOOD,
        approval_mode: "ask",
        extensions: [{ path: "/opt/vera-a" }, { enabled: true }, { path: "/opt/vera-c" }],
    }, null, 2);
    writeConfig(original);
    const error = refusal();
    expect(error.field).toBe("extensions[1]");

    const run = ask([true]);
    const outcome = await recoverConfig(error, run.io);

    expect(outcome).toEqual({ error: undefined, reported: true });
    expect(run.questions).toEqual([
        'Set aside extensions[1] ({"enabled":true}) and start Vera?'
        + " A copy of the whole file is saved first. [y/N] ",
    ]);
    const [backup] = backups();
    expect(backups()).toHaveLength(1);
    expect(readFileSync(join(home, backup!), "utf8")).toBe(original);
    expect(run.written.join("")).toContain(`The whole file before the change is at ${join(home, backup!)}`);
    expect(rewrittenConfig()).toEqual({
        ...GOOD,
        approval_mode: "ask",
        extensions: [{ path: "/opt/vera-a" }, { path: "/opt/vera-c" }],
    });
    expect(loadOptionalVeraConfig()?.approval_mode).toBe("ask");
});

test("setting aside a bad key removes only that key", async () => {
    writeConfig({ ...GOOD, approval_mode: "bogus", context_limit: 1000 });
    const run = ask([true]);

    expect(await recoverConfig(refusal(), run.io)).toEqual({ error: undefined, reported: true });

    expect(rewrittenConfig()).toEqual({ ...GOOD, context_limit: 1000 });
    expect(backups()).toHaveLength(1);
});

test("the backup and the rewritten config are private to the user", async () => {
    writeConfig({ ...GOOD, approval_mode: "bogus" });
    await recoverConfig(refusal(), ask([true]).io);

    expect(statSync(defaultVeraConfigPath()).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, backups()[0]!)).mode & 0o777).toBe(0o600);
});

test("a key that cannot fix the failure alone is not the one set aside", async () => {
    writeConfig({ ...GOOD, fallback: { model: GOOD.model, after_failures: 2 } });
    const plan = planConfigSetAside(refusal());

    expect(plan?.kind).toBe("entry");
    expect(plan?.field).toBe("fallback");
});

test("a missing required key moves the file aside and starts first-run setup", async () => {
    const original = JSON.stringify({ schema_version: 1, extensions: [] });
    writeConfig(original);
    const run = ask([true]);

    expect(await recoverConfig(refusal(), run.io)).toEqual({ error: undefined, reported: true });

    expect(run.questions[0]).toContain("Move");
    expect(run.questions[0]).toContain("first-run setup");
    expect(existsSync(defaultVeraConfigPath())).toBe(false);
    expect(readFileSync(join(home, backups()[0]!), "utf8")).toBe(original);
    expect(loadOptionalVeraConfig()).toBeUndefined();
});

test("a file that is not JSON moves aside whole", async () => {
    writeConfig("{ \"schema_version\": 1,");
    const run = ask([true]);

    expect(await recoverConfig(refusal(), run.io)).toEqual({ error: undefined, reported: true });

    expect(existsSync(defaultVeraConfigPath())).toBe(false);
    expect(readFileSync(join(home, backups()[0]!), "utf8")).toBe("{ \"schema_version\": 1,");
});

test("each failure in turn is offered, and each answer saves its own backup", async () => {
    writeConfig({
        ...GOOD,
        approval_mode: "bogus",
        extensions: [{ enabled: true }],
        context_limit: -5,
    });
    const run = ask([true, true, true]);

    expect(await recoverConfig(refusal(), run.io)).toEqual({ error: undefined, reported: true });

    expect(run.questions).toHaveLength(3);
    expect(backups()).toHaveLength(3);
    expect(rewrittenConfig()).toEqual({ ...GOOD, extensions: [] });
});

test("declining changes nothing and names the file and the command that fixes it", async () => {
    const path = writeConfig({ ...GOOD, approval_mode: "bogus" });
    const before = readFileSync(path, "utf8");
    const run = ask([false]);

    const outcome = await recoverConfig(refusal(), run.io);

    expect(outcome.reported).toBe(true);
    expect(outcome.error).toBeInstanceOf(VeraConfigError);
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(backups()).toEqual([]);
    const text = run.written.join("");
    expect(text).toContain(`Fix or remove ${path} and run Vera again.`);
    expect(text).toContain(`VERA_HOME=${home} vera doctor --config --yes`);
});

test("assuming yes sets aside without asking", async () => {
    writeConfig({ ...GOOD, approval_mode: "bogus" });
    const run = ask([]);

    const outcome = await recoverConfig(refusal(), run.io, { assumeYes: true });

    expect(outcome.error).toBeUndefined();
    expect(run.questions).toEqual([]);
    expect(backups()).toHaveLength(1);
});

test("a failure in a file other than Vera's config is reported, not set aside", async () => {
    const other = new VeraConfigError(join(home, "skills.json"), "nope", "disabled_skills");
    const run = ask([true]);

    expect(await recoverConfig(other, run.io)).toEqual({ error: other, reported: false });
    expect(run.questions).toEqual([]);
});

test("two answers in the same second keep both backups", () => {
    const path = writeConfig({ ...GOOD, approval_mode: "bogus", context_limit: -1 });
    const now = new Date("2026-01-02T03:04:05Z");
    const first = applyConfigSetAside(planConfigSetAside(refusal())!, now);
    const second = applyConfigSetAside(planConfigSetAside(refusal())!, now);

    expect(first.backupPath).toBe(`${path}.20260102-030405.bak`);
    expect(second.backupPath).toBe(`${path}.20260102-030405-2.bak`);
});
