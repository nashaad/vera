import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    ImportableSessionScanner,
    claudeCodeFolderName,
    importRootsFrom,
    type ImportRoots,
} from "../../src/session-import/discover.ts";
import { probeImportSource } from "../../src/session-import/index.ts";

type Record = { readonly [key: string]: unknown };

const temporary: string[] = [];

afterEach(async () => {
    await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function roots(): Promise<ImportRoots> {
    const base = await mkdtemp(join(tmpdir(), "vera-discover-"));
    temporary.push(base);
    return { claudeCode: join(base, "claude", "projects"), codex: join(base, "codex", "sessions") };
}

function lines(records: readonly Record[]): string {
    return records.map((record) => JSON.stringify(record)).join("\n") + "\n";
}

function claudeCode(cwd: string, sessionId: string, text: string, extra: readonly Record[] = []): string {
    return lines([
        {
            type: "user",
            uuid: `${sessionId}-u1`,
            parentUuid: null,
            sessionId,
            cwd,
            timestamp: "2026-09-01T10:00:00.000Z",
            message: { role: "user", content: text },
        },
        {
            type: "assistant",
            uuid: `${sessionId}-a1`,
            parentUuid: `${sessionId}-u1`,
            sessionId,
            cwd,
            timestamp: "2026-09-01T10:00:01.000Z",
            message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
        },
        ...extra,
    ]);
}

function codex(cwd: string, id: string, text: string, source: unknown = "cli"): string {
    return lines([
        { type: "session_meta", timestamp: "2026-09-02T09:00:00.000Z", payload: { id, cwd, timestamp: "2026-09-02T09:00:00.000Z", source } },
        {
            type: "response_item",
            timestamp: "2026-09-02T09:00:01.000Z",
            payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
        },
    ]);
}

async function put(path: string, content: string, mtimeSeconds: number): Promise<void> {
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, content);
    await utimes(path, mtimeSeconds, mtimeSeconds);
}

test("roots come from the environment, then the home folder", () => {
    expect(importRootsFrom({}, "/home/u")).toEqual({
        claudeCode: "/home/u/.claude/projects",
        codex: "/home/u/.codex/sessions",
    });
    expect(importRootsFrom({ CLAUDE_CONFIG_DIR: "/c", CODEX_HOME: "/x" }, "/home/u")).toEqual({
        claudeCode: "/c/projects",
        codex: "/x/sessions",
    });
});

test("folder names follow Claude Code's encoding", () => {
    expect(claudeCodeFolderName("/Users/n/Projects/vera/.worktrees/imp"))
        .toBe("-Users-n-Projects-vera--worktrees-imp");
});

test("sessions from both tools are listed newest first with their facts", async () => {
    const dirs = await roots();
    const ccPath = join(dirs.claudeCode, claudeCodeFolderName("/work/a"), "s1.jsonl");
    await put(ccPath, claudeCode("/work/a", "cc-1", "fix the build", [
        { type: "custom-title", customTitle: "Build fix", sessionId: "cc-1" },
    ]), 1_000);
    const cxPath = join(dirs.codex, "2026", "09", "02", "rollout-x.jsonl");
    await put(cxPath, codex("/work/b", "cx-1", "add a test"), 2_000);

    const listed = await new ImportableSessionScanner(dirs).list();
    expect(listed.truncated).toBe(false);
    expect(listed.sessions).toEqual([
        {
            tool: "codex",
            path: cxPath,
            sourceSessionId: "cx-1",
            workspace: "/work/b",
            updatedAt: new Date(2_000_000).toISOString(),
            startedAt: "2026-09-02T09:00:00.000Z",
            firstMessage: "add a test",
        },
        {
            tool: "claude-code",
            path: ccPath,
            sourceSessionId: "cc-1",
            workspace: "/work/a",
            updatedAt: new Date(1_000_000).toISOString(),
            startedAt: "2026-09-01T10:00:00.000Z",
            title: "Build fix",
            firstMessage: "fix the build",
        },
    ]);
});

test("a workspace keeps only sessions whose recorded folder matches exactly", async () => {
    const dirs = await roots();
    await put(join(dirs.claudeCode, claudeCodeFolderName("/work/a"), "s1.jsonl"),
        claudeCode("/work/a", "cc-1", "mine"), 1_000);
    // Same encoded folder name, different real folder.
    await put(join(dirs.claudeCode, claudeCodeFolderName("/work/a"), "s2.jsonl"),
        claudeCode("/work-a", "cc-2", "collides"), 1_100);
    await put(join(dirs.claudeCode, claudeCodeFolderName("/work/b"), "s3.jsonl"),
        claudeCode("/work/b", "cc-3", "other"), 1_200);
    await put(join(dirs.codex, "2026", "09", "02", "r1.jsonl"), codex("/work/a", "cx-1", "codex mine"), 1_300);
    await put(join(dirs.codex, "2026", "09", "02", "r2.jsonl"), codex("/work/b", "cx-2", "codex other"), 1_400);

    const listed = await new ImportableSessionScanner(dirs).list("/work/a");
    expect(listed.sessions.map((session) => session.sourceSessionId)).toEqual(["cx-1", "cc-1"]);
});

test("files that are not sessions, subagents and empty sessions are skipped", async () => {
    const dirs = await roots();
    const folder = join(dirs.claudeCode, "-work-a");
    await put(join(folder, ".DS_Store"), "junk", 1_000);
    await put(join(folder, "notes.jsonl"), lines([{ hello: "world" }]), 1_100);
    await put(join(folder, "meta-only.jsonl"), lines([{
        type: "user", uuid: "m", parentUuid: null, sessionId: "cc-m", cwd: "/work/a", isMeta: true,
        timestamp: "2026-09-01T10:00:00.000Z", message: { role: "user", content: "meta" },
    }]), 1_200);
    await put(join(folder, "cc-9", "subagents", "agent-1.jsonl"), claudeCode("/work/a", "cc-9", "sub"), 1_300);
    await put(join(dirs.codex, "2026", "09", "02", "r1.jsonl"),
        codex("/work/a", "cx-sub", "The following is the Codex agent history", { subagent: { other: "guardian" } }), 1_400);
    await put(join(folder, "real.jsonl"), claudeCode("/work/a", "cc-1", "real"), 1_500);

    const listed = await new ImportableSessionScanner(dirs).list();
    expect(listed.sessions.map((session) => session.sourceSessionId)).toEqual(["cc-1"]);
});

test("a large session with no typed message in its head is still listed, without a preview", async () => {
    const dirs = await roots();
    const filler = lines(Array.from({ length: 40 }, (_, index) => ({
        type: "user",
        uuid: `m${index}`,
        parentUuid: index === 0 ? null : `m${index - 1}`,
        sessionId: "cc-big",
        cwd: "/work/a",
        isMeta: true,
        timestamp: "2026-09-01T10:00:00.000Z",
        message: { role: "user", content: "x".repeat(1_000) },
    })));
    await put(join(dirs.claudeCode, "-work-a", "big.jsonl"), filler + claudeCode("/work/a", "cc-big", "late"), 1_000);

    const listed = await new ImportableSessionScanner(dirs, { headBytes: 4_096, deepBytes: 8_192 }).list();
    expect(listed.sessions).toHaveLength(1);
    expect(listed.sessions[0]!.sourceSessionId).toBe("cc-big");
    expect(listed.sessions[0]!.firstMessage).toBeUndefined();
});

test("a title written at the end of a long file is found", async () => {
    const dirs = await roots();
    const middle = lines(Array.from({ length: 20 }, (_, index) => ({ type: "progress", n: index, pad: "y".repeat(1_000) })));
    await put(join(dirs.claudeCode, "-work-a", "s.jsonl"), claudeCode("/work/a", "cc-1", "hi") + middle
        + lines([{ type: "ai-title", aiTitle: "Late title", sessionId: "cc-1" }]), 1_000);

    const listed = await new ImportableSessionScanner(dirs, { headBytes: 4_096, tailBytes: 2_048 }).list();
    expect(listed.sessions[0]!.title).toBe("Late title");
});

test("the listing stops at the limit and says so", async () => {
    const dirs = await roots();
    for (let index = 0; index < 3; index += 1) {
        await put(join(dirs.claudeCode, "-work-a", `s${index}.jsonl`),
            claudeCode("/work/a", `cc-${index}`, `m${index}`), 1_000 + index);
    }
    const listed = await new ImportableSessionScanner(dirs, { limit: 2 }).list();
    expect(listed.sessions.map((session) => session.sourceSessionId)).toEqual(["cc-2", "cc-1"]);
    expect(listed.truncated).toBe(true);
});

test("the first message is cut to 200 characters", async () => {
    const dirs = await roots();
    await put(join(dirs.claudeCode, "-work-a", "s.jsonl"), claudeCode("/work/a", "cc-1", "é".repeat(300)), 1_000);
    const listed = await new ImportableSessionScanner(dirs).list();
    expect(listed.sessions[0]!.firstMessage).toBe("é".repeat(200));
});

test("a changed file is read again", async () => {
    const dirs = await roots();
    const path = join(dirs.claudeCode, "-work-a", "s.jsonl");
    await put(path, claudeCode("/work/a", "cc-1", "before"), 1_000);
    const scanner = new ImportableSessionScanner(dirs);
    expect((await scanner.list()).sessions[0]!.firstMessage).toBe("before");
    await put(path, claudeCode("/work/a", "cc-1", "after!"), 2_000);
    expect((await scanner.list()).sessions[0]!.firstMessage).toBe("after!");
});

test("missing roots list nothing", async () => {
    const dirs = await roots();
    expect(await new ImportableSessionScanner(dirs).list()).toEqual({ sessions: [], truncated: false });
});

test("the probe keeps source facts when nothing was typed", () => {
    expect(probeImportSource(lines([{
        type: "user", uuid: "m", parentUuid: null, sessionId: "cc-m", cwd: "/w", isMeta: true,
        timestamp: "2026-09-01T10:00:00.000Z", message: { role: "user", content: "meta" },
    }]))).toEqual({ tool: "claude-code", sourceSessionId: "cc-m", cwd: "/w", startedAt: "2026-09-01T10:00:00.000Z" });
    expect(probeImportSource("not json")).toBeUndefined();
});
