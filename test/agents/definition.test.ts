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
} from "../../src/agents/snapshot.ts";
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

const SHIFTED_FENCES: readonly (readonly [string, string])[] = [
    ["a byte order mark", "\uFEFF---\ntools: []\n---\nbody"],
    ["leading blank lines", "\n\n---\ntools: []\n---\nbody"],
    ["a space after the opening fence", "--- \ntools: []\n---\nbody"],
    ["a tab after the closing fence", "---\ntools: []\n---\t\nbody"],
    ["CRLF with a byte order mark and padded fences", "\uFEFF\r\n---  \r\ntools: []\r\n---\t\r\nbody"],
];

test.each(SHIFTED_FENCES)("a fence with %s still closes the tool list", (_label, source) => {
    const agent = parseAgentDefinition("closed", source);
    expect(agent.tools).toEqual([]);
    expect(agent.instructions).toBe("body");
});

test.each([
    ["a leading comment", "# role\n---\ntools: []\n---\nbody"],
    ["a leading paragraph", "Read only.\n\n---\nskills: []\n---\nbody"],
    ["an indented opening fence", " ---\ntools: []\n---\nbody"],
    ["a rule before the block", "intro\n---\nnotes\n---\ntools: []\n---\nbody"],
    ["an opening fence that never closes", "Intro.\n---\ntools: []"],
    ["an unclosed fence after prose in its own block", "Intro.\n---\nSome notes.\ntools: []\nMore."],
    ["an unclosed fence after a rule", "Intro.\n---\nnotes\n---\nskills: []\nMore."],
    ["CRLF line endings", "Intro.\r\n---\r\ntools: []\r\nMore."],
    ["a quoted key", "intro\n---\n\"tools\": []\n---\nbody"],
    ["a flow mapping", "intro\n---\n{tools: []}\n---\nbody"],
])("a restriction block after %s is refused, not loaded with every tool", (_label, source) => {
    expect(() => parseAgentDefinition("closed", source))
        .toThrow("does not start the file");
});

test("a refusal names every definition field in the block", () => {
    expect(() =>
        parseAgentDefinition("named", "Intro.\n---\ntools: []\nposture: readonly\n---\nbody")
    ).toThrow("tools, posture");
});

test.each([
    ["fields, then a blank line", "---\ntools: []\n\nYou are a reviewer."],
    ["fields, then the end of the file", "---\nskills: []"],
    ["byte order mark, CRLF and a padded opener", "\uFEFF\r\n---  \r\ntools: []\r\n\r\nbody"],
    ["several fields", "---\ndescription: d\nposture: readonly\n\nbody"],
    ["a field straight into prose", "---\ntools: []\nYou are a reviewer."],
    ["a comment before the fields", "---\n# role\ntools: []\nBody"],
    ["an unknown key before the fields", "---\ntitle: notes\ntools: []\nBody"],
    ["prose before the fields", "---\nBe brief.\ntools: []\n\nbody"],
    ["a blank line before the fields", "---\n\ntools: []\nbody"],
    ["fields in a later paragraph", "---\nBe brief.\n\ntools: []\nbody"],
    ["a closing fence that is indented", "---\ntools: []\n ---\nbody"],
    ["a flow mapping", "---\n{tools: []}\nBody"],
    ["a flow mapping with a later field", "---\n{ title: notes, \"posture\": readonly }\nBody"],
    ["a flow mapping and a document end", "---\n{tools: []}\n...\nBody"],
])("an opening fence that never closes is refused (%s)", (_label, source) => {
    expect(() => parseAgentDefinition("open", source)).toThrow("is never closed");
});

test.each([
    ["prose after it", "---\nBe brief and kind.\n\nSecond paragraph."],
    ["prose with a colon after it", "---\nNote: check twice.\n\nThen answer."],
    ["prose with a colon and no blank line", "---\nNote: check twice.\nMore prose."],
    ["fields no definition has", "---\ntitle: notes\n\nbody"],
    ["lone rule", "---"],
    ["a lone rule between paragraphs", "Be brief.\n---\nCheck twice."],
    ["a lone rule at the end", "Be brief.\n\n---"],
    ["a field named mid-line", "Be brief.\n---\nUse the tools: carefully.\n---\nEnd."],
    ["a colon with no space after it", "Be brief.\n---\ntools:[]\n---\nEnd."],
    ["a field name in another case", "Be brief.\n---\nTools: all of them\n---\nEnd."],
    ["an unknown key between rules", "Be brief.\n---\ntitle: notes\n---\nEnd."],
])("an unclosed rule stays plain instructions (%s)", (_label, source) => {
    const agent = parseAgentDefinition("plain", source);
    expect(agent.tools).toBeUndefined();
    expect(agent.instructions).toBe(source.trim());
});

test("horizontal rules around prose stay instructions", () => {
    const source = [
        "Be brief.",
        "",
        "---",
        "",
        "Check the rules twice.",
        "",
        "---",
        "title: notes",
        "---",
        "a: [",
        "---",
        "End politely.",
    ].join("\n");
    const agent = parseAgentDefinition("plain", source);
    expect(agent.tools).toBeUndefined();
    expect(agent.instructions).toBe(source);
});

test("text after a real fence is never read as a second fence", () => {
    const agent = parseAgentDefinition(
        "once",
        "---\ndescription: d\n---\nbody\n---\ntools: []\n---\nmore",
    );
    expect(agent.tools).toBeUndefined();
    expect(agent.instructions).toBe("body\n---\ntools: []\n---\nmore");
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

test("a subagent assignment survives parsing, snapshots and drift checks", () => {
    const definition = parseAgentDefinition(
        "research", "---\nsubagent_assignment: eco\n---\nFind the evidence.",
    );
    const snapshot = resolveAgentSnapshot(definition);
    expect(snapshot.subagentAssignment).toBe("eco");
    expect(agentSnapshotDrift(snapshot, { ...snapshot, subagentAssignment: "extra" }))
        .toEqual(["subagent assignment"]);
    expect(() => parseAgentDefinition(
        "research", "---\nsubagent_assignment: []\n---\nFind the evidence.",
    )).toThrow("subagent_assignment must be a non-empty string");
});

test("context accepts only full in v1", () => {
    expect(parseAgentDefinition("x", "---\ncontext: full\n---\nb").context)
        .toBe("full");
});

test("agents can forbid named permission modes", () => {
    const agent = parseAgentDefinition(
        "plan",
        "---\nposture: readonly\nforbidden_access: [auto, full_access]\n---\nplan",
        { permissionModes: ["readonly", "ask", "auto", "full_access"] },
    );
    expect(agent.forbiddenAccess).toEqual(["auto", "full_access"]);
    expect(resolveAgentSnapshot(agent).forbiddenAccess)
        .toEqual(["auto", "full_access"]);
    expect(() => parseAgentDefinition(
        "plan",
        "---\nforbidden_access: [mystery]\n---\nplan",
        { permissionModes: ["readonly", "ask", "auto"] },
    )).toThrow("no permission mode named mystery");
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

test("the catalog refuses a misplaced or unclosed fence instead of loading an agent", async () => {
    const root = await agentRoot();
    const userDirectory = join(root, "user");
    await mkdir(userDirectory, { recursive: true });
    await writeFile(join(userDirectory, "misplaced.md"), "Intro.\n---\ntools: []");
    await writeFile(join(userDirectory, "unclosed.md"), "---\n# role\ntools: []\nBody");
    await writeFile(join(userDirectory, "rules.md"), "Be brief.\n\n---\n\nCheck twice.\n\n---\n\nEnd.");
    await writeFile(join(userDirectory, "closed.md"), "---\ntools: []\n---\nbody");

    const catalog = await loadAgentCatalog({ projectRoot: root, userDirectory });

    expect(findCatalogAgent(catalog, "misplaced")).toBeUndefined();
    expect(findCatalogAgent(catalog, "unclosed")).toBeUndefined();
    expect(catalog.notices.filter((notice) => notice.includes("misplaced.md")))
        .toEqual([expect.stringContaining("does not start the file")]);
    expect(catalog.notices.filter((notice) => notice.includes("unclosed.md")))
        .toEqual([expect.stringContaining("is never closed")]);
    expect(findCatalogAgent(catalog, "rules")?.definition.tools).toBeUndefined();
    expect(findCatalogAgent(catalog, "closed")?.definition.tools).toEqual([]);
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

test("the writer keeps a shifted fence closed after it rewrites the pair", async () => {
    const root = await agentRoot();
    const path = join(root, "shifted.md");
    await writeFile(path, "\uFEFF\n---  \ntools: []\n---\nbody\n");
    await writeAgentDefaultPair(path, { name: "sol" });
    const agent = parseAgentDefinition("shifted", await Bun.file(path).text());
    expect(agent.tools).toEqual([]);
    expect(agent.defaultPair).toEqual({ name: "sol" });
    expect(agent.instructions).toBe("body");
});

test.each([
    ["a misplaced block", "Intro.\n---\ntools: []\n---\nbody\n", "does not start the file"],
    ["a misplaced opener", "Intro.\n---\ntools: []\n", "does not start the file"],
    ["an unclosed block", "---\n# role\ntools: []\nBody\n", "is never closed"],
])("the writer refuses %s and leaves the file alone", async (_label, source, reason) => {
    const root = await agentRoot();
    const path = join(root, "broken.md");
    await writeFile(path, source);
    await expect(writeAgentDefaultPair(path, { name: "sol" })).rejects.toThrow(reason);
    await expect(writeAgentDefaultPair(path, null)).rejects.toThrow(reason);
    expect(await Bun.file(path).text()).toBe(source);
});

test("the writer still wraps a file with horizontal rules and no definition fields", async () => {
    const root = await agentRoot();
    const path = join(root, "rules.md");
    await writeFile(path, "Be brief.\n\n---\n\nCheck twice.\n");
    await writeAgentDefaultPair(path, { name: "sol" });
    const agent = parseAgentDefinition("rules", await Bun.file(path).text());
    expect(agent.defaultPair).toEqual({ name: "sol" });
    expect(agent.instructions).toBe("Be brief.\n\n---\n\nCheck twice.");
});
