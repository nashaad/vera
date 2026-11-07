import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    runBlockCommand,
    runUnblockCommand,
    type SessionBlockCommandDependencies,
} from "../clients/cli/session-block-command.ts";
import { isSessionBlockedSync, writeSessionBlock } from "../src/host/session-block.ts";

interface Harness {
    readonly out: string[];
    readonly err: string[];
    readonly confirms: string[];
    deps: SessionBlockCommandDependencies;
}

function harness(
    blockedDirectory: string,
    overrides: Partial<SessionBlockCommandDependencies> = {},
): Harness {
    const out: string[] = [];
    const err: string[] = [];
    const confirms: string[] = [];
    const deps: SessionBlockCommandDependencies = {
        listLive: async () => [
            { id: "parent", name: "parent name", live: true, parent_id: undefined },
            { id: "child", name: undefined, live: true, parent_id: "parent" },
        ] as never,
        readStored: async () => ({
            parents: new Map([["grandchild", "child"]]),
            names: new Map([["grandchild", "stored one"]]),
        }),
        sessionDirectory: join(blockedDirectory, "..", "sessions"),
        blockedDirectory,
        hostSocketPath: async () => undefined,
        blockThroughHost: async () => ({ status: "blocked", sessionIds: [] }) as never,
        unblockThroughHost: async () => ({ status: "unblocked", sessionIds: [] }) as never,
        hasTerminal: true,
        confirm: async (question) => {
            confirms.push(question);
            return true;
        },
        output: { write: (text) => out.push(text) },
        errorOutput: { write: (text) => err.push(text) },
        now: () => new Date("2026-11-07T10:00:00.000Z"),
        ...overrides,
    };
    return { out, err, confirms, deps };
}

test("block refuses without a terminal and changes nothing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vera-cli-block-"));
    try {
        const run = harness(dir, { hasTerminal: false });
        expect(await runBlockCommand(["block", "parent"], run.deps)).toBe(1);
        expect(run.err.join("")).toBe("vera block needs a terminal to confirm.\n");
        expect(run.confirms).toEqual([]);
        expect(isSessionBlockedSync(dir, "parent")).toBe(false);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("block lists the tree including stored descendants and writes nothing when declined", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vera-cli-block-"));
    try {
        const run = harness(dir, { confirm: async () => false });
        expect(await runBlockCommand(["block", "parent", "--reason", "loop"], run.deps)).toBe(1);
        const listing = run.out.join("");
        expect(listing).toContain("child");
        expect(listing).toContain("grandchild");
        expect(listing).toContain("stored one");
        expect(listing).toContain("Reason: loop.");
        expect(run.err.join("")).toBe("Not blocked.\n");
        expect(isSessionBlockedSync(dir, "parent")).toBe(false);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("block through the host reports the sessions the host blocked", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vera-cli-block-"));
    try {
        const calls: unknown[] = [];
        const run = harness(dir, {
            hostSocketPath: async () => "/tmp/host.sock",
            blockThroughHost: async (socket, request) => {
                calls.push({ socket, request });
                return { status: "blocked", sessionIds: request.sessionIds };
            },
        });
        expect(await runBlockCommand(["block", "parent"], run.deps)).toBe(0);
        expect(calls).toEqual([{
            socket: "/tmp/host.sock",
            request: {
                targetAgentId: "parent",
                sessionIds: ["parent", "child", "grandchild"],
                reason: null,
            },
        }]);
        expect(run.out.join("")).toContain("Blocked parent name and 2 sessions it started.");
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("hostless block writes flags for the whole tree", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vera-cli-block-"));
    try {
        const run = harness(dir, {
            listLive: async () => [] as never,
            readStored: async () => ({
                parents: new Map([["grandchild", "child"]]),
                names: new Map([["child", "kid"]]),
            }),
        });
        expect(await runBlockCommand(["block", "child"], run.deps)).toBe(0);
        expect(isSessionBlockedSync(dir, "child")).toBe(true);
        expect(isSessionBlockedSync(dir, "grandchild")).toBe(true);
        expect(isSessionBlockedSync(dir, "parent")).toBe(false);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("unblock lists the group blocked with the id and clears it when confirmed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vera-cli-unblock-"));
    try {
        const at = "2026-11-07T10:00:00.000Z";
        for (const id of ["parent", "child"]) {
            await writeSessionBlock(dir, {
                version: 1,
                session_id: id,
                root_session_id: "parent",
                blocked_at: at,
                reason: null,
            });
        }
        const run = harness(dir);
        expect(await runUnblockCommand(["unblock", "child"], run.deps)).toBe(0);
        expect(run.confirms).toEqual(["Unblock 2 sessions? [y/N] "]);
        expect(isSessionBlockedSync(dir, "parent")).toBe(false);
        expect(isSessionBlockedSync(dir, "child")).toBe(false);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("unblock refuses without a terminal and keeps the block", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vera-cli-unblock-"));
    try {
        await writeSessionBlock(dir, {
            version: 1,
            session_id: "parent",
            root_session_id: "parent",
            blocked_at: "2026-11-07T10:00:00.000Z",
            reason: null,
        });
        const run = harness(dir, { hasTerminal: false });
        expect(await runUnblockCommand(["unblock", "parent"], run.deps)).toBe(1);
        expect(run.err.join("")).toBe("vera unblock needs a terminal to confirm.\n");
        expect(isSessionBlockedSync(dir, "parent")).toBe(true);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
