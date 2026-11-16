import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import {
    DANGEROUS_FILES,
    getDangerousDirectories,
} from "@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-utils.js";
import { SandboxManager as Srt } from "@anthropic-ai/sandbox-runtime";

import type { PermissionRule } from "../../src/engine/permissions.ts";
import { runSkillScript } from "../../src/skills/script.ts";
import type { HostLogEntry } from "../../src/host/host-log.ts";
import { sandboxSessionSuffix } from "../../src/sandbox/attribution.ts";
import { SandboxManager } from "../../src/sandbox/manager.ts";
import { readMacOSLog } from "../../src/sandbox/recovery.ts";
import { ManagedProcessRegistry } from "../../src/tools/process-runtime.ts";

// Real srt, real seatbelt: macOS only. Elsewhere the sandbox is not exercised.
const mac = process.platform === "darwin";
const directories: string[] = [];
const outsideFiles: string[] = [];
const startedIn = process.cwd();
let callerDirectory: string | undefined;

// srt anchors its own protected set at the folder its process runs in, and a
// host runs from the Vera home. Every test here runs the same way, from a
// folder that holds none of the workspaces.
beforeAll(() => {
    if (!mac) return;
    callerDirectory = mkdtempSync(join(tmpdir(), "vera-sandbox-caller-"));
    process.chdir(callerDirectory);
});

afterAll(async () => {
    if (callerDirectory !== undefined) {
        process.chdir(startedIn);
        rmSync(callerDirectory, { recursive: true, force: true });
    }
    for (const directory of directories) {
        rmSync(directory, { recursive: true, force: true });
    }
    for (const file of outsideFiles) {
        rmSync(file, { force: true });
    }
    if (mac) {
        expect(monitorChildren()).toEqual([]);
    }
});

function directory(prefix: string): string {
    const path = mkdtempSync(join(tmpdir(), prefix));
    directories.push(path);
    return path;
}

function outsideFile(): string {
    const path = join(homedir(), `.vera-sandbox-live-${randomUUID()}.txt`);
    outsideFiles.push(path);
    return path;
}

function shellPath(path: string): string {
    return `'${path.replaceAll("'", "'\\''")}'`;
}

test("@core a real sandbox blocks a write outside the workspace and reports it", async () => {
    if (!mac) return;
    const workspace = directory("vera-sandbox-live-");
    const entries: HostLogEntry[] = [];
    const sandbox = new SandboxManager({
        config: () => ({
            enabled: true,
            network: "open",
            allowed_domains: [],
        }),
        permissionRules: () => [],
        log: (entry) => entries.push(entry),
    });
    const registry = new ManagedProcessRegistry({ sandbox });
    const scope = registry.scope("live");

    const outside = outsideFile();
    const blocked = await scope.run({
        command: `echo plunder > ${shellPath(outside)}`,
        cwd: workspace,
        env: { ...process.env },
        interactive: false,
        sandbox: { sessionId: "live", toolCallId: "call-1" },
    });
    expect(blocked.kind).toBe("exited");
    if (blocked.kind !== "exited") return;
    expect(blocked.snapshot.exitCode).not.toBe(0);
    expect(blocked.snapshot.output).toContain("Blocked by sandbox:");
    expect(blocked.snapshot.output).toContain(`write ${outside}`);
    expect(existsSync(outside)).toBe(false);

    const allowed = await scope.run({
        command: `echo treasure > ${shellPath(join(workspace, "ok"))}`,
        cwd: workspace,
        env: { ...process.env },
        interactive: false,
        sandbox: { sessionId: "live", toolCallId: "call-2" },
    });
    expect(allowed.kind).toBe("exited");
    if (allowed.kind !== "exited") return;
    expect(allowed.snapshot.exitCode).toBe(0);
    expect(readFileSync(join(workspace, "ok"), "utf8")).toBe("treasure\n");

    expect(entries.some((entry) => entry.type === "sandbox_started")).toBe(true);
    expect(entries.some((entry) => entry.type === "sandbox_violation")).toBe(true);
    expect(entries.some((entry) => entry.type === "sandbox_command")).toBe(true);
    const started = entries.find((entry) => entry.type === "sandbox_started");
    expect(started).toMatchObject({
        platform: process.platform,
        srt_version: "0.0.83",
        network: "open",
        allowed_hosts: 0,
    });
    expect(started?.writable as string[]).toContain(workspace);
    const write = entries.find((entry) =>
        entry.type === "sandbox_violation" && entry.target === outside
    );
    expect(write).toMatchObject({
        session_id: "live",
        tool_call_id: "call-1",
        kind: "write",
    });
    expect(String(write?.raw)).toContain("file-write-create");
    const blockedCommand = entries.find((entry) =>
        entry.type === "sandbox_command" && entry.tool_call_id === "call-1"
    );
    expect(blockedCommand).toMatchObject({
        wrapped: true,
        exit_code: expect.any(Number),
    });
    expect(blockedCommand?.violations as number).toBeGreaterThan(0);
    await sandbox.dispose();
});

test("@core a denied command that exits zero still shows its block", async () => {
    if (!mac) return;
    const workspace = directory("vera-sandbox-live-");
    const sandbox = new SandboxManager({
        config: () => ({
            enabled: true,
            network: "open",
            allowed_domains: [],
        }),
        permissionRules: () => [],
        log: () => {},
    });
    const registry = new ManagedProcessRegistry({ sandbox });
    const outside = outsideFile();
    const result = await registry.scope("live").run({
        command: `echo plunder > ${shellPath(outside)} || true`,
        cwd: workspace,
        env: { ...process.env },
        interactive: false,
        sandbox: { sessionId: "live", toolCallId: "call-1" },
    });
    expect(result.kind).toBe("exited");
    if (result.kind !== "exited") return;
    expect(result.snapshot.exitCode).toBe(0);
    expect(result.snapshot.output).toContain("Blocked by sandbox:");
    expect(result.snapshot.output).toContain(`write ${outside}`);
    await sandbox.dispose();
});

test("@core a yielded command reports its block when its output is read", async () => {
    if (!mac) return;
    const workspace = directory("vera-sandbox-live-");
    const sandbox = new SandboxManager({
        config: () => ({
            enabled: true,
            network: "open",
            allowed_domains: [],
        }),
        permissionRules: () => [],
        log: () => {},
    });
    const registry = new ManagedProcessRegistry({ sandbox });
    const scope = registry.scope("live");
    const outside = outsideFile();
    const started = await scope.run({
        command: `sleep 0.1; echo plunder > ${shellPath(outside)} || true`,
        cwd: workspace,
        env: { ...process.env },
        interactive: false,
        yieldAfterMs: 20,
        sandbox: { sessionId: "live", toolCallId: "call-1" },
    });
    expect(started.kind).toBe("running");
    if (started.kind !== "running") return;
    let snapshot = await scope.readSettled(started.snapshot.processId);
    for (let attempt = 0; attempt < 40 && snapshot?.status === "running"; attempt++) {
        await Bun.sleep(10);
        snapshot = await scope.readSettled(started.snapshot.processId);
    }
    expect(snapshot?.status).toBe("exited");
    expect(snapshot?.output).toContain("Blocked by sandbox:");
    expect(snapshot?.output).toContain(`write ${outside}`);
    await sandbox.dispose();
});

test("@core a command keeps the session's environment through the wrapper", async () => {
    if (!mac) return;
    const workspace = directory("vera-sandbox-live-");
    const sandbox = new SandboxManager({
        config: () => ({
            enabled: true,
            network: "open",
            allowed_domains: [],
        }),
        permissionRules: () => [],
        log: () => {},
    });
    const registry = new ManagedProcessRegistry({ sandbox });
    process.env.VERA_SANDBOX_LIVE_ENV = "outer";
    try {
        const result = await registry.scope("live").run({
            command: `printf '%s' "$VERA_SANDBOX_LIVE_ENV"`,
            cwd: workspace,
            env: { ...process.env, VERA_SANDBOX_LIVE_ENV: "session" },
            interactive: false,
            sandbox: { sessionId: "live", toolCallId: "call-1" },
        });
        expect(result.kind).toBe("exited");
        if (result.kind !== "exited") return;
        expect(result.snapshot.output.trim()).toBe("session");
    } finally {
        delete process.env.VERA_SANDBOX_LIVE_ENV;
        await sandbox.dispose();
    }
});

test("@core a covered command runs with an owner-only temp folder", async () => {
    if (!mac) return;
    const workspace = directory("vera-sandbox-live-");
    const sandbox = new SandboxManager({
        config: () => ({
            enabled: true,
            network: "open",
            allowed_domains: [],
        }),
        permissionRules: () => [],
        log: () => {},
    });
    const registry = new ManagedProcessRegistry({ sandbox });
    const result = await registry.scope("live").run({
        command: `printf '%s %s' "$TMPDIR" "$(stat -f '%Lp %u' "$TMPDIR")"`,
        cwd: workspace,
        env: { ...process.env },
        interactive: false,
        sandbox: { sessionId: "live", toolCallId: "call-1" },
    });
    expect(result.kind).toBe("exited");
    if (result.kind !== "exited") return;
    const [path, mode, uid] = result.snapshot.output.trim().split(" ");
    expect(path).not.toBe(tmpdir());
    expect(existsSync(path as string)).toBe(true);
    expect(mode).toBe("700");
    if (typeof process.getuid === "function") {
        expect(Number(uid)).toBe(process.getuid());
    }
    await sandbox.dispose();
});

test("@core git add and commit work in a linked worktree while its shared hooks stay blocked", async () => {
    if (!mac) return;
    const root = mkdtempSync(join(homedir(), ".vera-sandbox-git-"));
    directories.push(root);
    execFileSync("git", ["init", "-q"], { cwd: root });
    writeFileSync(join(root, "a.txt"), "a\n");
    execFileSync("git", ["add", "a.txt"], { cwd: root });
    execFileSync(
        "git",
        ["-c", "user.email=a@b", "-c", "user.name=a", "commit", "-qm", "base"],
        { cwd: root },
    );
    const worktree = join(root, "wt");
    execFileSync(
        "git",
        ["worktree", "add", "-q", "-b", "probe", worktree],
        { cwd: root },
    );
    writeFileSync(join(worktree, "f.txt"), "x\n");
    const sandbox = new SandboxManager({
        config: () => ({
            enabled: true,
            network: "open",
            allowed_domains: [],
        }),
        permissionRules: () => [],
        log: () => {},
    });
    const registry = new ManagedProcessRegistry({ sandbox });
    const scope = registry.scope("live");
    const added = await scope.run({
        command: "git add f.txt",
        cwd: worktree,
        env: { ...process.env },
        interactive: false,
        sandbox: { sessionId: "live", toolCallId: "call-1" },
    });
    expect(added.kind).toBe("exited");
    if (added.kind !== "exited") return;
    expect(added.snapshot.output).not.toContain("Blocked by sandbox:");
    expect(added.snapshot.exitCode).toBe(0);

    const committed = await scope.run({
        command: "git -c user.email=a@b -c user.name=a commit -qm two",
        cwd: worktree,
        env: { ...process.env },
        interactive: false,
        sandbox: { sessionId: "live", toolCallId: "call-2" },
    });
    expect(committed.kind).toBe("exited");
    if (committed.kind !== "exited") return;
    expect(committed.snapshot.output).not.toContain("Blocked by sandbox:");
    expect(committed.snapshot.exitCode).toBe(0);
    expect(
        execFileSync("git", ["log", "--oneline", "-1"], {
            cwd: worktree,
            encoding: "utf8",
        }),
    ).toContain("two");

    // The denial is enforced; whether it is listed depends on srt's macOS log
    // monitor delivering the line, which it can drop after a git command.
    const hook = join(root, ".git", "hooks", "pre-commit");
    const blocked = await scope.run({
        command: `echo x > ${shellPath(hook)}`,
        cwd: worktree,
        env: { ...process.env },
        interactive: false,
        sandbox: { sessionId: "live", toolCallId: "call-3" },
    });
    expect(blocked.kind).toBe("exited");
    if (blocked.kind !== "exited") return;
    expect(blocked.snapshot.exitCode).not.toBe(0);
    expect(existsSync(hook)).toBe(false);
    await sandbox.dispose();
});

test("@core a real sandbox blocks a denied read reached through a variable path", async () => {
    if (!mac) return;
    const workspace = directory("vera-sandbox-live-");
    const secret = join(directory("vera-sandbox-secret-"), "map.txt");
    writeFileSync(secret, "buried treasure\n");
    const rules: PermissionRule[] = [{
        name: "no-map",
        when: { path: secret, verb: "read" },
        then: "deny",
    }];
    const sandbox = new SandboxManager({
        config: () => ({
            enabled: true,
            network: "open",
            allowed_domains: [],
        }),
        permissionRules: () => rules,
        log: () => {},
    });
    const registry = new ManagedProcessRegistry({ sandbox });
    const result = await registry.scope("live").run({
        command: `f=${shellPath(secret)}; cat "$f"`,
        cwd: workspace,
        env: { ...process.env },
        interactive: false,
        sandbox: { sessionId: "live", toolCallId: "call-1" },
    });
    expect(result.kind).toBe("exited");
    if (result.kind !== "exited") return;
    expect(result.snapshot.exitCode).not.toBe(0);
    expect(result.snapshot.output).toContain("Blocked by sandbox:");
    expect(result.snapshot.output).toContain(`read ${secret}`);
    expect(result.snapshot.output).not.toContain("buried treasure");
    await sandbox.dispose();
});

test("@core a monitor handshake that runs out still reaches ready and says so", async () => {
    if (!mac) return;
    const workspace = directory("vera-sandbox-live-");
    const entries: HostLogEntry[] = [];
    const sandbox = new SandboxManager({
        config: () => ({
            enabled: true,
            network: "open",
            allowed_domains: [],
        }),
        permissionRules: () => [],
        log: (entry) => entries.push(entry),
        monitorTimeoutMs: 1,
    });
    const registry = new ManagedProcessRegistry({ sandbox });
    const outside = outsideFile();
    const before = Date.now();
    const result = await registry.scope("live").run({
        command: `echo plunder > ${shellPath(outside)}`,
        cwd: workspace,
        env: { ...process.env },
        interactive: false,
        sandbox: { sessionId: "live", toolCallId: "call-1" },
    });
    expect(Date.now() - before).toBeLessThan(5_000);
    expect(result.kind).toBe("exited");
    if (result.kind !== "exited") return;
    expect(result.snapshot.exitCode).not.toBe(0);
    expect(result.snapshot.output).toContain("Blocked by sandbox:");
    expect(entries.some((entry) => entry.type === "sandbox_started")).toBe(true);
    const unconfirmed = entries.find(
        (entry) => entry.type === "sandbox_monitor_unconfirmed",
    );
    expect(unconfirmed).toMatchObject({
        level: "warn",
        platform: process.platform,
        timeout_ms: 1,
    });
    expect(String(unconfirmed?.reason)).toContain("violation lines");
    expect(sandbox.inspection().status).toBe("active");
    await sandbox.dispose();
});

interface Attempt {
    readonly command: string;
    readonly target: string;
    readonly before?: string;
}

function sandboxManager(): SandboxManager {
    return new SandboxManager({
        config: () => ({
            enabled: true,
            network: "open",
            allowed_domains: [],
        }),
        permissionRules: () => [],
        log: () => {},
    });
}

async function expectBlocked(
    scope: ReturnType<ManagedProcessRegistry["scope"]>,
    workspace: string,
    attempts: readonly Attempt[],
): Promise<void> {
    for (const [index, attempt] of attempts.entries()) {
        const result = await scope.run({
            command: attempt.command,
            cwd: workspace,
            env: { ...process.env },
            interactive: false,
            sandbox: { sessionId: "live", toolCallId: `call-${index}` },
        });
        expect(result.kind).toBe("exited");
        if (result.kind !== "exited") return;
        expect(result.snapshot.exitCode).not.toBe(0);
        if (attempt.before === undefined) {
            expect(existsSync(attempt.target)).toBe(false);
        } else {
            expect(readFileSync(attempt.target, "utf8")).toBe(attempt.before);
        }
    }
}

test("@core a main checkout's hooks, config and protected names are blocked from outside it", async () => {
    if (!mac) return;
    const repo = directory("vera-sandbox-repo-");
    execFileSync("git", ["init", "-q"], { cwd: repo });
    const protectedFile = DANGEROUS_FILES[0]!;
    const protectedDirectory = getDangerousDirectories()[0]!;
    const config = join(repo, ".git", "config");
    const before = readFileSync(config, "utf8");
    mkdirSync(join(repo, "sub", protectedDirectory), { recursive: true });
    mkdirSync(join(repo, "sub", ".git", "hooks"), { recursive: true });
    const sandbox = sandboxManager();
    const scope = new ManagedProcessRegistry({ sandbox }).scope("live");
    await expectBlocked(scope, repo, [
        {
            command: `echo x > ${shellPath(join(repo, ".git", "hooks", "pre-commit"))}`,
            target: join(repo, ".git", "hooks", "pre-commit"),
        },
        {
            command: `echo x >> ${shellPath(config)}`,
            target: config,
            before,
        },
        {
            command: `echo x > ${shellPath(join(repo, protectedFile))}`,
            target: join(repo, protectedFile),
        },
        {
            command: `mkdir -p ${shellPath(join(repo, protectedDirectory))}`
                + ` && echo x > ${shellPath(join(repo, protectedDirectory, "settings.json"))}`,
            target: join(repo, protectedDirectory, "settings.json"),
        },
        {
            command: `echo x > ${shellPath(join(repo, "sub", protectedFile))}`,
            target: join(repo, "sub", protectedFile),
        },
        {
            command: `echo x > ${shellPath(join(repo, "sub", protectedDirectory, "settings.json"))}`,
            target: join(repo, "sub", protectedDirectory, "settings.json"),
        },
        {
            command: `echo x > ${shellPath(join(repo, "sub", ".git", "hooks", "pre-commit"))}`,
            target: join(repo, "sub", ".git", "hooks", "pre-commit"),
        },
    ]);
    await sandbox.dispose();
});

test("@core a linked worktree's shared hooks and config are blocked from outside it", async () => {
    if (!mac) return;
    const root = directory("vera-sandbox-linked-");
    execFileSync("git", ["init", "-q"], { cwd: root });
    writeFileSync(join(root, "a.txt"), "a\n");
    execFileSync("git", ["add", "a.txt"], { cwd: root });
    execFileSync(
        "git",
        ["-c", "user.email=a@b", "-c", "user.name=a", "commit", "-qm", "base"],
        { cwd: root },
    );
    const worktree = join(root, "wt");
    execFileSync("git", ["worktree", "add", "-q", "-b", "probe", worktree], { cwd: root });
    const protectedFile = DANGEROUS_FILES[0]!;
    const protectedDirectory = getDangerousDirectories()[0]!;
    const sharedConfig = join(root, ".git", "config");
    const before = readFileSync(sharedConfig, "utf8");
    const sandbox = sandboxManager();
    const scope = new ManagedProcessRegistry({ sandbox }).scope("live");
    await expectBlocked(scope, worktree, [
        {
            command: `echo x > ${shellPath(join(root, ".git", "hooks", "pre-commit"))}`,
            target: join(root, ".git", "hooks", "pre-commit"),
        },
        {
            command: `echo x >> ${shellPath(sharedConfig)}`,
            target: sharedConfig,
            before,
        },
        {
            command: `echo x > ${shellPath(join(worktree, protectedFile))}`,
            target: join(worktree, protectedFile),
        },
        {
            command: `mkdir -p ${shellPath(join(worktree, protectedDirectory))}`
                + ` && echo x > ${shellPath(join(worktree, protectedDirectory, "settings.json"))}`,
            target: join(worktree, protectedDirectory, "settings.json"),
        },
    ]);
    await sandbox.dispose();
});

test("@core a sandboxed skill script sees its own allowlist and not this process's variables", async () => {
    if (!mac) return;
    const workspace = directory("vera-sandbox-skill-");
    const skillDirectory = directory("vera-sandbox-skilldir-");
    const scriptPath = join(skillDirectory, "show.sh");
    writeFileSync(
        scriptPath,
        "#!/bin/sh\nprintf '%s|%s|%s' \"$VERA_WORKSPACE\" \"$VERA_SANDBOX_MARKER\" \"$VERA_SKILL_DIR\"\n",
    );
    chmodSync(scriptPath, 0o755);
    const markerName = "VERA_SANDBOX_MARKER";
    const previous = process.env[markerName];
    process.env[markerName] = "leak";
    const sandbox = sandboxManager();
    try {
        const result = await runSkillScript({
            scriptPath,
            args: [],
            workspace,
            skillDirectory,
            timeoutMs: 10_000,
            signal: new AbortController().signal,
            sandbox,
            identity: { sessionId: "live", toolCallId: "call-1" },
        });
        expect(result.kind).toBe("output");
        if (result.kind !== "output") return;
        expect(result.output).toBe(`${workspace}||${skillDirectory}`);
        expect(result.output).not.toContain("leak");
    } finally {
        if (previous === undefined) {
            delete process.env[markerName];
        } else {
            process.env[markerName] = previous;
        }
        await sandbox.dispose();
    }
});

test("@core a disposed sandbox leaves no log stream child of this process", async () => {
    if (!mac) return;
    const workspace = directory("vera-sandbox-live-");
    const sandbox = sandboxManager();
    const result = await new ManagedProcessRegistry({ sandbox }).scope("live").run({
        command: "echo treasure",
        cwd: workspace,
        env: { ...process.env },
        interactive: false,
        sandbox: { sessionId: "live", toolCallId: "call-1" },
    });
    expect(result.kind).toBe("exited");
    await sandbox.dispose();
    expect(monitorChildren()).toEqual([]);
});

test("@core shell commands cannot write the project's Vera config or rules", async () => {
    if (!mac) return;
    const workspace = directory("vera-sandbox-project-");
    mkdirSync(join(workspace, ".vera", "skills"), { recursive: true });
    const config = join(workspace, ".vera", "config.json");
    const rules = join(workspace, ".vera", "rules");
    writeFileSync(config, '{"original":true}\n');
    const sandbox = sandboxManager();
    const scope = new ManagedProcessRegistry({ sandbox }).scope("live");
    const run = (command: string): ReturnType<typeof scope.run> => scope.run({
        command,
        cwd: workspace,
        env: { ...process.env },
        interactive: false,
        sandbox: { sessionId: "live", toolCallId: "call-project" },
    });

    const overwritten = await run(`echo x > ${shellPath(config)}`);
    expect(overwritten.kind).toBe("exited");
    if (overwritten.kind !== "exited") return;
    expect(overwritten.snapshot.exitCode).not.toBe(0);
    expect(readFileSync(config, "utf8")).toBe('{"original":true}\n');

    // An absent config is protected too, and so is creating the rules folder.
    rmSync(config);
    const created = await run(`echo x > ${shellPath(config)}`);
    expect(created.kind).toBe("exited");
    if (created.kind !== "exited") return;
    expect(created.snapshot.exitCode).not.toBe(0);
    expect(existsSync(config)).toBe(false);

    expect(existsSync(rules)).toBe(false);
    const madeRules = await run(`mkdir ${shellPath(rules)} && echo x > ${shellPath(join(rules, "x.md"))}`);
    expect(madeRules.kind).toBe("exited");
    if (madeRules.kind !== "exited") return;
    expect(madeRules.snapshot.exitCode).not.toBe(0);
    expect(existsSync(join(rules, "x.md"))).toBe(false);

    // Renaming the folder that holds a protected path is denied, so the pair
    // cannot be replaced by a fresh folder at the same path.
    writeFileSync(config, '{"original":true}\n');
    mkdirSync(rules, { recursive: true });
    writeFileSync(join(rules, "keep.md"), "keep\n");
    const bypass = await run(
        `mv .vera .vera-old && mkdir -p .vera/rules && echo x > .vera/rules/x.md`,
    );
    expect(bypass.kind).toBe("exited");
    if (bypass.kind !== "exited") return;
    expect(bypass.snapshot.exitCode).not.toBe(0);
    expect(existsSync(join(workspace, ".vera-old"))).toBe(false);
    expect(readFileSync(config, "utf8")).toBe('{"original":true}\n');
    expect(existsSync(join(rules, "x.md"))).toBe(false);

    // The rest of `.vera` stays writable.
    const rest = await run(
        `mkdir -p .vera/skills && echo ok > .vera/skills/good.md`,
    );
    expect(rest.kind).toBe("exited");
    if (rest.kind !== "exited") return;
    expect(rest.snapshot.exitCode).toBe(0);
    expect(readFileSync(join(workspace, ".vera", "skills", "good.md"), "utf8"))
        .toBe("ok\n");
    await sandbox.dispose();
});

test("@core a denial cleared from the live store is recovered from the system log", async () => {
    if (!mac) return;
    const workspace = directory("vera-sandbox-recovery-live-");
    const entries: HostLogEntry[] = [];
    const outside = outsideFile();
    const sandbox = new SandboxManager({
        config: () => ({
            enabled: true,
            network: "open",
            allowed_domains: [],
        }),
        permissionRules: () => [],
        log: (entry) => entries.push(entry),
        recoveryDelayMs: 100,
        recoveryTimeoutMs: 15_000,
    });
    try {
        const startedAt = Date.now();
        const preparation = await sandbox.prepare({
            command: `echo plunder > ${shellPath(outside)}`,
            cwd: workspace,
            env: { ...process.env },
            workspace,
            sessionId: "live-recovery",
            toolCallId: "call-recovery",
        });
        expect(preparation.prepared).toBeDefined();
        const prepared = preparation.prepared!;
        const child = Bun.spawn([...prepared.argv], {
            cwd: workspace,
            env: { ...process.env, ...prepared.env },
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
        });
        const exitCode = await child.exited;
        expect(exitCode).not.toBe(0);

        // Let the live monitor file the line, then drop the store so the
        // command settles without it, as it does when the monitor misses it.
        for (let attempt = 0; attempt < 200; attempt++) {
            if (Srt.getSandboxViolationStore().getViolationsForCommand(prepared.commandId).length > 0) {
                break;
            }
            await Bun.sleep(5);
        }
        // The live monitor and `log show` read the same records by different
        // paths. Wait until the record is queryable, so the case is "missed
        // live, present in the system log" and not a race with ingestion.
        const suffix = sandboxSessionSuffix(prepared.argv);
        expect(suffix).toBeDefined();
        if (suffix === undefined) return;
        const deadline = Date.now() + 10_000;
        let visible: readonly string[] = [];
        while (Date.now() < deadline) {
            visible = await readMacOSLog(
                { start: startedAt - 2_000, end: Date.now() + 2_000, suffix },
                new AbortController().signal,
            );
            if (visible.some((line) => line.includes(outside))) break;
            await Bun.sleep(100);
        }
        expect(visible.join("\n")).toContain(outside);
        Srt.getSandboxViolationStore().clear();
        const settled = await sandbox.settle(prepared, exitCode);
        expect(settled.suffix).not.toContain("Blocked by sandbox:");

        sandbox.turnEnded();
        await sandbox.whenRecoveryIdle();
        const recovered = entries.filter(
            (entry) => entry.type === "sandbox_violation" && entry.recovered === true,
        );
        expect(recovered).toHaveLength(1);
        expect(recovered[0]).toMatchObject({
            recovered: true,
            session_id: "live-recovery",
            tool_call_id: "call-recovery",
            command_id: prepared.commandId,
            kind: "write",
        });
        expect(String(recovered[0]?.raw)).toContain("file-write-create");
    } finally {
        await sandbox.dispose();
    }
});

function monitorChildren(): string[] {
    const listing = execFileSync(
        "ps",
        ["-Ao", "pid=,ppid=,comm=,args="],
        { encoding: "utf8" },
    );
    return listing
        .split("\n")
        .filter((line) => {
            const columns = line.trim().split(/\s+/);
            return columns[1] === String(process.pid)
                && columns[2] === "log"
                && line.includes(" stream --predicate ");
        });
}
