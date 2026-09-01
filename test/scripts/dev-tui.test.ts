import { expect, test } from "bun:test";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    candidateHomePath,
    candidateLaunchEnv,
    disableOutboundConsumers,
    formatDevInstanceMarker,
    parseDevTuiArgs,
    quarantineUnknownHomeEntries,
    runDevTui,
} from "../../scripts/dev-tui.ts";

function linkedWorktree(name: string): string {
    const root = mkdtempSync(join(tmpdir(), "vera-dev-tui-src-"));
    const repository = join(root, "repository");
    const checkout = join(root, name);
    mkdirSync(repository);
    Bun.spawnSync(["git", "init", "-q"], { cwd: repository });
    Bun.spawnSync(["git", "config", "user.name", "Test"], { cwd: repository });
    Bun.spawnSync(["git", "config", "user.email", "test@example.com"], {
        cwd: repository,
    });
    writeFileSync(join(repository, "tracked"), "fixture\n");
    Bun.spawnSync(["git", "add", "tracked"], { cwd: repository });
    Bun.spawnSync(["git", "commit", "-qm", "fixture"], { cwd: repository });
    Bun.spawnSync(["git", "worktree", "add", "-q", checkout], {
        cwd: repository,
    });
    return realpathSync(checkout);
}

function dailyHome(root: string): string {
    const home = join(root, "daily");
    mkdirSync(join(home, "runtime"), { recursive: true });
    mkdirSync(join(home, "machine"), { recursive: true });
    writeFileSync(
        join(home, "config.json"),
        JSON.stringify({
            schema_version: 1,
            experimental: { inbox: true },
        }, null, 2) + "\n",
    );
    writeFileSync(join(home, "runtime", "session.jsonl"), "daily-session\n");
    writeFileSync(join(home, "machine", "auth.json"), "{\"token\":\"secret\"}\n");
    return home;
}

test("dev:tui flags parse without swallowing passthrough args", () => {
    expect(parseDevTuiArgs(["--status"])).toEqual({
        action: "status",
        fresh: false,
        yes: false,
        passthrough: [],
    });
    expect(parseDevTuiArgs(["--fresh", "--yes", "-c"])).toEqual({
        action: "run",
        fresh: true,
        yes: true,
        passthrough: ["-c"],
    });
    expect(parseDevTuiArgs(["--discard", "--stop"]).action).toBe("stop");
});

test("the DEV marker is text, not a color-only cue", () => {
    expect(formatDevInstanceMarker("/tmp/ovu26", "vera-abc")).toBe(
        "[DEV ovu26 vera-abc]",
    );
    const source = readFileSync(
        join(import.meta.dir, "../../clients/tui/main.ts"),
        "utf8",
    );
    expect(source).toContain("[DEV ${marker}]");
    expect(source).toContain("tuiDevInstancePrefix()");
});

test("two worktrees get different complete homes and sockets", () => {
    const first = mkdtempSync(join(tmpdir(), "vera-dev-a-"));
    const second = mkdtempSync(join(tmpdir(), "vera-dev-b-"));
    mkdirSync(join(first, "nested"), { recursive: true });
    mkdirSync(join(second, "nested"), { recursive: true });
    const firstHome = candidateHomePath(first);
    const secondHome = candidateHomePath(second);
    expect(firstHome).not.toBe(secondHome);
    expect(join(firstHome, "runtime", "host.sock"))
        .not.toBe(join(secondHome, "runtime", "host.sock"));
    expect(firstHome).toMatch(/\/vera-dev\/[a-f0-9]{12}\/\.vera$/);
});

function unmigratedDailyHome(root: string): string {
    const home = join(root, "daily");
    mkdirSync(join(home, "machine"), { recursive: true });
    mkdirSync(join(home, "profiles", "default", "memory"), { recursive: true });
    mkdirSync(join(home, "profiles", "other"), { recursive: true });
    writeFileSync(join(home, "machine", "auth.json"), "{\"token\":\"secret\"}\n");
    writeFileSync(
        join(home, "profiles", "default", "config.json"),
        JSON.stringify({
            schema_version: 1,
            experimental: { inbox: true },
        }, null, 2) + "\n",
    );
    writeFileSync(join(home, "profiles", "default", "memory", "note.md"), "keep\n");
    writeFileSync(join(home, "profiles", "other", "config.json"), "other-config\n");
    mkdirSync(join(home, "profiles", "default", "runtime"), { recursive: true });
    writeFileSync(
        join(home, "profiles", "default", "runtime", "host.json"),
        JSON.stringify({
            pid: 177,
            socket_path: join(home, "profiles", "default", "runtime", "host.sock"),
        }),
    );
    return home;
}

test("the first launch clones the daily home with outbound consumers off", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-dev-tui-"));
    const worktree = linkedWorktree("ovu-a");
    const sourceHome = dailyHome(root);
    const launches: Array<{ env: NodeJS.ProcessEnv }> = [];
    try {
        const code = await runDevTui([], worktree, {
            sourceHome,
            temporaryRoot: join(root, "instances"),
            spawnTui: async (_args, env) => {
                launches.push({ env });
                return 0;
            },
        });
        expect(code).toBe(0);
        const dest = launches[0]?.env.VERA_HOME;
        expect(dest).toBeDefined();
        expect(readFileSync(join(dest!, "runtime", "session.jsonl"), "utf8"))
            .toBe("daily-session\n");
        const cloned = JSON.parse(readFileSync(join(dest!, "config.json"), "utf8"));
        expect(cloned.experimental.inbox).toBe(false);
        const daily = JSON.parse(readFileSync(join(sourceHome, "config.json"), "utf8"));
        expect(daily.experimental.inbox).toBe(true);
        expect(launches[0]?.env.VERA_RUNTIME_DIR).toBeUndefined();
        expect(launches[0]?.env.VERA_DEV_INSTANCE).toMatch(/^ovu-a /);
        expect(existsSync(join(dest!, "runtime", "host.sock"))).toBe(false);
    } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(worktree, { recursive: true, force: true });
    }
});

test("a profiles/ daily home is lifted in the clone only", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-dev-tui-"));
    const worktree = linkedWorktree("ovu-lift");
    const sourceHome = unmigratedDailyHome(root);
    try {
        const code = await runDevTui([], worktree, {
            sourceHome,
            temporaryRoot: join(root, "instances"),
            spawnTui: async (_args, env) => {
                const dest = env.VERA_HOME!;
                expect(existsSync(join(dest, "profiles"))).toBe(false);
                expect(existsSync(join(dest, "runtime", "host.json"))).toBe(false);
                expect(readFileSync(join(dest, "memory", "note.md"), "utf8")).toBe("keep\n");
                expect(existsSync(join(dest, "memory", "secret.md"))).toBe(false);
                const cloned = JSON.parse(readFileSync(join(dest, "config.json"), "utf8"));
                expect(cloned.experimental.inbox).toBe(false);
                return 0;
            },
        });
        expect(code).toBe(0);
        expect(existsSync(join(sourceHome, "profiles", "default"))).toBe(true);
        expect(existsSync(join(sourceHome, "profiles", "other"))).toBe(true);
        expect(existsSync(join(sourceHome, "config.json"))).toBe(false);
    } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(worktree, { recursive: true, force: true });
    }
});

test("a reused clone drops a lifted daily host lock", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-dev-tui-"));
    const worktree = linkedWorktree("ovu-scrub");
    const sourceHome = dailyHome(root);
    try {
        await runDevTui([], worktree, {
            sourceHome,
            temporaryRoot: join(root, "instances"),
            spawnTui: async () => 0,
        });
        const dest = candidateHomePath(worktree, join(root, "instances"));
        writeFileSync(
            join(dest, "runtime", "host.json"),
            JSON.stringify({
                pid: 177,
                socket_path: join(sourceHome, "runtime", "host.sock"),
            }),
        );
        await runDevTui([], worktree, {
            sourceHome,
            temporaryRoot: join(root, "instances"),
            spawnTui: async (_args, env) => {
                expect(existsSync(join(env.VERA_HOME!, "runtime", "host.json")))
                    .toBe(false);
                return 0;
            },
        });
    } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(worktree, { recursive: true, force: true });
    }
});

test("leftover root files on a clone move into machine/leftover", () => {
    const root = mkdtempSync(join(tmpdir(), "vera-dev-leftover-"));
    const home = join(root, ".vera");
    mkdirSync(join(home, "machine"), { recursive: true });
    mkdirSync(join(home, "runtime"), { recursive: true });
    writeFileSync(join(home, "tui.json"), "{}\n");
    writeFileSync(join(home, "whisker"), "stay-out\n");
    writeFileSync(join(home, "extensions.json"), "[]\n");
    try {
        quarantineUnknownHomeEntries(home);
        expect(existsSync(join(home, "tui.json"))).toBe(true);
        expect(existsSync(join(home, "whisker"))).toBe(false);
        expect(existsSync(join(home, "extensions.json"))).toBe(false);
        expect(readFileSync(join(home, "machine", "leftover", "whisker"), "utf8"))
            .toBe("stay-out\n");
        expect(readFileSync(
            join(home, "machine", "leftover", "extensions.json"),
            "utf8",
        )).toBe("[]\n");
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("reusing a worktree preserves its sessions and never writes the daily home", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-dev-tui-"));
    const worktree = linkedWorktree("ovu-reuse");
    const sourceHome = dailyHome(root);
    const deps = {
        sourceHome,
        temporaryRoot: join(root, "instances"),
        spawnTui: async (_args: readonly string[], env: NodeJS.ProcessEnv) => {
            writeFileSync(join(env.VERA_HOME!, "runtime", "session.jsonl"), "candidate\n");
            mkdirSync(join(env.VERA_HOME!, "memory"), { recursive: true });
            writeFileSync(join(env.VERA_HOME!, "memory", "candidate-only"), "mine\n");
            return 0;
        },
    };
    try {
        await runDevTui([], worktree, deps);
        const dailyBefore = readFileSync(join(sourceHome, "runtime", "session.jsonl"), "utf8");
        await runDevTui([], worktree, {
            ...deps,
            spawnTui: async (_args, env) => {
                expect(readFileSync(join(env.VERA_HOME!, "runtime", "session.jsonl"), "utf8"))
                    .toBe("candidate\n");
                expect(readFileSync(join(env.VERA_HOME!, "memory", "candidate-only"), "utf8"))
                    .toBe("mine\n");
                return 0;
            },
        });
        expect(readFileSync(join(sourceHome, "runtime", "session.jsonl"), "utf8"))
            .toBe(dailyBefore);
        expect(existsSync(join(sourceHome, "memory", "candidate-only"))).toBe(false);
    } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(worktree, { recursive: true, force: true });
    }
});

test("--fresh does not overwrite without confirmation", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-dev-tui-"));
    const worktree = linkedWorktree("ovu-fresh");
    const sourceHome = dailyHome(root);
    const stderr: string[] = [];
    try {
        await runDevTui([], worktree, {
            sourceHome,
            temporaryRoot: join(root, "instances"),
            spawnTui: async (_args, env) => {
                writeFileSync(join(env.VERA_HOME!, "keep-me"), "yes\n");
                return 0;
            },
        });
        const code = await runDevTui(["--fresh"], worktree, {
            sourceHome,
            temporaryRoot: join(root, "instances"),
            confirm: async () => false,
            stderr: { write: (text) => stderr.push(String(text)) },
            spawnTui: async () => {
                throw new Error("must not relaunch after a refused refresh");
            },
        });
        expect(code).toBe(0);
        expect(stderr.join("")).toContain("Kept the existing development instance");
        const dest = candidateHomePath(worktree, join(root, "instances"));
        expect(readFileSync(join(dest, "keep-me"), "utf8")).toBe("yes\n");
    } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(worktree, { recursive: true, force: true });
    }
});

test("--fresh --yes reclones after confirmation is skipped", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-dev-tui-"));
    const worktree = linkedWorktree("ovu-yes");
    const sourceHome = dailyHome(root);
    try {
        await runDevTui([], worktree, {
            sourceHome,
            temporaryRoot: join(root, "instances"),
            spawnTui: async (_args, env) => {
                writeFileSync(join(env.VERA_HOME!, "keep-me"), "yes\n");
                return 0;
            },
        });
        await runDevTui(["--fresh", "--yes"], worktree, {
            sourceHome,
            temporaryRoot: join(root, "instances"),
            spawnTui: async (_args, env) => {
                expect(existsSync(join(env.VERA_HOME!, "keep-me"))).toBe(false);
                expect(readFileSync(join(env.VERA_HOME!, "runtime", "session.jsonl"), "utf8"))
                    .toBe("daily-session\n");
                return 0;
            },
        });
    } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(worktree, { recursive: true, force: true });
    }
});

test("a failed live-host checkpoint refuses the clone", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-dev-tui-"));
    const worktree = linkedWorktree("ovu-ckpt");
    const sourceHome = dailyHome(root);
    writeFileSync(
        join(sourceHome, "runtime", "host.json"),
        JSON.stringify({ pid: process.pid, socket_path: join(sourceHome, "runtime", "host.sock") }),
    );
    writeFileSync(join(sourceHome, "runtime", "host.sock"), "socket");
    try {
        await expect(runDevTui([], worktree, {
            sourceHome,
            temporaryRoot: join(root, "instances"),
            checkpointDaily: async () => {
                throw new Error("checkpoint boom");
            },
            spawnTui: async () => {
                throw new Error("must not launch after a refused clone");
            },
        })).rejects.toThrow("Checkpoint failed; clone refused");
        expect(existsSync(candidateHomePath(worktree, join(root, "instances"))))
            .toBe(false);
        expect(readFileSync(join(sourceHome, "runtime", "session.jsonl"), "utf8"))
            .toBe("daily-session\n");
    } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(worktree, { recursive: true, force: true });
    }
});

test("--status reports the candidate home without launching", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-dev-tui-"));
    const worktree = linkedWorktree("ovu-status");
    const chunks: string[] = [];
    try {
        const code = await runDevTui(["--status"], worktree, {
            sourceHome: dailyHome(root),
            temporaryRoot: join(root, "instances"),
            stdout: { write: (text) => chunks.push(String(text)) },
            spawnTui: async () => {
                throw new Error("status must not launch");
            },
        });
        expect(code).toBe(0);
        const report = chunks.join("");
        expect(report).toContain(`Worktree: ${worktree}`);
        expect(report).toContain("Host PID: not running");
        expect(report).toContain(candidateHomePath(worktree, join(root, "instances")));
    } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(worktree, { recursive: true, force: true });
    }
});

test("--discard without confirmation keeps the instance", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-dev-tui-"));
    const worktree = linkedWorktree("ovu-keep");
    const sourceHome = dailyHome(root);
    const stderr: string[] = [];
    try {
        await runDevTui([], worktree, {
            sourceHome,
            temporaryRoot: join(root, "instances"),
            spawnTui: async () => 0,
        });
        await runDevTui(["--discard"], worktree, {
            sourceHome,
            temporaryRoot: join(root, "instances"),
            confirm: async () => false,
            stderr: { write: (text) => stderr.push(String(text)) },
        });
        expect(stderr.join("")).toContain("Kept the development instance");
        expect(existsSync(candidateHomePath(worktree, join(root, "instances"))))
            .toBe(true);
    } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(worktree, { recursive: true, force: true });
    }
});

test("disableOutboundConsumers turns inbox off on the clone only", () => {
    const root = mkdtempSync(join(tmpdir(), "vera-outbound-"));
    const home = join(root, ".vera");
    mkdirSync(home);
    writeFileSync(
        join(home, "config.json"),
        JSON.stringify({ experimental: { inbox: true } }),
    );
    try {
        disableOutboundConsumers(home);
        expect(JSON.parse(readFileSync(join(home, "config.json"), "utf8")))
            .toEqual({ experimental: { inbox: false } });
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("candidate launch env drops runtime islands and names the DEV instance", () => {
    const env = candidateLaunchEnv(
        "/tmp/vera-dev/abc/.vera",
        "/Users/nash/Projects/vera/.worktrees/ovu26",
        "vera-deadbeef",
        {
            VERA_RUNTIME_DIR: "/tmp/old-runtime",
            VERA_WORKTREE_RUNTIME: "/tmp/old-runtime",
            PATH: "/bin",
        },
    );
    expect(env.VERA_HOME).toBe("/tmp/vera-dev/abc/.vera");
    expect(env.VERA_RUNTIME_DIR).toBeUndefined();
    expect(env.VERA_WORKTREE_RUNTIME).toBeUndefined();
    expect(env.VERA_DEV_INSTANCE).toBe("ovu26 vera-deadbeef");
});
