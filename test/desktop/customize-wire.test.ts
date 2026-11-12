import { expect, test } from "bun:test";

import { parseFailures } from "../../clients/desktop/src/extension-requests.ts";
import {
    IDLE_PROBE,
    probeFailed,
    probeIds,
    probeTarget,
    reduceProbe,
    startProbe,
} from "../../clients/ui/src/customize/probe.ts";
import {
    CATALOG_LIMIT,
    listSkillsCommand,
    parseCatalogLine,
    selectAgentCommand,
} from "../../clients/ui/src/customize/wire.ts";
import type { SessionRow } from "../../clients/ui/src/protocol/sessions.ts";

function frame(value: unknown): string {
    return JSON.stringify(value);
}

test("catalog requests are one JSON line each", () => {
    expect(listSkillsCommand("r1")).toBe("{\"type\":\"list_skills\",\"requestId\":\"r1\"}\n");
    expect(JSON.parse(selectAgentCommand("r2", "planner"))).toEqual({ type: "select_agent", requestId: "r2", name: "planner" });
});

test("@core a skill catalog keeps named skills and marks the ones only a person can run", () => {
    const reply = parseCatalogLine(frame({
        type: "skill_catalog",
        requestId: "s",
        skills: [
            { name: "review", description: "Reviews a diff", disableModelInvocation: false },
            { name: "deploy", description: "Ships", disableModelInvocation: true },
            { description: "no name" },
        ],
        warnings: ["one skill had no description"],
        seq: 4,
    }));
    expect(reply).toEqual({
        type: "skills",
        requestId: "s",
        skills: [
            { name: "review", description: "Reviews a diff", manualOnly: false },
            { name: "deploy", description: "Ships", manualOnly: true },
        ],
        warnings: ["one skill had no description"],
    });
});

test("an agent catalog reads scope, tools and the default model, and skips unknown scopes", () => {
    const reply = parseCatalogLine(frame({
        type: "agent_catalog",
        requestId: "a",
        selected: "planner",
        agents: [
            { name: "planner", scope: "project", writable: true, tools: ["read"], defaultPair: { name: "crow-0", effort: "high" } },
            { name: "ghost", scope: "elsewhere", writable: false },
        ],
        notices: [],
    }));
    if (reply?.type !== "agents") throw new Error("expected agents");
    expect(reply.selected).toBe("planner");
    expect(reply.agents).toEqual([
        { name: "planner", scope: "project", writable: true, tools: ["read"], defaultModel: "crow-0", defaultEffort: "high" },
    ]);
});

test("customization sources are cut to the catalog limit and their text is capped", () => {
    const sources = Array.from({ length: CATALOG_LIMIT + 3 }, (_, index) => ({
        id: `s${index}`,
        category: "instructions",
        name: `rules ${index}`,
        description: "",
        scope: "project",
        content: index === 0 ? "x".repeat(30_000) : "short",
        editable: true,
        contextIds: [],
    }));
    const reply = parseCatalogLine(frame({ type: "customization_sources", requestId: "c", catalog: { sources, warnings: [] } }));
    if (reply?.type !== "sources") throw new Error("expected sources");
    expect(reply.sources.length).toBe(CATALOG_LIMIT);
    expect(reply.sources[0]?.content.length).toBe(20_000);
});

test("agent selection replies carry the name or the reason", () => {
    expect(parseCatalogLine(frame({ type: "agent_selected", requestId: "x", name: "planner", notice: "" })))
        .toEqual({ type: "agent_selected", requestId: "x", name: "planner" });
    expect(parseCatalogLine(frame({ type: "agent_rejected", requestId: "x", reason: "No agent named ghost." })))
        .toEqual({ type: "agent_rejected", requestId: "x", reason: "No agent named ghost." });
    expect(parseCatalogLine("not json")).toBeUndefined();
    expect(parseCatalogLine(frame({ type: "history", requestId: "x" }))).toBeUndefined();
});

test("@core the probe is ready only when all three of its own replies arrived", () => {
    const ids = probeIds("t");
    let state = startProbe("agent-1");
    state = reduceProbe(state, ids, { type: "skills", requestId: "someone-else", skills: [], warnings: [] });
    expect(state.skills).toBeUndefined();
    state = reduceProbe(state, ids, { type: "skills", requestId: ids.skills, skills: [], warnings: ["w"] });
    state = reduceProbe(state, ids, { type: "sources", requestId: ids.sources, sources: [], warnings: [] });
    expect(state.phase).toBe("loading");
    state = reduceProbe(state, ids, { type: "agents", requestId: ids.agents, selected: "", agents: [], notices: ["n"] });
    expect(state.phase).toBe("ready");
    expect(state.warnings).toEqual(["w", "n"]);
    expect(probeFailed(state, "late").phase).toBe("ready");
    expect(probeFailed(startProbe("a"), "timed out")).toEqual({ phase: "failed", agentId: "a", warnings: [], error: "timed out" });
    expect(reduceProbe(IDLE_PROBE, ids, { type: "skills", requestId: ids.skills, skills: [], warnings: [] })).toBe(IDLE_PROBE);
});

function row(id: string, extra: Partial<SessionRow> = {}): SessionRow {
    return { id, name: id, workspace: "/p/crow", status: "idle", live: false, chat: false, ...extra };
}

test("the probe reads through a live top-level session in the folder before a newer parked one", () => {
    const rows = [
        row("parked", { updatedAt: 9 }),
        row("live", { updatedAt: 2, live: true }),
        row("child", { updatedAt: 10, live: true, parentId: "live" }),
        row("elsewhere", { workspace: "/p/heron", live: true, updatedAt: 20 }),
    ];
    expect(probeTarget(rows, "/p/crow")?.id).toBe("live");
    expect(probeTarget(rows)?.id).toBe("elsewhere");
    expect(probeTarget(rows, "/p/none")).toBeUndefined();
    expect(probeTarget([row("a", { updatedAt: 1 }), row("b", { updatedAt: 5 })], "/p/crow")?.id).toBe("b");
});

test("a chat is never the probe target", () => {
    const rows = [row("chat", { workspace: "/h/c.jsonl.files", live: true, updatedAt: 50, chat: true }), row("a", { updatedAt: 1 })];
    expect(probeTarget(rows)?.id).toBe("a");
    expect(probeTarget(rows, "/h/c.jsonl.files")).toBeUndefined();
});

test("extension failures parse into ids and messages, and a malformed entry refuses the reply", () => {
    expect(parseFailures([{ extension_id: "notes", message: "manifest missing" }]))
        .toEqual([{ extensionId: "notes", message: "manifest missing" }]);
    expect(parseFailures([])).toEqual([]);
    expect(parseFailures([{ extension_id: 3, message: "x" }])).toBeUndefined();
    expect(parseFailures("nope")).toBeUndefined();
});
