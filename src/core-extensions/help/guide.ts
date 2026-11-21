import { readFileSync } from "node:fs";
import { join } from "node:path";

import { runtimePath } from "../../release/runtime-path.ts";

export const MAX_READ_CHARACTERS = 8_000;

export interface GuideSection {
    readonly name: string;
    // The section as its file has it, heading line first.
    readonly text: string;
}

export type GuideLookup =
    | { readonly kind: "found"; readonly section: GuideSection }
    | { readonly kind: "missing" }
    | { readonly kind: "ambiguous"; readonly names: readonly string[] };

export interface GuidePage {
    readonly text: string;
    // The offset of the next page, when the section continues.
    readonly next: number | undefined;
    readonly total: number;
}

const HEADING = /^#{1,2} (.+?)\s*$/;
const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---\r?\n/;

export function guideDirectory(): string {
    return runtimePath(
        join(import.meta.dir, "../../skills/bundled/vera-help"),
        "src/skills/bundled/vera-help",
    );
}

// llms.txt sections first, then the skill's own page. Text before a file's first heading is dropped.
export function loadGuideSections(directory: string = guideDirectory()): readonly GuideSection[] {
    return ["llms.txt", "SKILL.md"].flatMap((file) =>
        parseGuideSections(readFileSync(join(directory, file), "utf8")));
}

export function parseGuideSections(source: string): readonly GuideSection[] {
    const sections: { name: string; lines: string[] }[] = [];
    for (const line of source.replace(FRONTMATTER, "").split("\n")) {
        const heading = HEADING.exec(line);
        if (heading !== null) {
            sections.push({ name: heading[1]!, lines: [line] });
        } else {
            sections.at(-1)?.lines.push(line);
        }
    }
    return sections.map((section) => ({
        name: section.name,
        text: section.lines.join("\n").trimEnd(),
    }));
}

function normalized(name: string): string {
    return name.toLowerCase().replace(/\s+/g, " ").trim();
}

// An exact name wins, then a name that starts with the query, then one that contains it.
export function findGuideSection(
    sections: readonly GuideSection[],
    query: string,
): GuideLookup {
    const wanted = normalized(query);
    if (wanted.length === 0) return { kind: "missing" };
    const matches = [
        (name: string) => name === wanted,
        (name: string) => name.startsWith(wanted),
        (name: string) => name.includes(wanted),
    ].map((test) => sections.filter((section) => test(normalized(section.name))));
    for (const found of matches) {
        if (found.length === 1) return { kind: "found", section: found[0]! };
        if (found.length > 1) return { kind: "ambiguous", names: found.map((section) => section.name) };
    }
    return { kind: "missing" };
}

// A page ends at a line break when one falls in its second half.
export function readGuidePage(section: GuideSection, offset: number): GuidePage {
    const total = section.text.length;
    let end = Math.min(total, offset + MAX_READ_CHARACTERS);
    if (end < total) {
        const lineEnd = section.text.lastIndexOf("\n", end - 1);
        if (lineEnd >= offset + MAX_READ_CHARACTERS / 2) end = lineEnd + 1;
    }
    return {
        text: section.text.slice(offset, end),
        next: end < total ? end : undefined,
        total,
    };
}
