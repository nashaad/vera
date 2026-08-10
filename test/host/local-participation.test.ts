import { expect, test } from "bun:test";

import {
    parsePeerMessage,
    parsePeerRead,
} from "../../src/host/local-participation.ts";
import type { InboxEntry } from "../../src/store/inbox.ts";

test("peer payload parsing cross-checks host-owned actor and address", () => {
    const entry = peerEntry({
        payload: JSON.stringify({
            version: 1,
            from: "left",
            to: "right",
            text: "review this",
            reply_to: 4,
        }),
    });

    expect(parsePeerMessage(entry)).toEqual({
        version: 1,
        from: "left",
        to: "right",
        text: "review this",
        reply_to: 4,
    });
    expect(parsePeerMessage({ ...entry, actor: "forged" })).toBeUndefined();
    expect(parsePeerMessage({ ...entry, address: "other" })).toBeUndefined();
});

test("peer payload parsing rejects malformed reply identities", () => {
    const entry = peerEntry({
        payload: JSON.stringify({
            version: 1,
            from: "left",
            to: "right",
            text: "review this",
            reply_to: 0,
        }),
    });

    expect(parsePeerMessage(entry)).toBeUndefined();
});

test("read receipts require a complete positive message identity", () => {
    const entry = peerEntry({
        kind: "peer.read",
        payload: JSON.stringify({ message_id: 7, complete: true }),
    });

    expect(parsePeerRead(entry)).toEqual({ message_id: 7, complete: true });
    expect(parsePeerRead({
        ...entry,
        payload: JSON.stringify({ message_id: 0, complete: true }),
    })).toBeUndefined();
});

function peerEntry(overrides: Partial<InboxEntry> = {}): InboxEntry {
    return {
        seq: 1,
        source: "vera",
        kind: "peer.message",
        actor: "left",
        session: "left",
        address: "right",
        payload: "{}",
        ts: "2026-08-09T00:00:00.000Z",
        ...overrides,
    };
}
