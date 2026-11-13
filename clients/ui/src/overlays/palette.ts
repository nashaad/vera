import type { Command } from "../commands/registry.ts";
import { acceleratorKeys, NATIVE_SHORTCUTS } from "../commands/keys.ts";
import { rowFolderName } from "../protocol/sessionGroups.ts";
import { relativeTime, type SessionRow } from "../protocol/sessions.ts";

export const PALETTE_LIMIT = 50;

export type CommandGroup = "Go" | "Pages" | "Window" | "Session" | "Theme" | "Help" | "Other";

const GROUP_ORDER: readonly CommandGroup[] = ["Go", "Pages", "Window", "Session", "Theme", "Help", "Other"];

// One row of either palette mode. Sessions have no group; `fields` are the texts a query is matched against.
export interface PaletteItem {
    readonly id: string;
    readonly label: string;
    readonly group: string;
    readonly detail: string;
    readonly age: string;
    readonly keys: readonly string[];
    readonly status: "working" | "waiting" | undefined;
    readonly fields: readonly string[];
}

export interface RankedItem {
    readonly item: PaletteItem;
    // Positions in the label that the query matched, for bolding.
    readonly indices: readonly number[];
}

export interface PaletteSection {
    readonly title: string;
    readonly entries: readonly { readonly ranked: RankedItem; readonly index: number }[];
}

export function commandGroup(id: string): CommandGroup {
    if (id.startsWith("go.")) return "Go";
    if (id.startsWith("page.")) return "Pages";
    if (id.startsWith("layout.") || id.startsWith("view.") || id.startsWith("container.")) return "Window";
    if (id.startsWith("session.")) return "Session";
    if (id.startsWith("theme.")) return "Theme";
    if (id.startsWith("help.") || id.startsWith("palette.")) return "Help";
    return "Other";
}

function shortcutKeys(id: string, platform: string): readonly string[] {
    const shortcut = NATIVE_SHORTCUTS.find((entry) => entry.command === id);
    return shortcut === undefined ? [] : acceleratorKeys(shortcut.accelerator, platform);
}

// Commands that need arguments cannot run from a list, and the palette does not list itself.
export function buildCommandItems(commands: readonly Command[], platform: string): readonly PaletteItem[] {
    const items = commands
        .filter((command) => command.needsArgs !== true && command.id !== "palette.commands")
        .map((command): PaletteItem => ({
            id: command.id,
            label: command.title,
            group: commandGroup(command.id),
            detail: "",
            age: "",
            keys: shortcutKeys(command.id, platform),
            status: undefined,
            fields: [command.title],
        }));
    return items.sort((left, right) => {
        const byGroup = GROUP_ORDER.indexOf(left.group as CommandGroup) - GROUP_ORDER.indexOf(right.group as CommandGroup);
        return byGroup !== 0 ? byGroup : left.label.localeCompare(right.label);
    });
}

export function buildSessionItems(rows: readonly SessionRow[], now: number): readonly PaletteItem[] {
    return rows.map((row): PaletteItem => {
        const folder = rowFolderName(row);
        const status = row.status === "working" || row.status === "waiting" ? row.status : undefined;
        return {
            id: row.id,
            label: row.name,
            group: "",
            detail: folder,
            age: relativeTime(row.updatedAt, now),
            keys: [],
            status,
            fields: [row.name, folder],
        };
    });
}

export interface Fuzzy {
    readonly score: number;
    readonly indices: readonly number[];
}

const SEPARATORS = /[\s/._\-:@#>]/;
// A run of consecutive characters always outranks scattered characters.
const CONTIGUOUS_BASE = 1000;
const SCATTERED_CAP = 900;

function isWordStart(text: string, at: number): boolean {
    return at === 0 || SEPARATORS.test(text.charAt(at - 1));
}

// Ranks one needle against one haystack; undefined when the needle's characters do not appear in order.
export function fuzzyMatch(needle: string, haystack: string): Fuzzy | undefined {
    const wanted = needle.toLowerCase();
    const text = haystack.toLowerCase();
    if (wanted.length === 0) return { score: 0, indices: [] };

    const at = text.indexOf(wanted);
    if (at !== -1) {
        const wordBonus = at === 0 ? 300 : isWordStart(text, at) ? 150 : 0;
        const shortness = (wanted.length / text.length) * 50;
        const indices = Array.from({ length: wanted.length }, (_, offset) => at + offset);
        return { score: CONTIGUOUS_BASE + wordBonus - Math.min(at, 100) + shortness, indices };
    }

    const indices: number[] = [];
    let score = 0;
    let run = 0;
    let from = 0;
    for (const character of wanted) {
        const found = text.indexOf(character, from);
        if (found === -1) return undefined;
        const last = indices[indices.length - 1];
        run = last !== undefined && found === last + 1 ? run + 1 : 0;
        score += 1 + (isWordStart(text, found) ? 8 : 0) + run * 4;
        indices.push(found);
        from = found + 1;
    }
    const first = indices[0] ?? 0;
    score -= Math.min(first, 20) * 0.15;
    return { score: Math.min(score, SCATTERED_CAP), indices };
}

// Every word of the query must match some field; the best field's score for each word adds up.
function matchItem(item: PaletteItem, words: readonly string[]): { readonly ranked: RankedItem; readonly score: number } | undefined {
    let total = 0;
    const indices = new Set<number>();
    for (const word of words) {
        let best: Fuzzy | undefined;
        for (const field of item.fields) {
            const match = fuzzyMatch(word, field);
            if (match !== undefined && (best === undefined || match.score > best.score)) best = match;
        }
        if (best === undefined) return undefined;
        total += best.score;
        const labelMatch = fuzzyMatch(word, item.label);
        if (labelMatch !== undefined) for (const index of labelMatch.indices) indices.add(index);
    }
    return { ranked: { item, indices: [...indices].sort((left, right) => left - right) }, score: total };
}

// An empty query keeps the items' own order. Otherwise the best score comes first, ties keep their order.
export function rankItems(items: readonly PaletteItem[], query: string, limit: number = PALETTE_LIMIT): readonly RankedItem[] {
    const words = query.trim().toLowerCase().split(/\s+/).filter((word) => word.length > 0);
    if (words.length === 0) return items.slice(0, limit).map((item) => ({ item, indices: [] }));
    const scored: { readonly ranked: RankedItem; readonly score: number }[] = [];
    for (const item of items) {
        const match = matchItem(item, words);
        if (match !== undefined) scored.push(match);
    }
    scored.sort((left, right) => right.score - left.score);
    return scored.slice(0, limit).map((entry) => entry.ranked);
}

export interface LabelSegment {
    readonly text: string;
    readonly hit: boolean;
}

// Splits a label into runs of matched and unmatched text, for bolding what the query matched.
export function labelSegments(text: string, indices: readonly number[]): readonly LabelSegment[] {
    const matched = new Set(indices);
    const segments: LabelSegment[] = [];
    for (let at = 0; at < text.length; at += 1) {
        const hit = matched.has(at);
        const last = segments[segments.length - 1];
        if (last !== undefined && last.hit === hit) {
            segments[segments.length - 1] = { text: last.text + text.charAt(at), hit };
        } else {
            segments.push({ text: text.charAt(at), hit });
        }
    }
    return segments;
}

// Sections keep the order of their first entry, so an empty query shows the groups in their fixed order.
export function sectionRows(ranked: readonly RankedItem[]): readonly PaletteSection[] {
    const sections = new Map<string, { readonly ranked: RankedItem; readonly index: number }[]>();
    ranked.forEach((entry, index) => {
        const title = entry.item.group;
        const list = sections.get(title) ?? [];
        list.push({ ranked: entry, index });
        sections.set(title, list);
    });
    return [...sections].map(([title, entries]) => ({ title, entries }));
}
