import { promptCommand } from "../session/wire.ts";
import { sessionModeCommand } from "../session/permissions.ts";

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

// The session mode change the mode picker sends, for answer 3 on an approval card.
export function sendSessionMode(send: (line: string) => void, mode: string): void {
    send(sessionModeCommand(freshRequestId("mode"), mode));
}
