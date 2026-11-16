import { expect, test } from "bun:test";
import { join } from "node:path";

import type { SandboxConfig } from "../../src/config/sandbox.ts";
import type { HostLogEntry } from "../../src/host/host-log.ts";
import { SandboxManager } from "../../src/sandbox/manager.ts";

function manager(config: () => SandboxConfig, entries: HostLogEntry[]) {
    return new SandboxManager({
        home: "/Users/me",
        config,
        permissionRules: () => [],
        log: (entry) => entries.push(entry),
        readDependencies: () => ({
            ok: false,
            reason: "bubblewrap (bwrap) not installed",
            errors: ["bubblewrap (bwrap) not installed"],
            warnings: [],
        }),
    });
}

const enabled: SandboxConfig = {
    enabled: true,
    network: "open",
    allowed_domains: [],
};

function request(approvalMode?: string) {
    return {
        command: "echo treasure",
        cwd: "/work/repo",
        env: {},
        workspace: "/work/repo",
        sessionId: "session-1",
        toolCallId: "call-1",
        ...(approvalMode === undefined ? {} : { approvalMode }),
    };
}

test("@core the sandbox logs why it is unavailable once per process", async () => {
    const entries: HostLogEntry[] = [];
    const sandbox = manager(() => enabled, entries);
    await sandbox.prepare(request());
    await sandbox.prepare({ ...request(), toolCallId: "call-2" });
    const unavailable = entries.filter((entry) => entry.type === "sandbox_unavailable");
    expect(unavailable).toHaveLength(1);
    expect(unavailable[0]).toMatchObject({
        type: "sandbox_unavailable",
        level: "warn",
        platform: process.platform,
        srt_version: "0.0.83",
        reason: "bubblewrap (bwrap) not installed",
        errors: ["bubblewrap (bwrap) not installed"],
    });
});

test("@core a covered command that ran unwrapped is logged with why", async () => {
    const entries: HostLogEntry[] = [];
    const sandbox = manager(() => enabled, entries);
    const preparation = await sandbox.prepare(request());
    expect(preparation.notice).toContain(
        "Sandbox unavailable: bubblewrap (bwrap) not installed. "
            + "Commands run unsandboxed.",
    );
    expect(preparation.unwrapped).toBeDefined();
    sandbox.finishUnwrapped(preparation.unwrapped!, 0);
    const commands = entries.filter((entry) => entry.type === "sandbox_command");
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
        type: "sandbox_command",
        session_id: "session-1",
        tool_call_id: "call-1",
        wrapped: false,
        reason: "unavailable",
        exit_code: 0,
    });
    expect(commands[0]?.command_id).toEqual(expect.any(String));
});

test("@core a full_access command is logged as unwrapped", async () => {
    const entries: HostLogEntry[] = [];
    const sandbox = manager(() => enabled, entries);
    const preparation = await sandbox.prepare(request("full_access"));
    expect(preparation.prepared).toBeUndefined();
    expect(preparation.unwrapped?.reason).toBe("full_access");
    sandbox.finishUnwrapped(preparation.unwrapped!, 2);
    expect(entries.filter((entry) => entry.type === "sandbox_command")).toEqual([
        expect.objectContaining({
            wrapped: false,
            reason: "full_access",
            exit_code: 2,
        }),
    ]);
});

test("@core the sandbox logs a policy change", async () => {
    const entries: HostLogEntry[] = [];
    let config: SandboxConfig = enabled;
    const sandbox = manager(() => config, entries);
    await sandbox.prepare(request());
    config = { ...enabled, network: "allowlist", allowed_domains: ["github.com"] };
    await sandbox.prepare(request());
    const changed = entries.filter((entry) => entry.type === "sandbox_policy_changed");
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({
        type: "sandbox_policy_changed",
        network: "allowlist",
        allowed_hosts: 1,
        writable: expect.arrayContaining([join("/work/repo")]),
        deny_read: [],
    });
    // The protected set comes from the runtime; Vera only anchors it.
    const denyWrite = (changed[0] as { deny_write?: string[] }).deny_write ?? [];
    expect(denyWrite).toContain(join("/work/repo", ".git/hooks"));
    expect(denyWrite).toContain(join("/work/repo", ".git/config"));
});

test("@core a Linux protected-path scan failure refuses the command and is logged", async () => {
    const entries: HostLogEntry[] = [];
    const sandbox = new SandboxManager({
        home: "/Users/me",
        config: () => enabled,
        permissionRules: () => [],
        log: (entry) => entries.push(entry),
        platform: "linux",
        scanProtected: () => ({
            ok: false,
            reason: "the workspace could not be read",
        }),
    });
    const preparation = await sandbox.prepare(request());
    expect(preparation.prepared).toBeUndefined();
    expect(preparation.unwrapped).toBeUndefined();
    expect(preparation.refusal).toContain("could not scan this workspace");
    expect(preparation.refusal).toContain("the workspace could not be read");
    expect(entries.filter((entry) => entry.type === "sandbox_scan_failed")).toEqual([
        expect.objectContaining({
            level: "error",
            reason: "the workspace could not be read",
        }),
    ]);
});

test("@core a missing ripgrep is named with the other Linux dependencies", async () => {
    const entries: HostLogEntry[] = [];
    const sandbox = new SandboxManager({
        home: "/Users/me",
        platform: "linux",
        config: () => enabled,
        permissionRules: () => [],
        log: (entry) => entries.push(entry),
        scanProtected: () => ({ ok: true, paths: [] }),
        readDependencies: () => ({
            ok: false,
            reason: "ripgrep (rg) not found",
            errors: ["ripgrep (rg) not found"],
            warnings: [],
        }),
    });
    try {
        const preparation = await sandbox.prepare(request());
        expect(preparation.notice).toContain(
            "Sandbox unavailable: ripgrep (rg) not found. Commands run unsandboxed.",
        );
        expect(preparation.notice).toContain("ripgrep");
        expect(preparation.notice).toContain("Install bubblewrap, socat and ripgrep");
        expect(sandbox.inspection().reason).toContain("ripgrep (rg) not found");
        const unavailable = entries.filter(
            (entry) => entry.type === "sandbox_unavailable",
        );
        expect(unavailable).toHaveLength(1);
        expect(unavailable[0]?.errors).toEqual(["ripgrep (rg) not found"]);
        expect(String(unavailable[0]?.install)).toContain("ripgrep");
    } finally {
        await sandbox.dispose();
    }
});
