// The places the window watches a session from, each over a connection of its own in the shell.

export const CHAT_PANE_LIMIT = 16;

export type ChatPane = `chat:${number}`;

export type SessionPane = "main" | "subagent" | ChatPane;

const FIXED_PANES: readonly SessionPane[] = ["main", "subagent"];
const CHAT_PANE = /^chat:(0|[1-9]\d{0,2})$/;

export function chatPane(slot: number): ChatPane {
    return `chat:${slot}`;
}

export function isChatPane(pane: SessionPane): pane is ChatPane {
    return pane.startsWith("chat:");
}

// What the shell accepts from the window: a fixed pane or a chat slot below the limit.
export function isSessionPane(value: unknown): value is SessionPane {
    if (typeof value !== "string") return false;
    if (FIXED_PANES.includes(value as SessionPane)) return true;
    const match = CHAT_PANE.exec(value);
    return match !== null && Number(match[1]) < CHAT_PANE_LIMIT;
}
