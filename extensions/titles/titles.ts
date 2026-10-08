import type { VeraExtensionOneshotMessage } from "../../src/sdk/extensions.ts";
import type { TurnFinishedHookPayload } from "../../src/sdk/hooks.ts";

export const TITLE_PROMPT =
    "Write a title for this conversation in six words or fewer. Reply with the title only: no quotes, no trailing punctuation.";

const MAX_PROMPT_CHARS = 2_000;
const MAX_REPLY_CHARS = 1_000;
const MAX_TITLE_CHARS = 80;

export function wantsTitle(payload: TurnFinishedHookPayload): boolean {
    return payload.turns === 1
        && !payload.spawned
        && payload.outcome === "completed"
        && payload.prompt.trim().length > 0;
}

export function titleMessages(
    payload: TurnFinishedHookPayload,
): readonly VeraExtensionOneshotMessage[] {
    const parts = [`User:\n${payload.prompt.trim().slice(0, MAX_PROMPT_CHARS)}`];
    const reply = payload.reply.trim();
    if (reply.length > 0) {
        parts.push(`Assistant:\n${reply.slice(0, MAX_REPLY_CHARS)}`);
    }
    return [{ role: "user", text: parts.join("\n\n") }];
}

// Models still wrap titles in quotes or add a full stop now and then.
export function cleanTitle(text: string): string | undefined {
    const line = text.split("\n").map((part) => part.trim()).find((part) => part.length > 0);
    if (line === undefined) return undefined;
    const title = line
        .replace(/^title:\s*/i, "")
        .replace(/^["'`*“‘]+|["'`*”’]+$/g, "")
        .replace(/[.!?:;,]+$/, "")
        .trim()
        .slice(0, MAX_TITLE_CHARS)
        .trim();
    return title.length === 0 ? undefined : title;
}
