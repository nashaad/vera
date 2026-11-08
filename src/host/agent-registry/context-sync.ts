import { AttachmentStore } from "../../attachments/store.ts";
import type { ModelMessage } from "../../model/types.ts";
import type { SessionImageAttachmentMetadata } from "../../store/session-store.ts";
import type { AgentRegistry } from "../agent-registry.ts";

export interface BranchSyncInfo {
    readonly sourceId?: string;
    readonly cursor: string | null;
    readonly ready: boolean;
}

export interface BranchSyncAttachment {
    readonly metadata: SessionImageAttachmentMetadata;
    readonly data: string;
}

export interface BranchSyncDelta {
    readonly status: "ready";
    readonly cursor: string | null;
    readonly nextCursor: string;
    readonly turns: number;
    readonly messages: readonly ModelMessage[];
    readonly attachments: readonly BranchSyncAttachment[];
}

export interface BranchSyncRefusal {
    readonly status: "unchanged" | "stale_cursor" | "not_found" | "busy";
}

export type BranchSyncPrepared = BranchSyncDelta | BranchSyncRefusal;
export interface BranchSyncOutcome {
    readonly status: "synced" | "unchanged" | "stale_cursor" | "not_found" | "busy";
    readonly turns: number;
}

export function branchSyncInfo(reg: AgentRegistry, id: string): BranchSyncInfo | undefined {
    const entry = reg.agents.get(id);
    if (entry === undefined) return undefined;
    return {
        ...(entry.store.header.origin?.sessionId === undefined ? {} : { sourceId: entry.store.header.origin.sessionId }),
        cursor: entry.syncedSourceEntryId ?? entry.store.header.origin?.entryId ?? null,
        ready: !entry.agent.closed && !entry.agent.failed && entry.agent.status === "idle" && entry.inbound !== undefined,
    };
}

export function branchSourceReady(reg: AgentRegistry, id: string): boolean | undefined {
    const source = reg.agents.get(id);
    return source === undefined ? undefined : !source.agent.closed && !source.agent.failed && source.agent.status === "idle";
}

export async function branchSyncDelta(reg: AgentRegistry, id: string, cursor: string | null): Promise<BranchSyncPrepared> {
    const source = reg.agents.get(id);
    if (source === undefined) return { status: "not_found" };
    if (source.agent.closed || source.agent.failed || source.agent.status !== "idle") return { status: "busy" };
    const active = source.store.activeEntries();
    const lastCompletedIndex = active.findLastIndex((entry) => entry.message.role === "assistant");
    if (lastCompletedIndex < 0) return { status: "unchanged" };
    const completed = active.slice(0, lastCompletedIndex + 1);
    const cursorIndex = cursor === null ? -1 : completed.findIndex((entry) => entry.id === cursor);
    if (cursor !== null && cursorIndex < 0) return { status: "stale_cursor" };
    const additions = completed.slice(cursorIndex + 1);
    const turns = additions.filter((entry) => entry.message.role === "user" && entry.message.internal !== true).length;
    if (additions.length === 0 || turns === 0) return { status: "unchanged" };
    const messages = additions.map((entry) => entry.message);
    const ids = new Set(messages.flatMap((message) => message.role === "user"
        ? message.content.flatMap((part) => part.type === "image_attachment" ? [part.attachmentId] : [])
        : []));
    const metadata = new Map(source.store.attachmentRecords().map((entry) => [entry.id, entry]));
    const files = new AttachmentStore(source.store.path);
    const attachments: BranchSyncAttachment[] = [];
    for (const attachmentId of ids) {
        const attachment = metadata.get(attachmentId);
        if (attachment === undefined) throw new Error(`Source attachment ${attachmentId} is unavailable`);
        attachments.push({ metadata: attachment, data: Buffer.from(await files.readImage(attachment)).toString("base64") });
    }
    return { status: "ready", cursor, nextCursor: additions.at(-1)!.id, turns, messages, attachments };
}

export async function applyBranchSync(reg: AgentRegistry, id: string, delta: BranchSyncDelta): Promise<BranchSyncOutcome> {
    const target = reg.agents.get(id);
    if (target === undefined) return { status: "not_found", turns: 0 };
    if (target.agent.closed || target.agent.failed || target.agent.status !== "idle" || target.inbound === undefined
        || (target.syncedSourceEntryId ?? target.store.header.origin?.entryId ?? null) !== delta.cursor) {
        return { status: "busy", turns: 0 };
    }
    const files = new AttachmentStore(target.store.path);
    for (const attachment of delta.attachments) {
        const stored = await files.saveImage(Buffer.from(attachment.data, "base64"), attachment.metadata, attachment.metadata.name);
        await target.store.appendAttachment(stored);
    }
    const appended = await target.inbound.appendContext(delta.messages, {
        text: `Caught up with ${delta.turns} new ${delta.turns === 1 ? "turn" : "turns"} from the primary conversation.`,
        tone: "soft",
    });
    if (!appended) return { status: "busy", turns: 0 };
    target.syncedSourceEntryId = delta.nextCursor;
    return { status: "synced", turns: delta.turns };
}
