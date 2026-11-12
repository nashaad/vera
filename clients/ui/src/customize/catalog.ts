import type { ExtensionFailure } from "../protocol/bridge.ts";
import type { SessionRow } from "../protocol/sessions.ts";
import type { ProbeState } from "./probe.ts";
import type { AgentInfo, SkillInfo, SourceCategory, SourceInfo } from "./wire.ts";

export type CustomizeKind = SourceCategory;
export type KindFilter = "all" | CustomizeKind;
export type ScopeGroup = "This folder" | "Your home" | "Extensions" | "Included with Vera" | "Built in" | "Other";

export interface CustomizeItem {
    // Unique within one build; React keys and test lookups use it.
    readonly key: string;
    readonly kind: CustomizeKind;
    readonly name: string;
    readonly description: string;
    readonly group: ScopeGroup;
    readonly failed: boolean;
    readonly current: boolean;
    readonly skill?: SkillInfo;
    readonly agent?: AgentInfo;
    readonly source?: SourceInfo;
}

export interface ScopeSection {
    readonly group: ScopeGroup;
    readonly items: readonly CustomizeItem[];
}

export const FOLDER_LIMIT = 50;

export const KIND_ORDER: readonly CustomizeKind[] = ["skills", "agents", "extensions", "instructions", "memory"];
const SCOPE_ORDER: readonly ScopeGroup[] = ["This folder", "Your home", "Extensions", "Included with Vera", "Built in", "Other"];

// Maps the scope strings the host sends (project, user, extension, extension <id>, core, included, system).
export function scopeGroup(scope: string | undefined): ScopeGroup {
    if (scope === "project") return "This folder";
    if (scope === "user") return "Your home";
    if (scope === "extension" || scope?.startsWith("extension ") === true) return "Extensions";
    if (scope === "included" || scope === "core") return "Included with Vera";
    if (scope === "system") return "Built in";
    return "Other";
}

// Skill and agent sources are matched to their cards by name only, so two same-named entries pair in list order.
export function buildItems(probe: ProbeState, failures: readonly ExtensionFailure[]): CustomizeItem[] {
    const sources = probe.sources ?? [];
    const skillSources = sourcesByName(sources, "skills");
    const agentSources = sourcesByName(sources, "agents");
    const items: CustomizeItem[] = [];
    const add = (entry: Omit<CustomizeItem, "key">): void => {
        items.push({ ...entry, key: `${entry.kind}:${items.length}` });
    };

    for (const skill of probe.skills ?? []) {
        const source = claim(skillSources, skill.name);
        add({
            kind: "skills",
            name: skill.name,
            description: skill.description || source?.description || "",
            group: scopeGroup(source?.scope),
            failed: false,
            current: false,
            skill,
            ...(source === undefined ? {} : { source }),
        });
    }
    const selected = probe.agents?.selected;
    for (const agent of probe.agents?.agents ?? []) {
        const source = claim(agentSources, agent.name);
        add({
            kind: "agents",
            name: agent.name,
            description: agent.description ?? source?.description ?? "",
            group: scopeGroup(agent.scope),
            failed: false,
            current: agent.name === selected,
            agent,
            ...(source === undefined ? {} : { source }),
        });
    }
    // Skill and agent sources with no matching card still show, so nothing listed is dropped.
    for (const list of [...skillSources.values(), ...agentSources.values()]) {
        for (const source of list) {
            add(sourceEntry(source));
        }
    }
    const extensionNames = new Set<string>();
    for (const source of sources) {
        if (source.category === "extensions") extensionNames.add(source.name);
        if (source.category === "skills" || source.category === "agents") continue;
        add(sourceEntry(source));
    }
    for (const failure of failures) {
        if (extensionNames.has(failure.extensionId)) continue;
        add({
            kind: "extensions",
            name: failure.extensionId,
            description: failure.message,
            group: "Extensions",
            failed: true,
            current: false,
        });
    }
    return items;
}

function sourceEntry(source: SourceInfo): Omit<CustomizeItem, "key"> {
    return {
        kind: source.category,
        name: source.name,
        description: source.description,
        group: scopeGroup(source.scope),
        failed: false,
        current: false,
        source,
    };
}

function sourcesByName(sources: readonly SourceInfo[], category: "skills" | "agents"): Map<string, SourceInfo[]> {
    const byName = new Map<string, SourceInfo[]>();
    for (const source of sources) {
        if (source.category !== category) continue;
        const list = byName.get(source.name);
        if (list === undefined) byName.set(source.name, [source]);
        else list.push(source);
    }
    return byName;
}

function claim(byName: Map<string, SourceInfo[]>, name: string): SourceInfo | undefined {
    const list = byName.get(name);
    const source = list?.shift();
    if (list !== undefined && list.length === 0) byName.delete(name);
    return source;
}

export function kindCounts(items: readonly CustomizeItem[]): Readonly<Record<KindFilter, number>> {
    const counts: Record<KindFilter, number> = { all: items.length, skills: 0, agents: 0, extensions: 0, instructions: 0, memory: 0 };
    for (const item of items) counts[item.kind] += 1;
    return counts;
}

// The query matches names and descriptions, ignoring case and outer spaces.
export function visibleItems(items: readonly CustomizeItem[], kind: KindFilter, query: string): CustomizeItem[] {
    const needle = query.trim().toLowerCase();
    return items.filter((item) => {
        if (kind !== "all" && item.kind !== kind) return false;
        if (needle.length === 0) return true;
        return item.name.toLowerCase().includes(needle) || item.description.toLowerCase().includes(needle);
    });
}

export function groupByScope(items: readonly CustomizeItem[]): ScopeSection[] {
    const sections: ScopeSection[] = [];
    for (const group of SCOPE_ORDER) {
        const members = items
            .filter((item) => item.group === group)
            .sort((left, right) => KIND_ORDER.indexOf(left.kind) - KIND_ORDER.indexOf(right.kind) || left.name.localeCompare(right.name));
        if (members.length > 0) sections.push({ group, items: members });
    }
    return sections;
}

// Folders of the listed sessions, most recently active first. Rows without a folder and chats are skipped.
export function folderChoices(rows: readonly SessionRow[], limit: number = FOLDER_LIMIT): string[] {
    const newest = new Map<string, number>();
    for (const row of rows) {
        if (row.chat || row.workspace.length === 0) continue;
        const at = row.updatedAt ?? Number.NEGATIVE_INFINITY;
        const seen = newest.get(row.workspace);
        if (seen === undefined || at > seen) newest.set(row.workspace, at);
    }
    // Array sort is stable, so folders with the same time keep the order the rows gave them.
    const ordered = [...newest.entries()].sort((left, right) => {
        if (left[1] === right[1]) return 0;
        return left[1] > right[1] ? -1 : 1;
    });
    return ordered.slice(0, limit).map(([folder]) => folder);
}

// The parent directory of a path, accepting both slash styles.
export function dirname(path: string): string {
    const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
    if (index < 0) return ".";
    if (index === 0) return path.slice(0, 1);
    return path.slice(0, index);
}

export interface KindLabel {
    readonly singular: string;
    readonly plural: string;
}

export const KIND_LABELS: Readonly<Record<CustomizeKind, KindLabel>> = {
    skills: { singular: "Skill", plural: "Skills" },
    agents: { singular: "Agent", plural: "Agents" },
    extensions: { singular: "Extension", plural: "Extensions" },
    instructions: { singular: "Instructions", plural: "Instructions" },
    memory: { singular: "Memory", plural: "Memory" },
};

export interface CardBadge {
    readonly label: string;
    readonly danger: boolean;
}

// Source statuses that say nothing a card does not already show.
const QUIET_STATUSES: readonly string[] = ["available", "enabled", "explicit invocation only"];

export function cardBadges(item: CustomizeItem): CardBadge[] {
    if (item.failed) return [{ label: "Failed to load", danger: true }];
    const badges: CardBadge[] = [];
    if (item.current) badges.push({ label: "Current", danger: false });
    if (item.skill?.manualOnly === true) badges.push({ label: "Manual only", danger: false });
    const status = item.source?.status;
    if (status !== undefined && !QUIET_STATUSES.includes(status)) badges.push({ label: status, danger: false });
    const tools = item.agent?.tools?.length ?? 0;
    if (tools > 0) badges.push({ label: `${tools} ${tools === 1 ? "tool" : "tools"}`, danger: false });
    const skills = item.agent?.skills?.length ?? 0;
    if (skills > 0) badges.push({ label: `${skills} ${skills === 1 ? "skill" : "skills"}`, danger: false });
    return badges;
}

export interface ItemFact {
    readonly label: string;
    readonly value: string;
    readonly code: boolean;
}

// Facts for the detail sheet; entries with no value are left out.
export function itemFacts(item: CustomizeItem): ItemFact[] {
    const statuses: string[] = [];
    if (item.failed) statuses.push("Failed to load");
    if (item.current) statuses.push("Current agent");
    if (item.skill?.manualOnly === true) statuses.push("Manual only");
    if (item.source?.status !== undefined) statuses.push(item.source.status);
    const candidates: ItemFact[] = [
        { label: "Kind", value: KIND_LABELS[item.kind].singular, code: false },
        { label: "Scope", value: item.group, code: false },
        { label: "Status", value: statuses.join(", "), code: false },
        { label: "Path", value: item.source?.path ?? "", code: true },
        { label: "Description", value: item.description, code: false },
        { label: "Tools", value: (item.agent?.tools ?? []).join(", "), code: false },
        { label: "Skills", value: (item.agent?.skills ?? []).join(", "), code: false },
        { label: "Posture", value: item.agent?.posture ?? "", code: false },
        { label: "Default model", value: item.agent?.defaultModel ?? "", code: true },
        { label: "Effort", value: item.agent?.defaultEffort ?? "", code: false },
    ];
    return candidates.filter((fact) => fact.value.length > 0);
}
