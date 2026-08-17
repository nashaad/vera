import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    DEFAULT_AGENT,
    parseAgentDefinition,
} from "../../src/agents/definition.ts";
import {
    findCatalogAgent,
    loadAgentCatalog,
} from "../../src/agents/catalog.ts";
import {
    agentAllowsSkill,
    agentAllowsTool,
    agentSnapshotDrift,
    resolveAgentSnapshot,
} from "../../src/agents/wear.ts";
import { writeAgentDefaultPair } from "../../src/agents/writer.ts";

const REVIEWER = `---
description: read-only code reviewer
tools: [read, grep, ls, bash]
skills: [code-review]
posture: readonly
default_pair: { name: sol, effort: medium }
nudges:
  - on: write
    text: "This agent is read-only. /agent default to allow writes."
---
You are a code reviewer. Read, do not modify.
`;

test("an agent is frontmatter plus a body, and the body is the instructions", () => {
    const agent = parseAgentDefinition("reviewer", REVIEWER);
    expect(agent).toEqual({
        name: "reviewer",
        description: "read-only code reviewer",
        tools: ["read", "grep", "ls", "bash"],
        skills: ["code-review"],
        posture: "readonly",
        defaultPair: { name: "sol", effort: "medium" },
        nudges: [{
            on: "write",
            text: "This agent is read-only. /agent default to allow writes.",
        }],
        instructions: "You are a code reviewer. Read, do not modify.",
    });
});

test("omitted means all, and an empty list means none", () => {
    const bare = parseAgentDefinition("bare", "just instructions");
    expect(bare.tools).toBeUndefined();
    expect(bare.skills).toBeUndefined();
    expect(agentAllowsTool(resolveAgentSnapshot(bare), "write")).toBe(true);

    const closed = parseAgentDefinition("closed", "---\ntools: []\n---\nbody");
    const snapshot = resolveAgentSnapshot(closed);
    expect(agentAllowsTool(snapshot, "read")).toBe(false);
    expect(agentAllowsSkill(snapshot, "anything")).toBe(true);
});

test("a parse error is a refusal, never a silent no-op", () => {
    expect(() => parseAgentDefinition("x", "---\nwidgets: 3\n---\nb"))
        .toThrow("unknown key");
    expect(() => parseAgentDefinition("x", "---\ncontext: fresh\n---\nb"))
        .toThrow("not yet supported");
    expect(() =>
        parseAgentDefinition("x", "---\nposture: nope\n---\nb", {
            permissionModes: ["readonly", "ask"],
        })
    ).toThrow("no permission mode named nope");
    expect(() => parseAgentDefinition("x", "---\nnudges: [{on: write}]\n---\nb"))
        .toThrow("nudge");
    // A spawn cannot show a nudge, so carrying one there is an error rather
    // than something that silently does nothing.
    expect(() => parseAgentDefinition("x", REVIEWER, { interactive: false }))
        .toThrow("interactive");
    expect(() => parseAgentDefinition("Bad Name", "body")).toThrow("must be");
});

test("an effort-less default pair is legal", () => {
    const agent = parseAgentDefinition(
        "local",
        "---\ndefault_pair: { name: qwen }\n---\nbody",
    );
    expect(agent.defaultPair).toEqual({ name: "qwen" });
});

test("context accepts only full in v1", () => {
    expect(parseAgentDefinition("x", "---\ncontext: full\n---\nb").context)
        .toBe("full");
});

async function agentRoot(): Promise<string> {
    return mkdtemp(join(tmpdir(), "vera-agents-"));
}

test("project shadows user shadows extension, and says so", async () => {
    const root = await agentRoot();
    const userDirectory = join(root, "user");
    const projectDirectory = join(root, "project");
    await mkdir(userDirectory, { recursive: true });
    await mkdir(projectDirectory, { recursive: true });
    await writeFile(
        join(userDirectory, "reviewer.md"),
        "---\ndescription: mine\n---\nuser body",
    );
    await writeFile(
        join(projectDirectory, "reviewer.md"),
        "---\ndescription: the team's\n---\nproject body",
    );

    const catalog = await loadAgentCatalog({
        projectRoot: root,
        userDirectory,
        projectDirectory,
        registered: [{
            name: "reviewer",
            instructions: "extension body",
        }, {
            name: "plan",
            instructions: "plan body",
        }],
    });

    expect(findCatalogAgent(catalog, "reviewer")?.definition.description)
        .toBe("the team's");
    expect(findCatalogAgent(catalog, "reviewer")?.scope).toBe("project");
    // An extension agent nobody shadowed is still there, and is read-only.
    expect(findCatalogAgent(catalog, "plan")?.writable).toBe(false);
    expect(catalog.notices.join(" ")).toContain("shadows");
});

test("default is virtual until a file shadows it", async () => {
    const root = await agentRoot();
    const empty = await loadAgentCatalog({ projectRoot: root });
    expect(findCatalogAgent(empty, "default")?.definition).toEqual(DEFAULT_AGENT);

    const userDirectory = join(root, "user");
    await mkdir(userDirectory, { recursive: true });
    await writeFile(
        join(userDirectory, "default.md"),
        "---\ntools: [read]\n---\nmy default",
    );
    const shadowed = await loadAgentCatalog({ projectRoot: root, userDirectory });
    expect(findCatalogAgent(shadowed, "default")?.definition.tools)
        .toEqual(["read"]);
});

test("a broken agent file is named and skipped, not fatal", async () => {
    const root = await agentRoot();
    const userDirectory = join(root, "user");
    await mkdir(userDirectory, { recursive: true });
    await writeFile(join(userDirectory, "broken.md"), "---\nwidgets: 1\n---\nb");
    await writeFile(join(userDirectory, "fine.md"), "body");

    const catalog = await loadAgentCatalog({ projectRoot: root, userDirectory });
    expect(findCatalogAgent(catalog, "fine")).toBeDefined();
    expect(findCatalogAgent(catalog, "broken")).toBeUndefined();
    expect(catalog.notices.join(" ")).toContain("unknown key");
});

test("resume compares a snapshot, and a nudge-only edit still counts", () => {
    const before = resolveAgentSnapshot(parseAgentDefinition("r", REVIEWER));
    const after = resolveAgentSnapshot(parseAgentDefinition(
        "r",
        REVIEWER.replace("read-only. /agent", "read only. /agent"),
    ));
    expect(agentSnapshotDrift(before, before)).toEqual([]);
    expect(agentSnapshotDrift(before, after)).toEqual(["nudges"]);

    const widened = resolveAgentSnapshot(parseAgentDefinition(
        "r",
        REVIEWER.replace("tools: [read, grep, ls, bash]", "tools: [read, write]"),
    ));
    expect(agentSnapshotDrift(before, widened)).toEqual(["tools"]);
});

test("a snapshot records what was actually reachable, not what was asked for", () => {
    const agent = parseAgentDefinition("r", "---\ntools: [read, teleport]\n---\nb");
    const snapshot = resolveAgentSnapshot(agent, { tools: ["read", "write"] });
    expect(snapshot.tools).toEqual(["read"]);
});

test("the writer rewrites one key and leaves the rest byte-identical", async () => {
    const root = await agentRoot();
    const path = join(root, "reviewer.md");
    await writeFile(path, REVIEWER);

    await writeAgentDefaultPair(path, { name: "luna", effort: "high" });
    const updated = await Bun.file(path).text();
    expect(parseAgentDefinition("reviewer", updated).defaultPair)
        .toEqual({ name: "luna", effort: "high" });
    // Everything else survived, comments and formatting included.
    expect(updated).toContain("description: read-only code reviewer");
    expect(updated).toContain("You are a code reviewer.");
    expect(updated).toContain('text: "This agent is read-only.');

    await writeAgentDefaultPair(path, null);
    expect(parseAgentDefinition("reviewer", await Bun.file(path).text())
        .defaultPair).toBeUndefined();
});

test("the writer adds the key to an agent that had no frontmatter", async () => {
    const root = await agentRoot();
    const path = join(root, "bare.md");
    await writeFile(path, "just instructions\n");
    await writeAgentDefaultPair(path, { name: "sol" });
    const agent = parseAgentDefinition("bare", await Bun.file(path).text());
    expect(agent.defaultPair).toEqual({ name: "sol" });
    expect(agent.instructions).toBe("just instructions");
});
