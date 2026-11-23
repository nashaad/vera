import { expect, test } from "bun:test";

import {
    pluginDetail,
    pluginEditorPath,
    pluginExtensionOff,
    pluginFacts,
    pluginLoaded,
    pluginName,
    pluginNoMatch,
    pluginOff,
    pluginItems,
    pluginKindCounts,
    pluginPathLabel,
    pluginRowMeta,
    pluginScope,
    pluginSectionEmpty,
    pluginSections,
    pluginSheetMeta,
    seeMoreLabel,
    type PluginItem,
} from "../../clients/ui/src/plugins/items.ts";
import type { FolderCustomizationsAnswer } from "../../clients/ui/src/protocol/bridge.ts";
import type { DesktopExtensionEntry } from "../../clients/ui/src/protocol/extensions.ts";
import type { PluginInstallPreview } from "../../clients/ui/src/protocol/plugin-install.ts";
import { pluginRestartNotes } from "../../clients/ui/src/plugins/PluginInstallPreview.tsx";

test("plugin install preview names the restarts each part needs", () => {
    const preview: PluginInstallPreview = {
        name: "crow", source_path: "/work/crow", replaces: null,
        skills: ["sail"], agents: ["captain"],
        mcp: { servers: [], skipped: [], notes: [] }, mcp_enabled: true,
        host_extension_id: null, desktop_extension_id: null,
        needs_host_restart: false, needs_desktop_restart: false,
        ignored: [], warnings: [],
    };
    expect(pluginRestartNotes(preview)).toEqual([]);
    expect(pluginRestartNotes({ ...preview, needs_host_restart: true })).toEqual([
        "Restart the resident host to apply extension code and MCP servers.",
    ]);
    expect(pluginRestartNotes({ ...preview, needs_desktop_restart: true })).toEqual([
        "Reload desktop extensions or restart the app to load its desktop extension.",
    ]);
    expect(pluginRestartNotes({ ...preview, needs_host_restart: true, needs_desktop_restart: true })).toHaveLength(2);
});

const FOLDER = "/work";
const HOME = "/Users/nash";

const DEPLOY_SOURCE = {
    id: "skills:deploy",
    category: "skills" as const,
    name: "deploy",
    description: "Ship the service",
    scope: "project",
    path: `${FOLDER}/.vera/skills/deploy/SKILL.md`,
    content: "# Deploy",
    editable: true,
};

const READING: Pick<FolderCustomizationsAnswer, "skills" | "startsOn" | "agents" | "sources"> = {
    skills: [{ name: "deploy", description: "Ship the service", manualOnly: false }],
    startsOn: "vera",
    agents: [],
    sources: [
        DEPLOY_SOURCE,
        {
            id: "extensions:local-pack",
            category: "extensions",
            name: "local-pack",
            description: "An installed extension",
            scope: "user",
            path: `${HOME}/extensions/local-pack/vera.extension.json`,
            content: "",
            editable: false,
        },
    ],
};

function extension(
    id: string,
    overrides: Partial<DesktopExtensionEntry> = {},
): DesktopExtensionEntry {
    return {
        id,
        version: "1.0.0",
        themes: [],
        hasMain: false,
        hasCommands: false,
        hasUnavailableContributions: false,
        commands: [],
        menus: { appearance: [], theme: [], browser: [] },
        included: false,
        enabled: true,
        ...overrides,
    };
}

function item(overrides: Partial<PluginItem>): PluginItem {
    return {
        key: "skills:test",
        kind: "skills",
        name: "test",
        description: "",
        group: "Your home",
        failed: false,
        current: false,
        scope: "home",
        ...overrides,
    };
}

test("the three scopes take the host groups that have names on the page", () => {
    expect(pluginScope("This folder")).toBe("folder");
    expect(pluginScope("Your home")).toBe("home");
    expect(pluginScope("Extensions")).toBe("builtin");
    expect(pluginScope("Built in")).toBe("builtin");
    expect(pluginScope("Other")).toBe("builtin");
});

test("desktop extensions replace the host's extension rows and included ones stay out", () => {
    const items = pluginItems(READING, [], [
        extension("local-pack", { enabled: false, themes: ["Night"] }),
        extension("included.theme", { included: true }),
    ]);

    expect(items.map((entry) => entry.name)).toEqual(["deploy", "local-pack"]);
    const local = items.find((entry) => entry.name === "local-pack");
    expect(local?.scope).toBe("home");
    expect(local?.description).toBe("Adds the theme Night.");
    expect(local?.source?.path).toBe(`${HOME}/extensions/local-pack/vera.extension.json`);
    expect(local === undefined ? undefined : pluginExtensionOff(local)).toBe(true);
});

test("a skill from an installed extension moves to Your home and names the extension", () => {
    const reading = {
        ...READING,
        skills: [{ name: "packed", description: "Packed skill", manualOnly: false }],
        sources: [{
            id: "skills:packed",
            category: "skills" as const,
            name: "packed",
            description: "Packed skill",
            scope: "extension local-pack",
            path: `${HOME}/extensions/local-pack/skills/packed/SKILL.md`,
            content: "# Packed",
            editable: false,
        }],
    };
    const items = pluginItems(reading, [], [extension("local-pack")]);
    const skill = items.find((entry) => entry.name === "packed")!;

    expect(skill.scope).toBe("home");
    expect(skill.extensionId).toBe("local-pack");
    expect(pluginRowMeta(skill, FOLDER, HOME)).toEqual({ extension: "From local-pack", detail: "/packed" });
    expect(pluginSheetMeta(skill, "work")).toEqual(["From local-pack", "Your home"]);
    expect(pluginFacts(skill, "work")).toEqual([
        { label: "Location", value: `${HOME}/extensions/local-pack/skills/packed/SKILL.md`, code: true },
        { label: "Scope", value: "Your home", code: false },
        { label: "Loads in", value: "Every folder", code: false },
        { label: "Command", value: "/packed", code: true },
        { label: "Files", value: "1", code: false },
    ]);
});

test("a skill from an extension included with Vera stays Built in", () => {
    const reading = {
        ...READING,
        skills: [{ name: "bundled-pack", description: "Bundled skill", manualOnly: false }],
        sources: [{
            id: "skills:bundled-pack",
            category: "skills" as const,
            name: "bundled-pack",
            description: "Bundled skill",
            scope: "extension included.pack",
            path: "/vera/skills/bundled-pack/SKILL.md",
            content: "# Bundled",
            editable: false,
        }],
    };
    const items = pluginItems(reading, [], [extension("included.pack", { included: true })]);
    const skill = items.find((entry) => entry.name === "bundled-pack")!;

    expect(skill.scope).toBe("builtin");
    expect(skill.extensionId).toBeUndefined();
    expect(pluginRowMeta(skill, FOLDER, HOME)).toEqual({ detail: "/bundled-pack" });
    expect(pluginSheetMeta(skill, "work")).toEqual(["Included with Vera"]);
    expect(pluginFacts(skill, "work").slice(1, 3)).toEqual([
        { label: "Scope", value: "Built in", code: false },
        { label: "Loads in", value: "Every folder", code: false },
    ]);
});

test("a bare extension scope and a skill with no source stay Built in", () => {
    const agents = pluginItems({
        ...READING,
        skills: [],
        agents: [{ name: "plan", description: "Plan the work", scope: "extension", writable: false }],
        sources: [],
    }, [], [extension("local-pack")]);
    const plan = agents.find((entry) => entry.name === "plan")!;

    expect(plan.scope).toBe("builtin");
    expect(pluginRowMeta(plan, FOLDER, HOME)).toEqual({});
    expect(pluginSheetMeta(plan, "work")).toEqual(["Included with Vera"]);

    const orphans = pluginItems({
        ...READING,
        skills: [{ name: "orphan", description: "No source matched", manualOnly: false }],
        agents: [],
        sources: [],
    }, [], []);
    const orphan = orphans.find((entry) => entry.name === "orphan")!;

    expect(orphan.group).toBe("Other");
    expect(orphan.scope).toBe("builtin");
    expect(pluginRowMeta(orphan, FOLDER, HOME)).toEqual({ detail: "/orphan" });
    expect(pluginSheetMeta(orphan, "work")).toEqual(["Included with Vera"]);
});

test("plugin packages and their skills and agents stay visible and read-only", () => {
    const pluginPath = `${HOME}/plugins/crow`;
    const items = pluginItems({
        ...READING,
        skills: [{ name: "sail", description: "Sail", manualOnly: false, plugin: "crow" }],
        agents: [{ name: "captain", description: "Captain", scope: "plugin", writable: false, plugin: "crow" }],
        sources: [
            { id: "plugins:crow", category: "plugins", name: "crow", description: "1 skill, 1 agent", scope: "plugin", plugin: "crow", path: pluginPath, status: "enabled", content: "", editable: false },
            { id: "plugins:off", category: "plugins", name: "off", description: "1 skill", scope: "plugin", plugin: "off", path: `${HOME}/plugins/off`, status: "disabled", content: "", editable: false },
            { id: "skills:sail", category: "skills", name: "sail", description: "Sail", scope: "plugin crow", plugin: "crow", path: `${pluginPath}/SKILL.md`, content: "", editable: false },
            { id: "agents:captain", category: "agents", name: "captain", description: "Captain", scope: "plugin", plugin: "crow", path: `${pluginPath}/captain.md`, content: "", editable: false },
        ],
    }, [], []);

    expect(pluginKindCounts(items).plugins).toBe(2);
    for (const [name, kind] of [["crow", "plugins"], ["sail", "skills"], ["captain", "agents"]] as const) {
        const entry = items.find((candidate) => candidate.name === name)!;
        expect(entry.scope).toBe("home");
        expect(pluginSections(items, kind, "").find((section) => section.scope === "home")?.items).toContain(entry);
        expect(pluginEditorPath(entry)).toBeUndefined();
    }
    const plugin = items.find((entry) => entry.name === "crow")!;
    expect(pluginSections(items, "plugins", "").map((section) => section.scope)).toEqual(["home"]);
    expect(plugin.pluginContents).toEqual({ skills: ["sail"], agents: ["captain"] });
    expect(pluginRowMeta(plugin, FOLDER, HOME)).toEqual({ detail: "1 skill, 1 agent" });
    expect(pluginSheetMeta(plugin, "work")).toEqual(["On"]);
    expect(pluginFacts(plugin, "work")).toEqual([
        { label: "Location", value: pluginPath, code: true },
        { label: "State", value: "On", code: false },
        { label: "Parts", value: "1 skill, 1 agent", code: false },
    ]);
    const off = items.find((entry) => entry.name === "off")!;
    expect(pluginOff(off)).toBe(true);
    expect(pluginSheetMeta(off, "work")).toEqual(["Off"]);
    expect(off.pluginContents).toEqual({ skills: [], agents: [] });
    const skill = items.find((entry) => entry.name === "sail")!;
    const agent = items.find((entry) => entry.name === "captain")!;
    expect(pluginRowMeta(skill, FOLDER, HOME)).toEqual({ extension: "From crow", detail: "/sail" });
    expect(pluginRowMeta(agent, FOLDER, HOME)).toEqual({ extension: "From crow", detail: "~/plugins/crow/captain.md" });
    expect(pluginSheetMeta(skill, "work")).toEqual(["From crow", "Your home"]);
    expect(pluginEditorPath(pluginItems(READING, [], [])[0]!)).toBe(DEPLOY_SOURCE.path);
});

test("a skill the host marks disabled is off rather than loaded", () => {
    const reading = {
        ...READING,
        skills: [],
        sources: [{ ...DEPLOY_SOURCE, status: "disabled" }],
    };
    const items = pluginItems(reading, [], []);
    const skill = items.find((entry) => entry.name === "deploy")!;

    expect(pluginOff(skill)).toBe(true);
    expect(pluginLoaded(skill)).toBe(false);
});

test("a failed extension that the window did not list becomes an Off home row", () => {
    const items = pluginItems(READING, [
        { extensionId: "broken-pack", message: "The manifest did not load." },
    ], [extension("local-pack")]);

    const broken = items.find((entry) => entry.name === "broken-pack");
    expect(broken?.scope).toBe("home");
    expect(broken?.failed).toBe(true);
    expect(broken?.description).toBe("The manifest did not load.");
});

test("kind counts answer for the rows in front of them", () => {
    const items = pluginItems(READING, [], [
        extension("local-pack"),
        extension("another-pack"),
    ]);

    expect(pluginKindCounts(items).skills).toBe(1);
    expect(pluginKindCounts(items).extensions).toBe(2);
});

test("a skill row ends in its command, and other kinds end in the file's path", () => {
    const items = pluginItems(READING, [], [extension("local-pack")]);
    const skill = items.find((entry) => entry.name === "deploy")!;
    const extensionRow = items.find((entry) => entry.name === "local-pack")!;

    expect(pluginRowMeta(skill, FOLDER, HOME)).toEqual({ detail: "/deploy" });
    expect(pluginRowMeta(extensionRow, FOLDER, HOME)).toEqual({
        detail: "~/extensions/local-pack/vera.extension.json",
    });
    expect(pluginDetail(extensionRow, FOLDER, HOME)).toBe("~/extensions/local-pack/vera.extension.json");
});

test("paths read from the folder lose it, and home paths read with a tilde", () => {
    expect(pluginPathLabel(`${FOLDER}/.vera/rules/cli.md`, "folder", FOLDER, HOME)).toBe(".vera/rules/cli.md");
    expect(pluginPathLabel(`${HOME}/.vera/rules/global.md`, "home", FOLDER, HOME)).toBe("~/.vera/rules/global.md");
    expect(pluginPathLabel("/elsewhere/file.md", "home", FOLDER, HOME)).toBe("/elsewhere/file.md");
    expect(pluginPathLabel(`${HOME}/.vera/rules/global.md`, "home", undefined, undefined)).toBe(`${HOME}/.vera/rules/global.md`);
    expect(pluginPathLabel(`${FOLDER}/AGENTS.md`, "folder", `${FOLDER}/`, HOME)).toBe("AGENTS.md");
});

test("an instruction row shows the file's name; the path goes on the meta line", () => {
    const rule = item({
        key: "instructions:1",
        kind: "instructions",
        name: ".vera/rules/cli.md",
        scope: "folder",
        group: "This folder",
        source: {
            id: "instructions:1",
            category: "instructions",
            name: ".vera/rules/cli.md",
            description: "Project rule, always on",
            scope: "project",
            path: `${FOLDER}/.vera/rules/cli.md`,
            content: "",
            editable: true,
        },
    });

    expect(pluginName(rule)).toBe("cli.md");
    expect(pluginRowMeta(rule, FOLDER, HOME)).toEqual({ detail: ".vera/rules/cli.md" });
});

test("sections stack In this folder, Your home and Built in, and leave out an empty Built in", () => {
    const items = [
        item({ key: "a", name: "folder-a", scope: "folder", group: "This folder" }),
        item({ key: "b", name: "folder-b", scope: "folder", group: "This folder" }),
        item({ key: "c", name: "home-a" }),
    ];

    const sections = pluginSections(items, "all", "");
    expect(sections.map((section) => section.scope)).toEqual(["folder", "home"]);
    expect(sections[0]?.items.map((entry) => entry.name)).toEqual(["folder-a", "folder-b"]);
    expect(sections[1]?.items.map((entry) => entry.name)).toEqual(["home-a"]);
});

test("a Built in section shows when it has items, even collapsed", () => {
    const sections = pluginSections([
        item({ key: "a", name: "home-a" }),
        item({ key: "b", name: "vera-help", scope: "builtin", group: "Built in" }),
    ], "all", "");

    expect(sections.map((section) => section.scope)).toEqual(["folder", "home", "builtin"]);
    expect(sections[2]?.items).toHaveLength(1);
});

test("searching filters every section, keeps only matches, and can leave the page empty", () => {
    const items = [
        item({ key: "a", name: "review", scope: "folder", group: "This folder" }),
        item({ key: "b", name: "search-sessions" }),
        item({ key: "c", name: "vera-help", scope: "builtin", group: "Built in" }),
    ];

    const homeHit = pluginSections(items, "all", "search");
    expect(homeHit.map((section) => section.scope)).toEqual(["home"]);

    const builtinHit = pluginSections(items, "all", "vera");
    expect(builtinHit.map((section) => section.scope)).toEqual(["builtin"]);

    const descriptions = pluginSections([
        item({ key: "a", name: "review", description: "Looks at a diff" }),
    ], "all", "diff");
    expect(descriptions.map((section) => section.scope)).toEqual(["home"]);

    expect(pluginSections(items, "all", "albatross")).toEqual([]);
    expect(pluginSections(items, "agents", "vera")).toEqual([]);
});

test("sections say what an empty scope means and what a fruitless search means", () => {
    expect(pluginSectionEmpty("folder", "skills", "vera")).toBe("No skills in vera yet. Items from your home load here too.");
    expect(pluginSectionEmpty("folder", "skills", undefined)).toBe("No folder is selected, so there are no skills here.");
    expect(pluginSectionEmpty("home", "agents", "vera")).toBe("No agents in your home.");
    expect(pluginSectionEmpty("home", "plugins", "vera")).toBe("No plugins are installed. Use Add to install one.");
    expect(pluginSections([], "plugins", "").map((section) => section.scope)).toEqual(["home"]);
    expect(pluginSectionEmpty("builtin", "memory", "vera")).toBe("No built-in memory.");
    expect(pluginNoMatch("skills", "  quill  ")).toBe("No skills match “quill”.");
});

test("the see-more line names one, two, or the rest", () => {
    expect(seeMoreLabel([])).toBeUndefined();
    expect(seeMoreLabel(["Night"])).toBe("See Night");
    expect(seeMoreLabel(["Night", "Dusk"])).toBe("See Night and Dusk");
    expect(seeMoreLabel(["Night", "Dusk", "Dawn", "Noon"])).toBe(
        "See Night, Dusk, and 2 more",
    );
});

test("the sheet facts follow the item's scope and the one file the host returned", () => {
    const items = pluginItems(READING, [], []);
    const skill = items.find((entry) => entry.name === "deploy")!;

    expect(pluginFacts(skill, "work")).toEqual([
        { label: "Location", value: `${FOLDER}/.vera/skills/deploy/SKILL.md`, code: true },
        { label: "Scope", value: "work", code: false },
        { label: "Loads in", value: "work only", code: false },
        { label: "Command", value: "/deploy", code: true },
        { label: "Files", value: "1", code: false },
    ]);
    expect(pluginSheetMeta(skill, "work")).toEqual(["By you", "work"]);
});

test("a built-in row says so in its facts and sheet meta", () => {
    const builtin = item({
        key: "skills:bundled",
        name: "bundled",
        description: "Ships with Vera",
        group: "Built in",
        scope: "builtin",
    });

    expect(pluginFacts(builtin, "work")[0]).toEqual({
        label: "Location",
        value: "Included with Vera",
        code: false,
    });
    expect(pluginFacts(builtin, "work")[3]?.value).toBe("/bundled");
    expect(pluginSheetMeta(builtin, "work")).toEqual(["Included with Vera"]);
});
