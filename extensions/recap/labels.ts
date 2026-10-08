import type { JsonValue } from "../../src/sdk/hooks.ts";
import type { RecapPhase } from "./model.ts";

export const LABEL_PROMPT = [
    "You name the phases of a coding conversation for a timeline.",
    "For each numbered phase, write one line of eight words or fewer saying what got done, past tense, like a commit subject.",
    "Name the thing, not the request: \"Fixed the compaction bar sweep\", not \"User asked about the bar\".",
    "Keep wording consistent with the earlier titles you are shown.",
    "Reply with one line per phase, as `<number>: <title>`, and nothing else.",
].join(" ");

const MAX_PROMPT_CHARS = 400;
const MAX_REPLY_CHARS = 600;
const MAX_LISTED = 8;
const MAX_LABEL_CHARS = 60;
// Older phases keep their built titles; one open never sends a whole long session.
export const MAX_LABELLED_PHASES = 30;
const CONTEXT_TITLES = 6;

/** What the client sends its host side: facts only, never the rows. */
export interface LabelRequest {
    readonly earlier: readonly string[];
    readonly phases: readonly PhaseFacts[];
}

export interface PhaseFacts {
    readonly prompts: readonly string[];
    readonly done: readonly string[];
    readonly files: readonly string[];
    readonly commits: readonly string[];
    readonly tests?: "passed" | "failed";
    readonly reply?: string;
}

export function labelRequest(phases: readonly RecapPhase[], earlier: readonly string[]): LabelRequest {
    return {
        earlier: earlier.slice(-CONTEXT_TITLES),
        phases: phases.map((phase) => ({
            prompts: phase.prompts.map((prompt) => clip(prompt, MAX_PROMPT_CHARS)).slice(0, MAX_LISTED),
            done: phase.doneItems.slice(0, MAX_LISTED),
            files: phase.editedPaths.slice(0, MAX_LISTED),
            commits: phase.marks.flatMap((mark) => mark.kind === "commit" ? [mark.text] : []).slice(0, MAX_LISTED),
            ...(phase.tests === undefined ? {} : { tests: phase.tests }),
            ...(phase.reply === undefined ? {} : { reply: clip(phase.reply, MAX_REPLY_CHARS) }),
        })),
    };
}

// The payload crosses from client to host, so the host checks its shape before trusting it.
export function readLabelRequest(payload: JsonValue): LabelRequest | undefined {
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return undefined;
    const { earlier, phases } = payload as { earlier?: unknown; phases?: unknown };
    if (!isStrings(earlier) || !Array.isArray(phases)) return undefined;
    const facts: PhaseFacts[] = [];
    for (const phase of phases) {
        if (phase === null || typeof phase !== "object") return undefined;
        const { prompts, done, files, commits, tests, reply } = phase as Record<string, unknown>;
        if (!isStrings(prompts) || !isStrings(done) || !isStrings(files) || !isStrings(commits)) return undefined;
        if (tests !== undefined && tests !== "passed" && tests !== "failed") return undefined;
        if (reply !== undefined && typeof reply !== "string") return undefined;
        facts.push({
            prompts,
            done,
            files,
            commits,
            ...(tests === undefined ? {} : { tests }),
            ...(reply === undefined ? {} : { reply }),
        });
    }
    return { earlier, phases: facts };
}

export function labelMessage(request: LabelRequest): string {
    const parts: string[] = [];
    if (request.earlier.length > 0) {
        parts.push(`Earlier titles:\n${request.earlier.map((title) => `- ${title}`).join("\n")}`);
    }
    request.phases.forEach((phase, index) => {
        const lines = [`Phase ${index + 1}`];
        for (const prompt of phase.prompts) lines.push(`User: ${prompt}`);
        for (const item of phase.done) lines.push(`Checked off: ${item}`);
        if (phase.files.length > 0) lines.push(`Edited: ${phase.files.join(", ")}`);
        for (const commit of phase.commits) lines.push(`Committed: ${commit}`);
        if (phase.tests !== undefined) lines.push(`Tests: ${phase.tests}`);
        if (phase.reply !== undefined) lines.push(`Last reply: ${phase.reply}`);
        parts.push(lines.join("\n"));
    });
    return parts.join("\n\n");
}

/** One title per phase, in order; a line the model skipped or mangled is undefined. */
export function parseLabels(text: string, count: number): (string | undefined)[] {
    const labels: (string | undefined)[] = Array.from({ length: count }, () => undefined);
    for (const line of text.split("\n")) {
        const match = /^[\s*#-]*(?:phase\s+)?(\d+)\s*[:.)-]\s*(.+)$/i.exec(line);
        if (match === null) continue;
        const index = Number(match[1]) - 1;
        if (index < 0 || index >= count || labels[index] !== undefined) continue;
        labels[index] = cleanLabel(match[2]!);
    }
    return labels;
}

// Models still wrap titles in quotes or bold, or add a full stop.
function cleanLabel(text: string): string | undefined {
    const label = text
        .replace(/^["'`*“‘]+|["'`*”’]+$/g, "")
        .replace(/[.!?:;,]+$/, "")
        .replace(/\s+/g, " ")
        .trim();
    if (label.length === 0) return undefined;
    return label.length <= MAX_LABEL_CHARS ? label : `${label.slice(0, MAX_LABEL_CHARS - 1).trimEnd()}…`;
}

function clip(text: string, max: number): string {
    const flat = text.replace(/\s+/g, " ").trim();
    return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function isStrings(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((item) => typeof item === "string");
}
