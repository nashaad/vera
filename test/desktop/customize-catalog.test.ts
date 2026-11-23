import { expect, test } from "bun:test";

import {
    buildItems,
    dirname,
    folderChoices,
    groupByScope,
    kindCounts,
    scopeGroup,
    visibleItems,
    type CustomizeItem,
} from "../../clients/ui/src/customize/catalog.ts";
import type { AgentInfo, SkillInfo, SourceInfo } from "../../clients/ui/src/customize/wire.ts";
import type { FolderCustomizationsAnswer } from "../../clients/ui/src/protocol/bridge.ts";
import type { SessionRow } from "../../clients/ui/src/protocol/sessions.ts";

function skill(name: string, description = "", manualOnly = false): SkillInfo {
    return { name, description, manualOnly };
}

function agent(name: string, scope: AgentInfo["scope"], extra: Partial<AgentInfo> = {}): AgentInfo {
    return { name, scope, writable: false, ...extra };
}

function source(overrides: Partial<SourceInfo> & Pick<SourceInfo, "id" | "category" | "name">): SourceInfo {
    return { description: "", scope: "project", content: "", editable: false, ...overrides };
}

function reading(overrides: Partial<FolderCustomizationsAnswer> = {}): FolderCustomizationsAnswer {
    return { ok: true, skills: [], startsOn: "", agents: [], sources: [], warnings: [], ...overrides };
}

function row(id: string, workspace: string, updatedAt?: number): SessionRow {
    return {
        id,
        name: id,
        workspace,
        status: "idle",
        live: false,
        chat: false,
        ...(updatedAt === undefined ? {} : { updatedAt }),
    };
}

function fixture(): CustomizeItem[] {
    const folder = reading({
        skills: [skill("review", "Review a diff", true), skill("notes", "Take notes")],
        startsOn: "planner",
        agents: [agent("planner", "project", { description: "Plans work" }), agent("scout", "user")],
        sources: [
            source({ id: "skills:review", category: "skills", name: "review", scope: "user", content: "# Review" }),
            source({ id: "skills:notes", category: "skills", name: "notes", scope: "project", path: "/w/.vera/skills/notes/SKILL.md" }),
            source({ id: "agents:planner", category: "agents", name: "planner", scope: "project", path: "/w/.vera/agents/planner.md" }),
            source({ id: "agents:scout", category: "agents", name: "scout", scope: "user" }),
            source({ id: "instructions:/w/AGENTS.md", category: "instructions", name: "AGENTS.md", scope: "project", path: "/w/AGENTS.md" }),
            source({ id: "memory:/h/MEMORY.md", category: "memory", name: "MEMORY.md", scope: "user" }),
            source({ id: "extensions:user:demo", category: "extensions", name: "demo", description: "Extension manifest", scope: "extension demo" }),
        ],
    });
    return buildItems(folder, [{ extensionId: "broken", message: "Manifest is not valid JSON" }]);
}

test("@core building items merges skill and agent sources into their cards without duplicates", () => {
    const items = fixture();
    const names = items.filter((item) => item.kind === "skills").map((item) => item.name);
    expect(names).toEqual(["review", "notes"]);
    expect(items.filter((item) => item.kind === "agents").map((item) => item.name)).toEqual(["planner", "scout"]);

    const review = items.find((item) => item.kind === "skills" && item.name === "review");
    expect(review?.source?.content).toBe("# Review");
    expect(review?.group).toBe("Your home");
    expect(review?.skill?.manualOnly).toBe(true);

    expect(items.find((item) => item.name === "planner")?.current).toBe(true);
    expect(items.find((item) => item.name === "scout")?.current).toBe(false);

    const failure = items.find((item) => item.failed);
    expect(failure).toMatchObject({ kind: "extensions", name: "broken", description: "Manifest is not valid JSON", group: "Extensions" });

    expect(new Set(items.map((item) => item.key)).size).toBe(items.length);
});

test("skill and agent sources with no card still appear once", () => {
    const folder = reading({
        skills: [skill("notes")],
        sources: [
            source({ id: "skills:notes", category: "skills", name: "notes" }),
            source({ id: "skills:off", category: "skills", name: "off", status: "disabled" }),
        ],
    });
    const items = buildItems(folder, []);
    expect(items.map((item) => item.name)).toEqual(["notes", "off"]);
    expect(items[1]?.source?.status).toBe("disabled");
});

test("an extension failure is not repeated when its manifest is also listed", () => {
    const folder = reading({
        sources: [source({ id: "extensions:user:demo", category: "extensions", name: "demo" })],
    });
    const items = buildItems(folder, [{ extensionId: "demo", message: "bad" }]);
    expect(items.filter((item) => item.name === "demo")).toHaveLength(1);
});

test("kind counts cover every item and each kind", () => {
    const counts = kindCounts(fixture());
    expect(counts).toEqual({ all: 8, skills: 2, agents: 2, extensions: 2, instructions: 1, memory: 1, plugins: 0 });
});

test("the query matches names and descriptions and the kind filter narrows the list", () => {
    const items = fixture();
    expect(visibleItems(items, "all", "  REVIEW ").map((item) => item.name)).toEqual(["review"]);
    expect(visibleItems(items, "skills", "notes").map((item) => item.name)).toEqual(["notes"]);
    expect(visibleItems(items, "agents", "plans").map((item) => item.name)).toEqual(["planner"]);
    expect(visibleItems(items, "memory", "review")).toEqual([]);
});

test("scope groups follow the fixed order and drop empty groups", () => {
    const sections = groupByScope(fixture());
    expect(sections.map((section) => section.group)).toEqual(["This folder", "Your home", "Extensions"]);
    expect(sections[0]?.items.map((item) => item.name)).toEqual(["notes", "planner", "AGENTS.md"]);
});

test("plugin source rows keep their metadata and sort after existing kinds in Other", () => {
    const pluginSource = source({
        id: "plugins:sea-chest",
        category: "plugins",
        name: "sea-chest",
        scope: "plugin",
        plugin: "sea-chest",
        status: "enabled",
    });
    const items = buildItems(reading({
        skills: [{ ...skill("plunder"), plugin: "sea-chest" }],
        agents: [agent("lookout", "plugin", { plugin: "sea-chest" })],
        sources: [
            pluginSource,
            source({ id: "skills:plunder", category: "skills", name: "plunder", scope: "plugin sea-chest", plugin: "sea-chest" }),
            source({ id: "agents:lookout", category: "agents", name: "lookout", scope: "plugin sea-chest", plugin: "sea-chest" }),
        ],
    }), []);

    const plugin = items.find((item) => item.kind === "plugins");
    expect(plugin).toMatchObject({ kind: "plugins", name: "sea-chest", group: "Other", source: pluginSource });
    expect(plugin?.source?.plugin).toBe("sea-chest");
    expect(items.find((item) => item.name === "lookout")).toMatchObject({
        kind: "agents", group: "Other", agent: { scope: "plugin", plugin: "sea-chest" },
    });
    expect(items.find((item) => item.name === "plunder")?.skill?.plugin).toBe("sea-chest");
    expect(groupByScope(items).find((section) => section.group === "Other")?.items.map((item) => item.kind))
        .toEqual(["skills", "agents", "plugins"]);
});

test("scope strings map to readable group names", () => {
    expect(scopeGroup("project")).toBe("This folder");
    expect(scopeGroup("user")).toBe("Your home");
    expect(scopeGroup("extension")).toBe("Extensions");
    expect(scopeGroup("extension demo")).toBe("Extensions");
    expect(scopeGroup("system")).toBe("Built in");
    expect(scopeGroup("plugin")).toBe("Other");
    expect(scopeGroup(undefined)).toBe("Other");
});

test("@core folders are the distinct workspaces, newest first, capped", () => {
    const rows = [
        row("a", "/w/alpha", 100),
        row("b", "/w/beta", 300),
        row("c", "/w/alpha", 200),
        row("d", "", 999),
        row("e", "/w/gamma"),
    ];
    expect(folderChoices(rows)).toEqual(["/w/beta", "/w/alpha", "/w/gamma"]);
    expect(folderChoices(rows, 2)).toEqual(["/w/beta", "/w/alpha"]);
    expect(folderChoices([])).toEqual([]);
});

test("@core a chat's own folder is not offered as a folder", () => {
    const rows = [{ ...row("c", "/h/sessions/c.jsonl.files", 900), chat: true }, row("a", "/w/alpha", 100)];
    expect(folderChoices(rows)).toEqual(["/w/alpha"]);
});

test("dirname splits on both slash styles", () => {
    expect(dirname("/Users/me/project/.vera/AGENTS.md")).toBe("/Users/me/project/.vera");
    expect(dirname("C:\\work\\project\\AGENTS.md")).toBe("C:\\work\\project");
    expect(dirname("/AGENTS.md")).toBe("/");
    expect(dirname("AGENTS.md")).toBe(".");
});
