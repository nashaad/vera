import { expect, test } from "bun:test";

import { parseFailures } from "../../clients/desktop/src/extension-requests.ts";
import {
    CATALOG_LIMIT,
    listSkillsCommand,
    parseCatalogLine,
    selectAgentCommand,
} from "../../clients/ui/src/customize/wire.ts";

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

test("@core plugin catalogs name the plugin on skills, agents and sources", () => {
    const skills = parseCatalogLine(frame({
        type: "skill_catalog",
        requestId: "s",
        skills: [{ name: "plunder", description: "Takes the cargo", disableModelInvocation: false, plugin: "sea-chest" }],
        warnings: [],
    }));
    if (skills?.type !== "skills") throw new Error("expected skills");
    expect(skills.skills[0]?.plugin).toBe("sea-chest");

    const agents = parseCatalogLine(frame({
        type: "agent_catalog",
        requestId: "a",
        selected: "default",
        agents: [{ name: "lookout", scope: "plugin", writable: false, plugin: "sea-chest" }],
        notices: [],
    }));
    if (agents?.type !== "agents") throw new Error("expected agents");
    expect(agents.agents[0]).toMatchObject({ scope: "plugin", writable: false, plugin: "sea-chest" });

    const sources = parseCatalogLine(frame({
        type: "customization_sources",
        requestId: "c",
        catalog: {
            sources: [
                { id: "plugins:sea-chest", category: "plugins", name: "sea-chest", description: "skills:1", scope: "plugin", content: "", editable: false, status: "enabled", plugin: "sea-chest" },
                { id: "skills:plunder", category: "skills", name: "plunder", description: "Takes the cargo", scope: "plugin sea-chest", content: "", editable: false, plugin: "sea-chest" },
            ],
            warnings: [],
        },
    }));
    if (sources?.type !== "sources") throw new Error("expected sources");
    expect(sources.sources[0]).toMatchObject({ category: "plugins", plugin: "sea-chest" });
    expect(sources.sources[1]).toMatchObject({ category: "skills", plugin: "sea-chest" });
});

test("agent selection replies carry the name or the reason", () => {
    expect(parseCatalogLine(frame({ type: "agent_selected", requestId: "x", name: "planner", notice: "" })))
        .toEqual({ type: "agent_selected", requestId: "x", name: "planner" });
    expect(parseCatalogLine(frame({ type: "agent_rejected", requestId: "x", reason: "No agent named ghost." })))
        .toEqual({ type: "agent_rejected", requestId: "x", reason: "No agent named ghost." });
    expect(parseCatalogLine("not json")).toBeUndefined();
    expect(parseCatalogLine(frame({ type: "history", requestId: "x" }))).toBeUndefined();
});

test("extension failures parse into ids and messages, and a malformed entry refuses the reply", () => {
    expect(parseFailures([{ extension_id: "notes", message: "manifest missing" }]))
        .toEqual([{ extensionId: "notes", message: "manifest missing" }]);
    expect(parseFailures([])).toEqual([]);
    expect(parseFailures([{ extension_id: 3, message: "x" }])).toBeUndefined();
    expect(parseFailures("nope")).toBeUndefined();
});
