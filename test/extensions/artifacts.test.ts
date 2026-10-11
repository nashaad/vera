import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { VeraAnnexPageApi, VeraAnnexRouteHandler } from "../../src/sdk/annex-pages.ts";
import type { VeraExtensionRequestHandler, VeraExtensionToolSpec } from "../../src/sdk/extensions.ts";
import type { JsonValue } from "../../src/sdk/hooks.ts";
import { markdownBlocks } from "../../src/annex/markdown-blocks.ts";
import { activate } from "../../extensions/artifacts/extension.ts";
import { activatePage, placeComments } from "../../extensions/artifacts/page-server.ts";
import { addComment, listComments, listArtifacts, writeArtifact } from "../../extensions/artifacts/artifact-store.ts";

interface PageHelpers {
    embedSource(block: { kind: string; text: string }): string | undefined;
    quoteLine(markdown: string): string;
}

// page.ts is browser code; a static import would pull it into the DOM-less typecheck.
const pagePath = "../../extensions/artifacts/page.ts";
const { embedSource, quoteLine } = await import(pagePath) as PageHelpers;

function artifactTools(profile: string, pageUrl: string | undefined) {
    const tools = new Map<string, VeraExtensionToolSpec>();
    activate({
        config: {},
        storage: { profile, machine: profile },
        annex: { pageUrl: () => pageUrl },
        tools: { register: (spec: VeraExtensionToolSpec) => tools.set(spec.name, spec) },
        requests: { handle: () => () => {} },
    } as never);
    return async (name: string, input: Record<string, unknown>, sessionId: string | null = "s1") => {
        const spec = tools.get(name);
        if (spec === undefined) throw new Error(`no tool ${name}`);
        return await spec.run({
            input,
            workspace: "/tmp",
            ...(sessionId === null ? {} : { sessionId }),
            signal: new AbortController().signal,
        });
    };
}

test("artifact tools write, edit, read, and close comments on a named artifact", async () => {
    const profile = mkdtempSync(join(tmpdir(), "artifact-tools-"));
    const run = artifactTools(profile, "http://127.0.0.1:9/x/vera.artifacts/artifacts");
    const raid = { sessionId: "s1", name: "raid" };

    expect((await run("artifact_read", {})).output).toBe("No artifacts yet.");
    expect((await run("artifact_read", { name: "raid" })).output).toContain("No artifact named raid");
    const written = await run("artifact_write", { name: "raid", markdown: "# Raid\n\n1. Find the crow's map\n2. Dig" });
    expect(written.output).toContain("http://127.0.0.1:9/x/vera.artifacts/artifacts?session=s1&artifact=raid");
    expect(written.presentation).toEqual({ kind: "tool_notice", text: "Artifact page: http://127.0.0.1:9/x/vera.artifacts/artifacts?session=s1&artifact=raid" });
    expect((await run("artifact_read", {})).output).toBe("raid");

    expect((await run("artifact_edit", { name: "raid", old_string: "Dig", new_string: "Dig at dawn" })).isError).toBeUndefined();
    expect((await run("artifact_edit", { name: "raid", old_string: "nowhere", new_string: "x" })).isError).toBe(true);

    const comment = addComment(profile, raid, { quote: "2. Dig at dawn", index: 2, body: "Bring shovels" });
    expect((await run("artifact_read", { name: "raid" })).output).toContain("1 open comment;");
    expect((await run("artifact_comments", { name: "raid", action: "list" })).output).toContain("(open)");

    await run("artifact_edit", { name: "raid", old_string: "Dig at dawn", new_string: "Dig at dusk" });
    expect((await run("artifact_comments", { name: "raid", action: "list" })).output).toContain("(open, outdated)");

    expect((await run("artifact_comments", { name: "raid", action: "close", id: comment.id })).output)
        .toBe(`Closed ${comment.id}.`);
    expect(listComments(profile, raid)[0]).toMatchObject({ status: "closed", closedBy: "agent" });
    expect((await run("artifact_comments", { name: "raid", action: "delete", id: comment.id })).output)
        .toBe(`Deleted ${comment.id}.`);
    expect(listComments(profile, raid)).toEqual([]);
});

test("artifact tools refuse bad names and missing sessions, and say when the annex is down", async () => {
    const profile = mkdtempSync(join(tmpdir(), "artifact-tools-"));
    const run = artifactTools(profile, undefined);
    expect((await run("artifact_read", {}, null)).isError).toBe(true);
    expect((await run("artifact_write", { name: "../loot", markdown: "# x" })).isError).toBe(true);
    expect((await run("artifact_write", { name: "plan", markdown: "# Plan" })).output).toContain("annex is not running");
});

test("artifacts from different sessions and names stay apart", () => {
    const profile = mkdtempSync(join(tmpdir(), "artifact-store-"));
    writeArtifact(profile, { sessionId: "s1", name: "plan" }, "# Plan one");
    writeArtifact(profile, { sessionId: "s1", name: "notes" }, "# Notes");
    writeArtifact(profile, { sessionId: "s2", name: "plan" }, "# Plan two");
    addComment(profile, { sessionId: "s2", name: "plan" }, { quote: "# Plan two", index: 0, body: "aye" });
    const artifacts = listArtifacts(profile);
    expect(artifacts.map((artifact) => `${artifact.sessionId}/${artifact.name}`).sort()).toEqual(["s1/notes", "s1/plan", "s2/plan"]);
    expect(artifacts.find((artifact) => artifact.sessionId === "s2")).toMatchObject({ title: "Plan two", openComments: 1 });
    expect(listComments(profile, { sessionId: "s1", name: "plan" })).toEqual([]);
});

test("comments sit beside the block they quote and outdated ones keep their place", () => {
    const profile = mkdtempSync(join(tmpdir(), "artifact-store-"));
    const artifact = { sessionId: "s1", name: "raid" };
    const markdown = "# Raid\n\n- Find the map\n- Dig\n\nSail home.";
    writeArtifact(profile, artifact, markdown);
    const live = addComment(profile, artifact, { quote: "- Dig", index: 1, body: "where?" });
    const stale = addComment(profile, artifact, { quote: "- Bury the crow", index: 9, body: "no" });
    const blocks = markdownBlocks(markdown);
    const placed = placeComments([live, stale], markdown, blocks);
    expect(placed.map((comment) => [comment.outdated, comment.blockIndex])).toEqual([
        [false, 2],
        [true, blocks.length - 1],
    ]);
});

test("send-comment hands the session the comment and where it was left", async () => {
    const profile = mkdtempSync(join(tmpdir(), "artifact-send-"));
    const handlers = new Map<string, VeraExtensionRequestHandler>();
    const sent: [string, string][] = [];
    activate({
        config: {},
        storage: { profile, machine: profile },
        annex: { pageUrl: () => undefined },
        tools: { register: () => () => {} },
        requests: { handle: (name: string, handler: VeraExtensionRequestHandler) => handlers.set(name, handler) },
        sessions: {
            send: async (sessionId: string, text: string) => {
                sent.push([sessionId, text]);
                return sessionId === "s1" ? "queued" : "not_found";
            },
        },
    } as never);
    const sendComment = handlers.get("send-comment")!;
    const signal = new AbortController().signal;
    const artifact = { sessionId: "s1", name: "raid" };
    writeArtifact(profile, artifact, "# Raid\n\n- Dig under the crow's nest");
    const comment = addComment(profile, artifact, { quote: "- Dig under the crow's nest", index: 1, body: "Dig at low tide" });

    expect(await sendComment({ session: "s1", artifact: "raid", id: comment.id }, { signal })).toBe("queued");
    expect(sent[0]![0]).toBe("s1");
    expect(sent[0]![1]).toContain("on artifact raid, on: - Dig under the crow's nest");
    expect(sent[0]![1]).toContain("Dig at low tide");
    expect(sent[0]![1]).toContain(comment.id);

    await expect(Promise.resolve(sendComment({ session: "s1", artifact: "raid", id: "c-nope" }, { signal })))
        .rejects.toThrow("No comment c-nope");
    await expect(Promise.resolve(sendComment({ session: "s1", artifact: "../x", id: comment.id }, { signal })))
        .rejects.toThrow("needs a session");
});

test("a comment posted with send is saved first, then marked sent only when queued", async () => {
    const profile = mkdtempSync(join(tmpdir(), "artifact-page-"));
    const routes = new Map<string, VeraAnnexRouteHandler>();
    let answer: () => Promise<JsonValue> = async () => "queued";
    const asked: JsonValue[] = [];
    activatePage({
        extensionId: "vera.artifacts",
        pageId: "artifacts",
        storage: { profile, machine: profile },
        route: (path: string, handler: VeraAnnexRouteHandler) => routes.set(path, handler),
        markdownBlocks,
        host: {
            request: async (name: string, payload?: JsonValue) => {
                asked.push({ name, payload: payload ?? null });
                return await answer();
            },
        },
    } as VeraAnnexPageApi);
    writeArtifact(profile, { sessionId: "s1", name: "raid" }, "# Raid\n\n- Dig");
    const post = async (body: Record<string, unknown>) => {
        const url = new URL("http://annex/api/comments");
        const request = new Request(url.href, { method: "POST", body: JSON.stringify(body) });
        return await (await routes.get("comments")!(request, url)).json() as Record<string, any>;
    };
    const base = { session: "s1", artifact: "raid", quote: "- Dig", index: 1 };

    const quiet = await post({ ...base, text: "no rush" });
    expect(quiet.sent).toBeUndefined();
    expect(asked).toEqual([]);

    const queued = await post({ ...base, text: "dig now", send: true });
    expect(queued.sent).toBe("queued");
    expect(queued.comment.sentAt).toBeString();
    expect(asked).toEqual([{ name: "send-comment", payload: { session: "s1", artifact: "raid", id: queued.comment.id } }]);

    answer = async () => "not_found";
    const closed = await post({ ...base, text: "anyone?", send: true });
    expect(closed.sent).toBe("not_found");
    expect(closed.comment.sentAt).toBeUndefined();

    answer = async () => { throw new Error("host gone"); };
    const failed = await post({ ...base, text: "caw", send: true });
    expect(failed.sent).toBe("failed");

    const saved = listComments(profile, { sessionId: "s1", name: "raid" });
    expect(Object.fromEntries(saved.map((comment) => [comment.body, comment.sentAt !== undefined]))).toEqual({
        "no rush": false,
        "dig now": true,
        "anyone?": false,
        caw: false,
    });
});

test("only a fenced html embed block runs as an embed", () => {
    const source = (markdown: string): string | undefined => {
        const [block] = markdownBlocks(markdown);
        return block === undefined ? undefined : embedSource(block);
    };
    expect(source("```html embed\n<div id=\"waves\"></div>\n<script src=\"https://unpkg.com/wavesurfer.js@7.8.6\"></script>\n```"))
        .toBe("<div id=\"waves\"></div>\n<script src=\"https://unpkg.com/wavesurfer.js@7.8.6\"></script>");
    expect(source("~~~~html embed\n<b>caw</b>\n~~~~")).toBe("<b>caw</b>");
    expect(source("```html\n<b>caw</b>\n```")).toBeUndefined();
    expect(source("<b>caw</b>")).toBeUndefined();
});

test("a comment on a code block quotes its code; one on an embed quotes nothing", () => {
    expect(quoteLine("```html embed\n<div id=\"waves\"></div>\n```")).toBe("");
    expect(quoteLine("```ts\nconst crow = \"caw\";\n```")).toBe("const crow = \"caw\";");
    expect(quoteLine("## Hoist the sails")).toBe("Hoist the sails");
});

test("the tools that write artifacts or comments declare extension.storage.write", () => {
    const operations = new Map<string, string | undefined>();
    activate({
        config: {},
        storage: { profile: "/tmp", machine: "/tmp" },
        annex: { pageUrl: () => undefined },
        tools: { register: (spec: VeraExtensionToolSpec) => operations.set(spec.name, spec.permissionOperation) },
        requests: { handle: () => () => {} },
    } as never);
    expect(Object.fromEntries(operations)).toEqual({
        artifact_read: undefined,
        artifact_write: "extension.storage.write",
        artifact_edit: "extension.storage.write",
        artifact_comments: "extension.storage.write",
    });
});
