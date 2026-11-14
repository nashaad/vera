import { sessionModeCommand } from "../session/permissions.ts";
import { promptCommand } from "../session/wire.ts";

export interface SentPrompt {
    readonly requestId: string;
    readonly text: string;
}

let requestCount = 0;

// Unique across windows and reloads, so a reply on a shared session never matches another window's request.
export function freshRequestId(kind: string): string {
    requestCount += 1;
    return `desktop-${kind}-${Date.now().toString(36)}-${requestCount}`;
}

// Writes a prompt line with a fresh request id and returns what was sent, so a refusal can be matched back.
export function sendPrompt(
    send: (line: string) => void,
    text: string,
    attachmentIds: readonly string[] = [],
): SentPrompt {
    const requestId = freshRequestId("prompt");
    send(promptCommand(text, requestId, attachmentIds));
    return { requestId, text };
}

// Changes one session's approval mode. The approval pill and the auto suggestion both send it this way.
export function sendSessionMode(send: (line: string) => void, mode: string): string {
    const requestId = freshRequestId("mode");
    send(sessionModeCommand(requestId, mode));
    return requestId;
}
