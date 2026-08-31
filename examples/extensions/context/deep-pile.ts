import { loadProjectInstructions } from "../../../src/engine/project-instructions.ts";

/**
 * Same estimator the engine uses for projected request size. The result is
 * labelled an estimate until a tokenizer exists.
 */
export const CHARACTERS_PER_TOKEN = 4;

const MODAL = /\b(must|never|always|do not|don't|cannot)\b/gi;
const LIST_ITEM = /^\s*(?:[-*+]|\d+\.)\s+/;

export interface DeepPileFile {
    readonly name: string;
    readonly path: string;
    readonly bytes: number;
    readonly lines: number;
    readonly tokensEst: number;
    readonly modalVerbs: number;
    readonly listItems: number;
}

export interface DeepPileSnapshot {
    readonly workspace: string;
    readonly files: readonly DeepPileFile[];
    readonly warnings: readonly string[];
    readonly bytes: number;
    readonly lines: number;
    readonly tokensEst: number;
    readonly modalVerbs: number;
    readonly listItems: number;
}

export interface DeepFileBody {
    readonly name: string;
    readonly content: string;
}

export interface DeepPileMeasurement {
    readonly pile: DeepPileSnapshot;
    readonly bodies: readonly DeepFileBody[];
}

export async function measureDeepPile(
    workspace: string,
): Promise<DeepPileMeasurement> {
    const snapshot = await loadProjectInstructions(workspace);
    const files: DeepPileFile[] = [];
    const bodies: DeepFileBody[] = [];
    for (const file of snapshot.files) {
        files.push({
            name: file.name,
            path: file.path,
            bytes: file.bytes,
            lines: lineCount(file.content),
            tokensEst: estimateTokens(file.content),
            modalVerbs: countMatches(file.content, MODAL),
            listItems: file.content.split("\n")
                .filter((line) => LIST_ITEM.test(line)).length,
        });
        bodies.push({ name: file.name, content: file.content });
    }
    return {
        pile: {
            workspace,
            files,
            warnings: [...snapshot.warnings],
            bytes: sum(files, (file) => file.bytes),
            lines: sum(files, (file) => file.lines),
            tokensEst: sum(files, (file) => file.tokensEst),
            modalVerbs: sum(files, (file) => file.modalVerbs),
            listItems: sum(files, (file) => file.listItems),
        },
        bodies,
    };
}

export function estimateTokens(text: string): number {
    if (text.length === 0) {
        return 0;
    }
    return Math.max(1, Math.round(text.length / CHARACTERS_PER_TOKEN));
}

function lineCount(text: string): number {
    if (text.length === 0) {
        return 0;
    }
    return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

function countMatches(text: string, pattern: RegExp): number {
    return [...text.matchAll(new RegExp(pattern.source, pattern.flags))].length;
}

function sum<T>(items: readonly T[], read: (item: T) => number): number {
    return items.reduce((total, item) => total + read(item), 0);
}
