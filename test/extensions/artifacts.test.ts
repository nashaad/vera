import { expect, test } from "bun:test";
import { mkdtempSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { VeraAnnexPageApi, VeraAnnexRouteHandler } from "../../src/sdk/annex-pages.ts";
import type { VeraExtensionRequestHandler, VeraExtensionToolSpec } from "../../src/sdk/extensions.ts";
import type { JsonValue } from "../../src/sdk/hooks.ts";
import { markdownBlocks } from "../../src/annex/markdown-blocks.ts";
import { loadExtensionManifest } from "../../src/extensions/manifest.ts";
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
    expect(written.presentation).toEqual({
        kind: "tool_notice",
        text: "Artifact page: http://127.0.0.1:9/x/vera.artifacts/artifacts?session=s1&artifact=raid",
        link: { title: "Raid", page: "artifacts", query: { session: "s1", artifact: "raid" } },
    });
    expect((await run("artifact_read", {})).output).toBe("raid");
    expect((await run("artifact_read", { name: "" })).output).toBe("raid");
    expect((await run("artifact_read", { name: null })).output).toBe("raid");

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
    const { artifacts, total } = listArtifacts(profile);
    expect(total).toBe(3);
    expect(artifacts.map((artifact) => `${artifact.sessionId}/${artifact.name}`).sort()).toEqual(["s1/notes", "s1/plan", "s2/plan"]);
    expect(artifacts.find((artifact) => artifact.sessionId === "s2")).toMatchObject({ title: "Plan two", openComments: 1 });
    expect(listComments(profile, { sessionId: "s1", name: "plan" })).toEqual([]);
});

test("the artifact list spans sessions, newest first, and reads only the page it returns", async () => {
    const profile = mkdtempSync(join(tmpdir(), "artifact-list-"));
    for (const [index, session] of ["s1", "s2", "s3", "s1", "s2"].entries()) {
        const ref = { sessionId: session, name: `note-${index}` };
        writeArtifact(profile, ref, `# Note ${index}`);
        utimesSync(join(profile, "artifacts", session, ref.name, "artifact.md"), new Date(2_000_000 + index * 1000), new Date(2_000_000 + index * 1000));
    }
    const all = listArtifacts(profile);
    expect(all.total).toBe(5);
    expect(all.artifacts.map((artifact) => artifact.name)).toEqual(["note-4", "note-3", "note-2", "note-1", "note-0"]);
    const page = listArtifacts(profile, 2);
    expect(page.total).toBe(5);
    expect(page.artifacts.map((artifact) => `${artifact.sessionId}/${artifact.name}`)).toEqual(["s2/note-4", "s1/note-3"]);
    expect(listArtifacts(profile, 10_000).artifacts).toHaveLength(5);
    expect(listArtifacts(profile, -3).artifacts).toHaveLength(1);
    expect(listArtifacts(mkdtempSync(join(tmpdir(), "artifact-none-")))).toEqual({ artifacts: [], total: 0 });

    const routes = new Map<string, VeraAnnexRouteHandler>();
    activatePage({
        extensionId: "vera.artifacts",
        pageId: "artifacts",
        storage: { profile, machine: profile },
        route: (path: string, handler: VeraAnnexRouteHandler) => routes.set(path, handler),
        markdownBlocks,
        host: { request: async () => "queued" },
    } as VeraAnnexPageApi);
    const url = new URL("http://annex/api/artifacts?limit=3");
    const body = await (await routes.get("artifacts")!(new Request(url.href), url)).json() as Record<string, any>;
    expect(body.artifacts).toHaveLength(3);
    expect(body).toMatchObject({ total: 5, limit: 200 });
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

test("artifact_read declares extension.storage.read; the tools that write declare extension.storage.write", () => {
    const operations = new Map<string, string | undefined>();
    activate({
        config: {},
        storage: { profile: "/tmp", machine: "/tmp" },
        annex: { pageUrl: () => undefined },
        tools: { register: (spec: VeraExtensionToolSpec) => operations.set(spec.name, spec.permissionOperation) },
        requests: { handle: () => () => {} },
    } as never);
    expect(Object.fromEntries(operations)).toEqual({
        artifact_read: "extension.storage.read",
        artifact_write: "extension.storage.write",
        artifact_edit: "extension.storage.write",
        artifact_comments: "extension.storage.write",
    });
});

test("@core the Artifacts page has its own pane and stays a page of the annex", () => {
    const { manifest } = loadExtensionManifest(join(import.meta.dir, "../../extensions/artifacts"));
    expect(manifest.contributes.pages).toEqual([
        { id: "artifacts", label: "Artifacts", server: "page-server.ts", browser: "page.ts", pane: true },
    ]);
});

const PAGE = "http://127.0.0.1:9/x/vera.artifacts/artifacts";

test("@core a written or edited artifact carries a link to its page, and the text the model reads is unchanged", async () => {
    const run = artifactTools(mkdtempSync(join(tmpdir(), "artifact-link-")), PAGE);
    const url = `${PAGE}?session=s1&artifact=raid`;
    const written = await run("artifact_write", { name: "raid", markdown: "Plain start\n\n# Raid plan\n" });
    expect(written.output).toBe(`Saved raid. Artifact page: ${url}`);
    expect(written.presentation).toEqual({
        kind: "tool_notice",
        text: `Artifact page: ${url}`,
        link: { title: "Raid plan", page: "artifacts", query: { session: "s1", artifact: "raid" } },
    });

    const edited = await run("artifact_edit", { name: "raid", old_string: "Raid plan", new_string: "Raid plan, take two" });
    expect(edited.output).toBe("Updated raid.");
    expect(edited.presentation).toEqual({
        kind: "tool_notice",
        text: `Artifact page: ${url}`,
        link: { title: "Raid plan, take two", page: "artifacts", query: { session: "s1", artifact: "raid" } },
    });
});

test("the card's title is the title the page lists", async () => {
    const profile = mkdtempSync(join(tmpdir(), "artifact-title-"));
    const run = artifactTools(profile, PAGE);
    for (const markdown of ["## Only a subheading\n\nbody", "no heading here", `# ${"x".repeat(200)}`]) {
        const written = await run("artifact_write", { name: "raid", markdown });
        const listed = listArtifacts(profile).artifacts.find((artifact) => artifact.name === "raid");
        expect(listed).toBeDefined();
        expect((written.presentation as { link: { title: string } }).link.title).toBe(listed!.title);
    }
});

test("@core writing and editing an artifact asks the host to show nothing", async () => {
    const profile = mkdtempSync(join(tmpdir(), "artifact-quiet-"));
    const tools = new Map<string, VeraExtensionToolSpec>();
    // The annex offers its page address and nothing else, so any other call throws.
    const annex = new Proxy({ pageUrl: () => "http://127.0.0.1:9/x/vera.artifacts/artifacts" }, {
        get: (target, key) => {
            if (key === "pageUrl") return target.pageUrl;
            throw new Error(`The artifacts extension reached for annex.${String(key)}.`);
        },
    });
    activate({
        config: {},
        storage: { profile, machine: profile },
        annex,
        tools: { register: (spec: VeraExtensionToolSpec) => tools.set(spec.name, spec) },
        requests: { handle: () => () => {} },
        sessions: { send: async () => { throw new Error("The artifacts extension sent to a session."); } },
    } as never);
    const run = async (name: string, input: Record<string, unknown>) => await tools.get(name)!.run({
        input,
        workspace: "/tmp",
        sessionId: "s1",
        signal: new AbortController().signal,
    });
    expect((await run("artifact_write", { name: "raid", markdown: "# Raid\n\nDig" })).isError).toBeUndefined();
    expect((await run("artifact_edit", { name: "raid", old_string: "Dig", new_string: "Dig deep" })).isError).toBeUndefined();
});

test("an artifact notice has no link while the annex is down, and a failed write has no notice", async () => {
    const down = await artifactTools(mkdtempSync(join(tmpdir(), "artifact-down-")), undefined)("artifact_write", { name: "raid", markdown: "# Raid" });
    expect(down.output).toContain("annex is not running");
    expect(down.presentation).toMatchObject({ kind: "tool_notice" });
    expect(JSON.stringify(down.presentation)).not.toContain("link");
    const empty = await artifactTools(mkdtempSync(join(tmpdir(), "artifact-empty-")), PAGE)("artifact_write", { name: "raid", markdown: "  " });
    expect(empty.isError).toBe(true);
    expect(empty.presentation).toBeUndefined();
    const unnamed = await artifactTools(mkdtempSync(join(tmpdir(), "artifact-noname-")), PAGE)("artifact_write", { name: "Raid!", markdown: "# Raid" });
    expect(unnamed.isError).toBe(true);
    expect(unnamed.presentation).toBeUndefined();
});

test("the Artifacts extension asks for no capability to open its page", () => {
    const { manifest } = loadExtensionManifest(join(import.meta.dir, "../../extensions/artifacts"));
    expect(manifest.capabilities).not.toContain("sessions.show");
});
