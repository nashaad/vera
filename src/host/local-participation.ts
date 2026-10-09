import type { InboxEntry } from "../store/inbox.ts";

export const PEER_MESSAGE_KIND = "peer.message";
// Older inboxes may still hold read receipts; they are never counted, read, or woken for.
export const RETIRED_PEER_READ_KIND = "peer.read";
export const VERA_INBOX_SOURCE = "vera";

export interface PeerMessagePayload {
    readonly version: 1;
    readonly from: string;
    readonly to: string;
    readonly text: string;
    readonly reply_to?: number;
}


export function parsePeerMessage(entry: InboxEntry): PeerMessagePayload | undefined {
    if (
        entry.source !== VERA_INBOX_SOURCE
        || entry.kind !== PEER_MESSAGE_KIND
        || entry.actor === null
        || entry.address === null
    ) {
        return undefined;
    }
    const value = parseObject(entry.payload);
    if (
        value === undefined
        || value.version !== 1
        || typeof value.from !== "string"
        || value.from !== entry.actor
        || typeof value.to !== "string"
        || value.to !== entry.address
        || typeof value.text !== "string"
        || (
            value.reply_to !== undefined
            && (!Number.isSafeInteger(value.reply_to) || (value.reply_to as number) <= 0)
        )
    ) {
        return undefined;
    }
    return {
        version: 1,
        from: value.from,
        to: value.to,
        text: value.text,
        ...(value.reply_to === undefined
            ? {}
            : { reply_to: value.reply_to as number }),
    };
}

function parseObject(text: string): Record<string, unknown> | undefined {
    try {
        const value: unknown = JSON.parse(text);
        return isRecord(value) ? value : undefined;
    } catch {
        return undefined;
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
