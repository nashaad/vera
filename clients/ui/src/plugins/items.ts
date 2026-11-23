import {
    buildItems,
    KIND_LABELS,
    kindCounts,
    scopeGroup,
    visibleItems,
    type CustomizeItem,
    type CustomizeKind,
    type KindFilter,
    type ScopeGroup,
} from "../customize/catalog.ts";
import type { SourceInfo } from "../customize/wire.ts";
import type { ExtensionFailure, FolderCustomizationsAnswer } from "../protocol/bridge.ts";
import type { DesktopExtensionEntry } from "../protocol/extensions.ts";

export type PluginScope = "folder" | "home" | "builtin";

// The page stacks its sections in this order; In this folder is the one that changes with the folder picker.
export const PLUGIN_SECTION_ORDER: readonly PluginScope[] = ["folder", "home", "builtin"];

export interface PluginItem extends CustomizeItem {
    readonly scope: PluginScope;
    readonly extension?: DesktopExtensionEntry;
    // Set when the host names the installed extension a skill came from.
    readonly extensionId?: string;
    readonly pluginContents?: PluginContents;
}

export interface PluginContents {
    readonly skills: readonly string[];
    readonly agents: readonly string[];
}

export interface PluginSection {
    readonly scope: PluginScope;
    readonly items: readonly PluginItem[];
}

export interface PluginFact {
    readonly label: string;
    readonly value: string;
    readonly code: boolean;
}

// The two parts of a row's third line, joined by a dot. Neither is present for an item with nothing to say.
export interface PluginRowMeta {
    readonly extension?: string;
    readonly detail?: string;
}

// A group alone cannot tell an installed extension from an included one; pluginItems resolves that by id.
// Extensions and Other stay Built in here because their origin is unknown.
export function pluginScope(group: ScopeGroup): PluginScope {
    if (group === "This folder") return "folder";
    if (group === "Your home") return "home";
    return "builtin";
}

function extensionScopeId(scope: string | undefined): string | undefined {
    const prefix = "extension ";
    if (scope === undefined || !scope.startsWith(prefix)) return undefined;
    const id = scope.slice(prefix.length);
    return id.length === 0 ? undefined : id;
}

export function pluginKindCounts(items: readonly PluginItem[]): Readonly<Record<KindFilter, number>> {
    return kindCounts(items);
}

export function scopeLabel(scope: PluginScope, folder: string | undefined): string {
    if (scope === "home") return "Your home";
    if (scope === "folder") return folder ?? "This folder";
    return "Built in";
}

// Rule sources are named by their path; the path is on the meta line, so the row shows the file's name.
export function pluginName(item: PluginItem): string {
    return item.kind === "instructions" ? basename(item.name) : item.name;
}

export function pluginCommand(item: PluginItem): string | undefined {
    return item.kind === "skills" ? `/${item.name}` : undefined;
}

export function pluginEditorPath(item: PluginItem): string | undefined {
    if (item.kind === "plugins" || item.source?.plugin !== undefined || item.skill?.plugin !== undefined || item.agent?.plugin !== undefined) return undefined;
    return item.source?.path;
}

// Paths read from the folder lose it, and home paths read with `~`, as they do in the manual.
export function pluginPathLabel(path: string, scope: PluginScope, folder: string | undefined, home: string | undefined): string {
    if (scope === "folder" && folder !== undefined) {
        const relative = relativeTo(path, folder);
        if (relative !== undefined && relative.length > 0) return slashes(relative);
    }
    if (scope === "home" && home !== undefined) {
        const relative = relativeTo(path, home);
        if (relative !== undefined && relative.length > 0) return `~/${slashes(relative)}`;
    }
    return path;
}

export function pluginDetail(item: PluginItem, folder: string | undefined, home: string | undefined): string | undefined {
    if (item.kind === "plugins") return item.description || undefined;
    const command = pluginCommand(item);
    if (command !== undefined) return command;
    const path = item.source?.path;
    return path === undefined ? undefined : pluginPathLabel(path, item.scope, folder, home);
}

export function pluginOrigin(item: PluginItem): string | undefined {
    if (item.kind !== "skills" && item.kind !== "agents") return undefined;
    return item.skill?.plugin ?? item.agent?.plugin ?? item.source?.plugin;
}

export function pluginRowMeta(item: PluginItem, folder: string | undefined, home: string | undefined): PluginRowMeta {
    const origin = pluginOrigin(item) ?? (item.kind !== "extensions" ? item.extensionId : undefined);
    const extension = origin === undefined ? undefined : `From ${origin}`;
    const detail = pluginDetail(item, folder, home);
    return {
        ...(extension === undefined ? {} : { extension }),
        ...(detail === undefined ? {} : { detail }),
    };
}

// Names the rows a section hides after its first six, so the line says what opening it adds.
export function seeMoreLabel(names: readonly string[]): string | undefined {
    if (names.length === 0) return undefined;
    if (names.length === 1) return `See ${names[0]}`;
    if (names.length === 2) return `See ${names[0]} and ${names[1]}`;
    return `See ${names[0]}, ${names[1]}, and ${names.length - 2} more`;
}

// The kind's sections in the order the page stacks them. While searching, a section with no match is left out;
// otherwise In this folder and Your home always show, and Built in only when it has something.
export function pluginSections(
    items: readonly PluginItem[],
    kind: KindFilter,
    query: string,
): readonly PluginSection[] {
    const matching = visibleItems(items, kind, query);
    const searching = query.trim().length > 0;
    const scopes: readonly PluginScope[] = kind === "plugins" ? ["home"] : PLUGIN_SECTION_ORDER;
    return scopes
        .map((scope) => ({ scope, items: matching.filter((item) => item.scope === scope) }))
        .filter((section) => searching ? section.items.length > 0 : section.scope !== "builtin" || section.items.length > 0);
}

export function pluginSectionEmpty(scope: PluginScope, kind: CustomizeKind, folderLabel: string | undefined): string {
    const plural = KIND_LABELS[kind].plural.toLowerCase();
    if (scope === "folder") {
        return folderLabel === undefined
            ? `No folder is selected, so there are no ${plural} here.`
            : `No ${plural} in ${folderLabel} yet. Items from your home load here too.`;
    }
    if (scope === "home" && kind === "plugins") return "No plugins are installed. Use Add to install one.";
    if (scope === "home") return `No ${plural} in your home.`;
    return `No built-in ${plural}.`;
}

export function pluginNoMatch(kind: CustomizeKind, query: string): string {
    return `No ${KIND_LABELS[kind].plural.toLowerCase()} match “${query.trim()}”.`;
}

export function pluginSheetMeta(item: PluginItem, folder: string | undefined): readonly string[] {
    if (item.kind === "plugins") return [pluginOff(item) ? "Off" : "On"];
    const origin = pluginOrigin(item);
    if (origin !== undefined) return [`From ${origin}`, "Your home"];
    if (item.scope === "builtin") return ["Included with Vera"];
    if (item.kind === "extensions") return ["Installed extension", "Your home"];
    if (item.extensionId !== undefined) return [`From ${item.extensionId}`, "Your home"];
    return ["By you", scopeLabel(item.scope, folder)];
}

export function pluginFacts(item: PluginItem, folder: string | undefined): readonly PluginFact[] {
    const path = item.source?.path;
    const location = path ?? (item.scope === "builtin" ? "Included with Vera" : "Not available");
    if (item.kind === "plugins") {
        return [
            { label: "Location", value: location, code: path !== undefined },
            { label: "State", value: pluginOff(item) ? "Off" : "On", code: false },
            { label: "Parts", value: item.description || "None", code: false },
        ];
    }
    const command = pluginCommand(item);
    return [
        { label: "Location", value: location, code: path !== undefined },
        { label: "Scope", value: scopeLabel(item.scope, folder), code: false },
        { label: "Loads in", value: item.scope === "folder" ? `${folder ?? "This folder"} only` : "Every folder", code: false },
        { label: "Command", value: command ?? "None", code: command !== undefined },
        { label: "Files", value: item.source === undefined ? "0" : "1", code: false },
    ];
}

export function pluginExtensionOff(item: PluginItem): boolean {
    return item.extension !== undefined && !item.extension.enabled;
}

// A skill listed with status disabled is still read from disk, but it does not load.
export function pluginOff(item: PluginItem): boolean {
    return pluginExtensionOff(item) || item.source?.status === "disabled";
}

export function pluginLoaded(item: PluginItem): boolean {
    return !item.failed && !pluginOff(item);
}

// The extensions list is what the window already reads; folder_customizations carries the same ids as manifest sources.
export function pluginItems(
    reading: Pick<FolderCustomizationsAnswer, "skills" | "startsOn" | "agents" | "sources">,
    failures: readonly ExtensionFailure[],
    extensions: readonly DesktopExtensionEntry[],
): PluginItem[] {
    const installedIds = new Set(
        extensions.filter((extension) => !extension.included).map((extension) => extension.id),
    );
    const contents = new Map<string, { skills: string[]; agents: string[] }>();
    const addPart = (plugin: string | undefined, kind: "skills" | "agents", name: string): void => {
        if (plugin === undefined) return;
        let parts = contents.get(plugin);
        if (parts === undefined) {
            parts = { skills: [], agents: [] };
            contents.set(plugin, parts);
        }
        parts[kind].push(name);
    };
    for (const skill of reading.skills) addPart(skill.plugin, "skills", skill.name);
    for (const agent of reading.agents) addPart(agent.plugin, "agents", agent.name);
    const items: PluginItem[] = buildItems(reading, failures)
        .filter((item) => item.kind !== "extensions")
        .map((item): PluginItem => {
            const plugin = item.skill?.plugin ?? item.agent?.plugin ?? item.source?.plugin;
            if (item.kind === "plugins") {
                return {
                    ...item,
                    scope: "home",
                    pluginContents: contents.get(item.name) ?? { skills: [], agents: [] },
                };
            }
            if (plugin !== undefined && (item.kind === "skills" || item.kind === "agents")) {
                return { ...item, scope: "home" };
            }
            const id = item.group === "Extensions" ? extensionScopeId(item.source?.scope) : undefined;
            if (id !== undefined && installedIds.has(id)) {
                return { ...item, scope: "home", extensionId: id };
            }
            return { ...item, scope: pluginScope(item.group) };
        });
    const sources = new Map(
        reading.sources
            .filter((source) => source.category === "extensions")
            .map((source) => [source.name, source]),
    );
    for (const extension of extensions) {
        if (extension.included) continue;
        const source = sources.get(extension.id);
        const group = scopeGroup(source?.scope ?? "user");
        items.push({
            key: `extensions:desktop:${extension.id}`,
            kind: "extensions",
            name: extension.id,
            description: extensionDescription(extension),
            group,
            scope: pluginScope(group),
            failed: false,
            current: false,
            extension,
            ...(source === undefined ? {} : { source }),
        });
    }
    const known = new Set(extensions.map((extension) => extension.id));
    for (const failure of failures) {
        if (known.has(failure.extensionId)) continue;
        items.push({
            key: `extensions:failed:${failure.extensionId}`,
            kind: "extensions",
            name: failure.extensionId,
            description: failure.message,
            group: "Your home",
            scope: "home",
            failed: true,
            current: false,
        });
    }
    return items;
}

function extensionDescription(extension: DesktopExtensionEntry): string {
    if (extension.themes.length === 1) return `Adds the theme ${extension.themes[0]}.`;
    if (extension.themes.length > 1) return `Adds the themes ${extension.themes.join(", ")}.`;
    if (extension.hasCommands || extension.commands.length > 0) return "Adds commands to this window.";
    if (extension.hasMain) return "Adds a process to this window.";
    return "A desktop extension.";
}

function relativeTo(path: string, root: string): string | undefined {
    const base = root.replace(/[\\/]+$/, "");
    if (base.length === 0) return undefined;
    if (path === base) return "";
    if (path.length <= base.length) return undefined;
    const next = path.charAt(base.length);
    if ((next === "/" || next === "\\") && path.slice(0, base.length) === base) return path.slice(base.length + 1);
    return undefined;
}

function slashes(path: string): string {
    return path.replace(/[\\/]+/g, "/");
}

function basename(path: string): string {
    const trimmed = path.replace(/[\\/]+$/, "");
    const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
    return index < 0 ? trimmed : trimmed.slice(index + 1);
}
