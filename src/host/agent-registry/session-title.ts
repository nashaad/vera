import type { SessionMessageEntry, SessionStore } from "../../store/session-store.ts";

const LISTED_TITLE_LENGTH = 80;

export function firstPromptEntry(
    entries: readonly SessionMessageEntry[],
): SessionMessageEntry | undefined {
    return entries.find(
        (candidate) => candidate.message.role === "user"
            && candidate.message.internal !== true,
    );
}

// The session's name, else the start of its first prompt.
export function listedTitle(
    name: string | undefined,
    firstPrompt: SessionMessageEntry | undefined,
): string | undefined {
    const message = firstPrompt?.message;
    const title = name ?? (message?.role === "user"
        ? message.content
            .flatMap((content) => content.type === "text" ? [content.text] : [])
            .join(" ")
            .replaceAll(/\s+/g, " ")
            .trim()
        : undefined);
    return title === undefined || title.length === 0
        ? undefined
        : title.slice(0, LISTED_TITLE_LENGTH);
}

// Skips reading the branch when the session has a name.
export function storeListedTitle(store: SessionStore): string | undefined {
    const name = store.name();
    return listedTitle(
        name,
        name === undefined ? firstPromptEntry(store.activeEntries()) : undefined,
    );
}
