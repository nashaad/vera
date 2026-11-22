import { expect, test } from "bun:test";

import {
    describeExtensionFailures,
    describeProviders,
    MAX_LISTED_ROWS,
} from "../../src/core-extensions/help/checks.ts";
import {
    findGuideSection,
    loadGuideSections,
    MAX_READ_CHARACTERS,
    parseGuideSections,
    readGuidePage,
} from "../../src/core-extensions/help/guide.ts";
import {
    describeShowOutcome,
    listShowTargets,
} from "../../src/core-extensions/help/show.ts";
import { includedExtensionConfigs } from "../../src/extensions/included.ts";
import { loadExtensionManifest } from "../../src/extensions/manifest.ts";
import { startExtensionRegistry } from "../../src/extensions/registry.ts";
import { findShowTarget, SHOW_TARGETS } from "../../src/help/show-targets.ts";
import { executeToolHandler, toolDefinitionsForCapabilities } from "../../src/tools/execute.ts";
import { ToolRuntime } from "../../src/tools/runtime.ts";

const signal = new AbortController().signal;

test("@core the guide is read by section, and every page stays under the cap", () => {
    const sections = loadGuideSections();
    const names = sections.map((section) => section.name);
    expect(names).toContain("How to answer");
    expect(names).toContain("Models and providers");
    expect(names.every((name) => !name.includes("[lines="))).toBe(true);

    let paged = 0;
    for (const section of sections) {
        let offset = 0;
        let rebuilt = "";
        for (let guard = 0; guard < 100; guard += 1) {
            const page = readGuidePage(section, offset);
            expect(page.text.length).toBeLessThanOrEqual(MAX_READ_CHARACTERS);
            expect(page.text.length).toBeGreaterThan(0);
            rebuilt += page.text;
            if (page.next === undefined) break;
            offset = page.next;
            paged += 1;
        }
        expect(rebuilt).toBe(section.text);
    }
    expect(paged).toBeGreaterThan(0);
});

test("@core a section is found by exact name, prefix or part, and a vague name lists its matches", () => {
    const sections = parseGuideSections([
        "# Guide", "intro",
        "## Models and providers", "one",
        "## Skills, rules, and standing instructions", "two",
        "## Skills and agents", "three",
    ].join("\n"));
    expect(sections.map((section) => section.name)).toEqual([
        "Guide", "Models and providers", "Skills, rules, and standing instructions", "Skills and agents",
    ]);
    expect(sections[1]?.text).toBe("## Models and providers\none");
    expect(findGuideSection(sections, "models AND providers")).toMatchObject({ kind: "found" });
    expect(findGuideSection(sections, "models")).toMatchObject({ kind: "found", section: { name: "Models and providers" } });
    expect(findGuideSection(sections, "standing")).toMatchObject({ kind: "found", section: { name: "Skills, rules, and standing instructions" } });
    expect(findGuideSection(sections, "skills")).toEqual({
        kind: "ambiguous",
        names: ["Skills, rules, and standing instructions", "Skills and agents"],
    });
    expect(findGuideSection(sections, "ships")).toEqual({ kind: "missing" });
    expect(findGuideSection(sections, "  ")).toEqual({ kind: "missing" });
});

test("@core a page ends at a line break when one is near, and at the cap when none is", () => {
    const lines = Array.from({ length: 400 }, (_, index) => `line ${index} ${"x".repeat(40)}`);
    const text = lines.join("\n");
    const page = readGuidePage({ name: "Long", text }, 0);
    expect(page.text.endsWith("\n")).toBe(true);
    expect(page.next).toBe(page.text.length);
    expect(readGuidePage({ name: "Long", text }, page.next!).text.startsWith("line ")).toBe(true);

    const solid = readGuidePage({ name: "Solid", text: "y".repeat(MAX_READ_CHARACTERS * 2 + 5) }, 0);
    expect(solid.text).toHaveLength(MAX_READ_CHARACTERS);
    expect(solid.next).toBe(MAX_READ_CHARACTERS);
});

test("@core the show tool lists every target and words each outcome", () => {
    const listed = listShowTargets();
    for (const target of SHOW_TARGETS) expect(listed).toContain(`${target.id} (${target.label})`);
    expect(findShowTarget("dialog.rudder")).toBeUndefined();

    const themes = findShowTarget("dialog.themes")!;
    expect(describeShowOutcome(themes, { window: 1, terminal: 0, terminalCannot: 0 })).toBe("Opened Choose Theme in the window.");
    expect(describeShowOutcome(themes, { window: 1, terminal: 1, terminalCannot: 0 })).toBe("Opened Choose Theme in the window and the terminal.");
    expect(describeShowOutcome(themes, { window: 0, terminal: 1, terminalCannot: 0 })).toBe("Opened Choose Theme in the terminal.");
    expect(describeShowOutcome(themes, { window: 1, terminal: 0, terminalCannot: 1 })).toBe("Opened Choose Theme in the window. The terminal cannot show it.");
    expect(describeShowOutcome(themes, { window: 0, terminal: 0, terminalCannot: 1 })).toBe("The terminal cannot show Choose Theme.");
    expect(describeShowOutcome(themes, { window: 0, terminal: 0, terminalCannot: 0 })).toBe("No window or terminal is attached to this chat.");
});

test("@core the checks word provider status and load failures within their caps", () => {
    const provider = (id: string, connected: boolean, connected_by?: "key" | "browser" | "environment" | "none") => ({
        id, name: id.toUpperCase(), methods: ["key" as const], connected, catalog_connected: connected, custom: false,
        ...(connected_by === undefined ? {} : { connected_by }),
    });
    expect(describeProviders({
        needsSetup: false,
        providers: [provider("rook", true, "key"), provider("crow", true, "environment"), provider("raven", false)],
    })).toBe("ROOK (rook): connected with a key\nCROW (crow): connected from an environment variable\nRAVEN (raven): not connected");
    expect(describeProviders({ needsSetup: true, providers: [] })).toBe("No provider is connected yet.");

    const many = Array.from({ length: MAX_LISTED_ROWS + 3 }, (_, index) => provider(`p${index}`, false));
    const lines = describeProviders({ needsSetup: false, providers: many }).split("\n");
    expect(lines).toHaveLength(MAX_LISTED_ROWS + 1);
    expect(lines.at(-1)).toBe("3 more are not listed.");

    expect(describeExtensionFailures([])).toBe("No extension failed to load.");
    const failure = describeExtensionFailures([{ extensionId: "vera.rookery", message: "m".repeat(1000) }]);
    expect(failure.startsWith("vera.rookery: ")).toBe(true);
    expect(failure.length).toBeLessThan(400);
});

async function helpRegistry(shown: string[] = []) {
    const configs = includedExtensionConfigs([]).filter((config) =>
        loadExtensionManifest(config.path).manifest.id === "vera.help");
    expect(configs).toHaveLength(1);
    const registry = await startExtensionRegistry({ extensions: configs });
    registry.bindHost({
        async oneshot() { return { text: "", model: "none" }; },
        async showInSession(sessionId, target) {
            shown.push(`${sessionId}=${target}`);
            return { window: 1, terminal: 0, terminalCannot: 0 };
        },
        async setSessionTitle() { return "set"; },
        async askSession() { return { text: "", model: "none" }; },
        async sendToSession() { return "queued"; },
        async investigate() { return { outcome: "answered", text: "" }; },
    });
    return registry;
}

test("@core the Help agent offers only the Help tools and never bash", async () => {
    const registry = await helpRegistry();
    try {
        const help = registry.agents().find((entry) => entry.name === "help");
        expect(help?.tools).toEqual(["help_guide", "help_providers", "help_extension_failures", "help_show"]);
        expect(help?.skills).toEqual([]);
        expect(help?.tools).not.toContain("bash");
        expect(registry.tools().map((tool) => tool.definition.name).sort()).toEqual([...help!.tools!].sort());
        expect(registry.tools().every((tool) => tool.agents?.join() === "help")).toBe(true);
    } finally {
        await registry.close();
    }
});

test("@core Help tools reach the model in a Help chat and in no other chat", async () => {
    const registry = await helpRegistry();
    try {
        const offered = (agent: string | undefined) => toolDefinitionsForCapabilities([], false, registry.tools(), "top_level", agent)
            .map((tool) => tool.name).filter((name) => name.startsWith("help_"));
        expect(offered("help")).toHaveLength(4);
        for (const other of ["chat", "default", "explorer", undefined]) expect(offered(other)).toEqual([]);
    } finally {
        await registry.close();
    }
});

test("@core the tools run for the Help agent: guide pages, unknown sections, and show", async () => {
    const shown: string[] = [];
    const registry = await helpRegistry(shown);
    try {
        const tools = registry.tools();
        const runtime = new ToolRuntime(process.cwd());
        runtime.agentName = "help";
        runtime.sessionId = "session-1";
        const call = (name: string, input: Record<string, unknown>) =>
            executeToolHandler({ type: "tool_call", id: name, name, input }, runtime, signal, tools);

        const list = await call("help_guide", {});
        expect(list).toMatchObject({ isError: false, output: expect.stringContaining("- How to answer (") });

        const first = await call("help_guide", { section: "Models and providers" });
        expect(first).toMatchObject({ isError: false });
        expect(first.kind === "output" ? first.output : "").toStartWith("## Models and providers");

        expect(await call("help_guide", { section: "Rudders" })).toMatchObject({
            isError: true,
            output: expect.stringContaining("No guide section is named \"Rudders\"."),
        });
        expect(await call("help_guide", { section: "Models and providers", offset: 10_000_000 })).toMatchObject({
            isError: true,
            output: expect.stringContaining("is past the end of this section"),
        });
        expect(await call("help_guide", { offset: -1 })).toMatchObject({ isError: true });
        expect(await call("help_guide", { section: 3 })).toMatchObject({ isError: true });

        expect(await call("help_show", { target: "dialog.themes" })).toMatchObject({
            isError: false,
            output: "Opened Choose Theme in the window.",
        });
        expect(shown).toEqual(["session-1=dialog.themes"]);
        expect(await call("help_show", { target: "dialog.rudder" })).toMatchObject({ isError: true });
        expect(shown).toHaveLength(1);

        runtime.agentName = "chat";
        expect(await call("help_show", { target: "dialog.themes" })).toMatchObject({
            isError: true,
            output: "The agent you are wearing does not offer the help_show tool.",
        });
        expect(shown).toHaveLength(1);
    } finally {
        await registry.close();
    }
});
