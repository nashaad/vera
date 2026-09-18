import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listAgentsThroughHost } from "../../src/host/agent-list-client.ts";
import { parseHostRequest } from "../../src/host/protocol.ts";
import { startResidentHost } from "../../src/host/runtime.ts";
import {
    describeImportRejection,
    importSessionThroughHost,
    listImportableSessionsThroughHost,
    resolveImportPath,
} from "../../src/host/session-import-client.ts";
import { SessionImportNotes } from "../../src/host/session-import-note.ts";
import { exportSession } from "../../src/session-export.ts";
import { readSessionSnapshot } from "../../src/store/session-store.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";

function claudeCodeSession(reply: string): string {
    const base = {
        sessionId: "cc-session",
        cwd: "/work/project",
        isSidechain: false,
    };
    return [
        { type: "custom-title", customTitle: "Fix the build", sessionId: "cc-session" },
        {
            ...base,
            type: "user",
            uuid: "u1",
            parentUuid: null,
            timestamp: "2026-09-01T10:00:00.000Z",
            message: { role: "user", content: "fix the build" },
        },
        {
            ...base,
            type: "assistant",
            uuid: "a1",
            parentUuid: "u1",
            timestamp: "2026-09-01T10:00:05.000Z",
            message: { role: "assistant", content: [{ type: "text", text: reply }] },
        },
    ].map((record) => JSON.stringify(record)).join("\n") + "\n";
}

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "resident host imports a Claude Code session once and lists it as imported",
    async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-session-import-"));
        const socketPath = join(root, "host.sock");
        const source = join(root, "cc-session.jsonl");
        await writeFile(source, claudeCodeSession("Looking now."));
        const host = await startResidentHost({
            config: {
                schema_version: 1,
                provider: "openrouter",
                model: "faux/test",
                approval_mode: "auto",
            },
            createAdapter: () => new FauxAdapter([]),
            socketPath,
            lockPath: join(root, "host.json"),
            sessionDirectory: join(root, "sessions"),
            eventLogDirectory: join(root, "logs"),
        });
        try {
            const first = await importSessionThroughHost(socketPath, source);
            if (first.status !== "imported") throw new Error(first.reason);
            expect(first.existing).toBe(false);

            const again = await importSessionThroughHost(socketPath, source);
            expect(again).toEqual({ ...first, existing: true });

            const listed = (await listAgentsThroughHost(socketPath))
                .find((agent) => agent.id === first.sessionId);
            expect(listed?.title).toBe("Fix the build");
            expect(listed?.workspace).toBe("/work/project");
            expect(listed?.imported_from).toMatchObject({
                tool: "claude-code",
                source_session_id: "cc-session",
                source_started_at: "2026-09-01T10:00:00.000Z",
                message_count: 2,
            });

            const snapshot = await readSessionSnapshot(first.sessionPath);
            const reply = snapshot.messages[1];
            expect(reply?.role).toBe("assistant");
            if (reply?.role === "assistant") {
                expect(reply.source.api).toBe("none");
                expect(reply.usage.totalTokens).toBe(0);
            }

            await writeFile(source, claudeCodeSession("Looking again."));
            const changed = await importSessionThroughHost(socketPath, source);
            if (changed.status !== "imported") throw new Error(changed.reason);
            expect(changed.existing).toBe(false);
            expect(changed.sessionId).not.toBe(first.sessionId);

            const exported = JSON.parse(await exportSession(first.sessionPath, "json"));
            expect(exported.session.imported_from).toMatchObject({
                tool: "claude-code",
                source_session_id: "cc-session",
                message_count: 2,
            });
            const markdown = await exportSession(first.sessionPath);
            expect(markdown).toContain(
                "- Imported from: Claude Code session ` cc-session `, first 2 messages",
            );
            expect(markdown).toContain("## Claude Code\n\n> Looking now.");
            expect(markdown).not.toContain("## Vera");
        } finally {
            await host.close();
            await rm(root, { recursive: true, force: true });
        }
    },
);

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "resident host rejects files it cannot import",
    async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-session-import-"));
        const socketPath = join(root, "host.sock");
        const host = await startResidentHost({
            config: {
                schema_version: 1,
                provider: "openrouter",
                model: "faux/test",
                approval_mode: "auto",
            },
            createAdapter: () => new FauxAdapter([]),
            socketPath,
            lockPath: join(root, "host.json"),
            sessionDirectory: join(root, "sessions"),
            eventLogDirectory: join(root, "logs"),
        });
        try {
            expect(await importSessionThroughHost(socketPath, join(root, "missing.jsonl")))
                .toEqual({ status: "rejected", reason: "unreadable" });
            const notes = join(root, "notes.jsonl");
            await writeFile(notes, '{"hello":"world"}\n');
            expect(await importSessionThroughHost(socketPath, notes))
                .toEqual({ status: "rejected", reason: "unrecognized" });
            expect(await listAgentsThroughHost(socketPath)).toEqual([]);
        } finally {
            await host.close();
            await rm(root, { recursive: true, force: true });
        }
    },
);

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "resident host lists sessions on disk and marks the ones already imported",
    async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-session-import-"));
        const socketPath = join(root, "host.sock");
        const projects = join(root, "claude", "projects");
        const source = join(projects, "-work-project", "cc-session.jsonl");
        await mkdir(join(projects, "-work-project"), { recursive: true });
        await writeFile(source, claudeCodeSession("Looking now."));
        const host = await startResidentHost({
            config: {
                schema_version: 1,
                provider: "openrouter",
                model: "faux/test",
                approval_mode: "auto",
            },
            createAdapter: () => new FauxAdapter([]),
            socketPath,
            lockPath: join(root, "host.json"),
            sessionDirectory: join(root, "sessions"),
            eventLogDirectory: join(root, "logs"),
            importRoots: { claudeCode: projects, codex: join(root, "codex", "sessions") },
        });
        try {
            const before = await listImportableSessionsThroughHost(socketPath, "/work/project");
            expect(before?.truncated).toBe(false);
            expect(before?.sessions).toEqual([{
                tool: "claude-code",
                path: source,
                source_session_id: "cc-session",
                workspace: "/work/project",
                updated_at: expect.any(String),
                started_at: "2026-09-01T10:00:00.000Z",
                title: "Fix the build",
                first_message: "fix the build",
            }]);
            expect((await listImportableSessionsThroughHost(socketPath, "/elsewhere"))?.sessions)
                .toEqual([]);

            const imported = await importSessionThroughHost(socketPath, source);
            if (imported.status !== "imported") throw new Error(imported.reason);
            const after = await listImportableSessionsThroughHost(socketPath);
            expect(after?.sessions[0]?.imported_session_id).toBe(imported.sessionId);
        } finally {
            await host.close();
            await rm(root, { recursive: true, force: true });
        }
    },
);

test("listing requests take an optional absolute workspace", () => {
    expect(parseHostRequest('{"type":"list_importable_sessions"}'))
        .toEqual({ type: "list_importable_sessions" });
    expect(parseHostRequest('{"type":"list_importable_sessions","workspace":"/w"}'))
        .toEqual({ type: "list_importable_sessions", workspace: "/w" });
    expect(parseHostRequest('{"type":"list_importable_sessions","workspace":"w"}'))
        .toBeUndefined();
    expect(parseHostRequest('{"type":"list_importable_sessions","workspace":7}'))
        .toBeUndefined();
});

test("listing client reports a host it cannot reach as undefined", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-session-import-"));
    try {
        expect(await listImportableSessionsThroughHost(join(root, "missing.sock"))).toBeUndefined();
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("import client reports a host it cannot reach as failed", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-session-import-"));
    try {
        expect(await importSessionThroughHost(join(root, "missing.sock"), "/x.jsonl"))
            .toEqual({ status: "rejected", reason: "failed" });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("import requests carry an absolute path", () => {
    expect(parseHostRequest('{"type":"import_session","path":"/a/b.jsonl"}'))
        .toEqual({ type: "import_session", path: "/a/b.jsonl" });
    expect(parseHostRequest('{"type":"import_session","path":"b.jsonl"}'))
        .toBeUndefined();
    expect(parseHostRequest('{"type":"import_session","path":""}'))
        .toBeUndefined();
    expect(parseHostRequest('{"type":"import_session"}')).toBeUndefined();
    expect(resolveImportPath("b.jsonl", "/work")).toBe("/work/b.jsonl");
    expect(resolveImportPath("/a/b.jsonl", "/work")).toBe("/a/b.jsonl");
});

test("import rejections read as the contract words them", () => {
    expect(describeImportRejection("x.jsonl", "unreadable")).toBe("Cannot read x.jsonl.");
    expect(describeImportRejection("x.jsonl", "unrecognized"))
        .toBe("x.jsonl is not a Claude Code or Codex session.");
    expect(describeImportRejection("x.jsonl", "empty"))
        .toBe("x.jsonl has no messages to import.");
});

test("an imported session tells the model where its earlier turns came from", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-session-import-"));
    try {
        const source = join(root, "cc.jsonl");
        await writeFile(source, claudeCodeSession("Looking now."));
        const { importSessionFile } = await import(
            "../../src/host/session-import-service.ts"
        );
        const outcome = await importSessionFile(source, {
            sessionDirectory: root,
            indexed: [],
            createSessionId: () => "imported",
        });
        expect(outcome.status).toBe("imported");
        const notes = new SessionImportNotes((id) => join(root, `${id}.jsonl`));
        const [note] = await notes.contributions("imported");
        expect(note?.target).toBe("contextual");
        expect(note?.content).toStartWith(
            "Earlier turns in this conversation were imported from Claude Code.",
        );
        expect(await notes.contributions("native")).toEqual([]);
        expect(await notes.contributions(undefined)).toEqual([]);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
