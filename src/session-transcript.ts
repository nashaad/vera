import { projectTranscript, type TranscriptEntry } from "./engine/protocol.ts";
import type { SessionMessageEntry, SessionStore } from "./store/session-store.ts";

export async function projectIndexedMessage(
    store: SessionStore,
    entry: SessionMessageEntry,
    attachmentNames = true,
): Promise<readonly TranscriptEntry[]> {
    const names = new Map<string, string>();
    if (attachmentNames && entry.message.role === "user" && entry.message.internal !== true) {
        for (const part of entry.message.content) {
            if (part.type !== "image_attachment" || names.has(part.attachmentId)) continue;
            const name = await store.readAttachmentName(part.attachmentId);
            if (name !== undefined) names.set(part.attachmentId, name);
        }
    }
    const stamps = new Map([[entry.message, { id: entry.id, recordedAt: Date.parse(entry.timestamp) }]]);
    const delivery = entry.deliveryId === undefined ? undefined : await store.readDelivery(entry.deliveryId);
    const deliveries = delivery === undefined ? undefined : new Map([[entry.message, delivery]]);
    return projectTranscript([entry.message], (id) => names.get(id), stamps, [], deliveries);
}

export async function* walkSessionTranscript(
    store: SessionStore,
    headId: string | null,
    recordLimit: number,
    attachmentNames = true,
): AsyncGenerator<TranscriptEntry> {
    const harnessByRecord = new Map<number, { readonly number: number; readonly ordinal: number }[]>();
    for await (const { number, ordinal, entry } of store.walkHarnessMessages()) {
        if (number >= recordLimit) break;
        const position = await store.harnessPosition(headId, entry);
        if (position === undefined) continue;
        let group = harnessByRecord.get(position);
        if (group === undefined) {
            group = [];
            harnessByRecord.set(position, group);
        }
        group.push({ number, ordinal });
    }
    const readHarness = async function* (position: number): AsyncGenerator<TranscriptEntry> {
        for (const item of harnessByRecord.get(position) ?? []) {
            const entry = await store.readHarnessMessage(item.number);
            if (entry === undefined) throw new Error(`Session harness record ${item.number + 1} is unavailable`);
            yield { kind: "harness", id: `harness:${item.ordinal}`, text: entry.text, tone: entry.tone };
        }
    };
    yield* readHarness(-1);
    if (headId === null) return;
    for await (const entry of store.walkMessageBranch(headId)) {
        yield* await projectIndexedMessage(store, entry, attachmentNames);
        const number = await store.messageRecordNumber(entry.id);
        if (number === undefined) throw new Error(`Session message ${entry.id} is unavailable`);
        yield* readHarness(number);
    }
}
