import type {
    VeraClientExtensionOneshot,
    VeraClientOneshotRequest,
} from "../../../src/sdk/extensions.ts";
import type { DeepFileBody } from "./deep-pile.ts";

export type SdeBand = "diluted" | "standard" | "dense" | "ultra";

export interface ReadyJudge {
    readonly status: "ready";
    readonly distinctInstructions: number;
    readonly independentFamilies: number;
    readonly familyNames: readonly string[];
    readonly S: number;
    readonly W: number;
    readonly R: number;
    readonly C: number;
    readonly SDE: number;
    readonly sdeBand: SdeBand;
}

export interface UnmeasuredJudge {
    readonly status: "unmeasured";
    readonly reason: string;
}

export interface FailedJudge {
    readonly status: "failed";
    readonly reason: string;
}

export type JudgeState = ReadyJudge | UnmeasuredJudge | FailedJudge;

export interface OneshotModel {
    readonly model: string;
    readonly provider?: string;
}

/**
 * Caller-owned judge instructions. This is the oneshot `systemPrompt`, not
 * Vera's session harness: omit it and the host sends "".
 */
export const JUDGE_SYSTEM_PROMPT = [
    "You score project instruction files for always-on attention load.",
    "Read only the files in the user message. Do not use tools.",
    "Count distinct always-on instructions a model must keep: one instruction",
    "is one independently load-bearing rule, not one bullet and not one file.",
    "Group those instructions into independent families and name each family.",
    "S is substance tokens (unique instruction content).",
    "W is total instruction tokens.",
    "R is restatement from 0 to 1.",
    "C is conflict among rules from 0 to 1.",
    "Do not score dropped-rule rate. Do not invent git history.",
    "Reply with JSON only, no markdown, matching:",
    '{"distinctInstructions":0,"independentFamilies":0,"familyNames":[],',
    '"S":0,"W":0,"R":0,"C":0}',
].join(" ");

export async function judgeDeep(
    bodies: readonly DeepFileBody[],
    oneshot: VeraClientExtensionOneshot,
    model: OneshotModel,
): Promise<JudgeState> {
    if (bodies.length === 0) {
        return {
            status: "ready",
            distinctInstructions: 0,
            independentFamilies: 0,
            familyNames: [],
            S: 0,
            W: 0,
            R: 0,
            C: 0,
            SDE: 0,
            sdeBand: sdeBand(0),
        };
    }
    const request: VeraClientOneshotRequest = {
        model: model.model,
        ...(model.provider === undefined ? {} : { provider: model.provider }),
        systemPrompt: JUDGE_SYSTEM_PROMPT,
        messages: [{
            role: "user",
            content: renderJudgeUserMessage(bodies),
        }],
    };
    let text: string;
    try {
        const result = await oneshot(request);
        text = result.text;
    } catch (error) {
        return {
            status: "failed",
            reason: error instanceof Error ? error.message : String(error),
        };
    }
    return parseJudgeText(text);
}

export function parseJudgeText(text: string): JudgeState {
    const parsed = parseJsonObject(text);
    if (parsed === undefined) {
        return { status: "failed", reason: "Judge reply was not JSON." };
    }
    const distinctInstructions = requiredNonNegativeInteger(
        parsed,
        "distinctInstructions",
    );
    const independentFamilies = requiredNonNegativeInteger(
        parsed,
        "independentFamilies",
    );
    const familyNames = requiredStringArray(parsed, "familyNames");
    const S = requiredNonNegativeNumber(parsed, "S");
    const W = requiredNonNegativeNumber(parsed, "W");
    const R = requiredUnitInterval(parsed, "R");
    const C = requiredUnitInterval(parsed, "C");
    if (
        distinctInstructions === undefined
        || independentFamilies === undefined
        || familyNames === undefined
        || S === undefined
        || W === undefined
        || R === undefined
        || C === undefined
    ) {
        return {
            status: "failed",
            reason: "Judge JSON was missing or invalid fields.",
        };
    }
    if (familyNames.length !== independentFamilies) {
        return {
            status: "failed",
            reason: "Judge family count did not match family names.",
        };
    }
    const SDE = computeSde(S, W, R, C);
    return {
        status: "ready",
        distinctInstructions,
        independentFamilies,
        familyNames,
        S,
        W,
        R,
        C,
        SDE,
        sdeBand: sdeBand(SDE),
    };
}

export function computeSde(S: number, W: number, R: number, C: number): number {
    if (W <= 0) {
        return 0;
    }
    return round2((S / W) * (1 - R) * C);
}

export function sdeBand(value: number): SdeBand {
    if (value < 0.40) {
        return "diluted";
    }
    if (value < 0.65) {
        return "standard";
    }
    if (value <= 0.80) {
        return "dense";
    }
    return "ultra";
}

function renderJudgeUserMessage(bodies: readonly DeepFileBody[]): string {
    const files = bodies.map((file) =>
        `## ${file.name}\n${file.content}`
    ).join("\n\n");
    return `Score these project instruction files.\n\n${files}`;
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
    const candidates = [text.trim()];
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced?.[1] !== undefined) {
        candidates.push(fenced[1].trim());
    }
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
        candidates.push(text.slice(start, end + 1));
    }
    for (const candidate of candidates) {
        try {
            const value = JSON.parse(candidate) as unknown;
            if (
                typeof value === "object"
                && value !== null
                && !Array.isArray(value)
            ) {
                return value as Record<string, unknown>;
            }
        } catch {
            continue;
        }
    }
    return undefined;
}

function requiredNonNegativeInteger(
    value: Record<string, unknown>,
    key: string,
): number | undefined {
    const field = value[key];
    if (typeof field !== "number" || !Number.isInteger(field) || field < 0) {
        return undefined;
    }
    return field;
}

function requiredNonNegativeNumber(
    value: Record<string, unknown>,
    key: string,
): number | undefined {
    const field = value[key];
    if (typeof field !== "number" || !Number.isFinite(field) || field < 0) {
        return undefined;
    }
    return field;
}

function requiredUnitInterval(
    value: Record<string, unknown>,
    key: string,
): number | undefined {
    const field = requiredNonNegativeNumber(value, key);
    if (field === undefined || field > 1) {
        return undefined;
    }
    return field;
}

function requiredStringArray(
    value: Record<string, unknown>,
    key: string,
): readonly string[] | undefined {
    const field = value[key];
    if (!Array.isArray(field) || field.some((item) => typeof item !== "string")) {
        return undefined;
    }
    return field;
}

function round2(value: number): number {
    return Math.round(value * 100) / 100;
}
