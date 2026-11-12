import { rm } from "node:fs/promises";

import { AttachmentStore } from "../attachments/store.ts";
import type { ModelMessage, UserMessage } from "../model/types.ts";
import { SessionStore, type SessionMessageEntry } from "./session-store.ts";

export interface CreateSessionBranchOptions {
    readonly source: SessionStore;
    readonly destinationPath: string;
    readonly sessionId: string;
    readonly position: "before" | "at";
    readonly entryId?: string;
    readonly hideInheritedMessages?: boolean;
    /** Recorded in place of the source's cwd, for a branch that owns a copy of the source's chat folder. */
    readonly cwd?: string;
}

export interface CreatedSessionBranch {
    readonly store: SessionStore;
    readonly prompt?: UserMessage;
}

export type CompletedBranchDelta =
    | { readonly status: "unchanged" | "stale_cursor" }
    | { readonly status: "ready"; readonly entries: readonly SessionMessageEntry[]; readonly turns: number };

export async function completedBranchDelta(
    source: SessionStore,
    cursor: string | null,
): Promise<CompletedBranchDelta> {
    const headId = source.activeHeadId();
    if (headId === null) return { status: "unchanged" };
    const additions: SessionMessageEntry[] = [];
    let completed = false;
    let found = cursor === null;
    for await (const entry of source.walkMessageAncestors(headId)) {
        if (!completed && entry.message.role !== "assistant") continue;
        completed = true;
        if (entry.id === cursor) {
            found = true;
            break;
        }
        additions.push(entry);
    }
    if (!completed) return { status: "unchanged" };
    if (!found) return { status: "stale_cursor" };
    const turns = additions.filter((entry) => entry.message.role === "user" && entry.message.internal !== true).length;
    if (additions.length === 0 || turns === 0) return { status: "unchanged" };
    additions.reverse();
    return { status: "ready", entries: additions, turns };
}

export async function createSessionBranch(
    options: CreateSessionBranchOptions,
): Promise<CreatedSessionBranch> {
    const headId = options.source.activeHeadId();
    const promptEntry = await selectPrompt(options.source, headId, options.position, options.entryId);
    const originEntryId = options.position === "before"
        ? promptEntry?.id ?? null
        : headId;
    const destination = await SessionStore.create(options.destinationPath, {
        sessionId: options.sessionId,
        cwd: options.cwd ?? options.source.header.cwd,
        origin: {
            sessionId: options.source.header.id,
            entryId: originEntryId,
            position: options.position,
        },
        ...(options.source.header.contextAssemblyMode === undefined
            ? {}
            : { contextAssemblyMode: options.source.header.contextAssemblyMode }),
        // Copied entries get new ids, so lastMessageId matches nothing here.
        ...(options.source.header.importedFrom === undefined
            ? {}
            : { importedFrom: options.source.header.importedFrom }),
    });

    try {
        const modelSettings = options.source.modelSettings();
        if (modelSettings !== undefined) {
            await destination.appendModelSettings(
                modelSettings,
                options.source.modelSettingsOrigin(),
            );
        }
        const selected = options.source.selectedAgent();
        if (selected !== undefined) {
            await destination.appendSelectedAgent(selected.name, selected.snapshot);
        }
        const copied = new Set<string>();
        if (headId !== null) {
            for await (const entry of options.source.walkMessageBranch(headId)) {
                await copySessionMessageAttachments(options.source, destination, [entry.message], copied);
                if (entry.id === promptEntry?.id) break;
                await destination.appendMessage(options.hideInheritedMessages === true
                    ? { ...entry.message, internal: true } as ModelMessage
                    : entry.message);
            }
        }
        return {
            store: destination,
            ...(promptEntry === undefined
                ? {}
                : {
                    prompt: structuredClone(
                        promptEntry.message,
                    ) as UserMessage,
                }),
        };
    } catch (error) {
        await rm(options.destinationPath, { force: true });
        await rm(`${options.destinationPath}.attachments`, {
            recursive: true,
            force: true,
        });
        throw error;
    }
}

async function selectPrompt(
    source: SessionStore,
    headId: string | null,
    position: "before" | "at",
    entryId: string | undefined,
): Promise<SessionMessageEntry | undefined> {
    if (position === "at") {
        if (entryId !== undefined) {
            throw new Error("Clone does not accept a source entry");
        }
        return undefined;
    }
    if (entryId === undefined) {
        throw new Error("Fork requires a source user message");
    }
    if (headId !== null) {
        for await (const entry of source.walkMessageAncestors(headId)) {
            if (entry.id !== entryId) continue;
            if (entry.message.role === "user" && entry.message.internal !== true) return entry;
            break;
        }
    }
    throw new Error("Fork source must be an active user message");
}

export async function copySessionMessageAttachments(
    source: SessionStore,
    destination: SessionStore,
    messages: readonly ModelMessage[],
    copied = new Set<string>(),
): Promise<void> {
    const ids = new Set(messages.flatMap(messageAttachmentIds).filter((id) => !copied.has(id)));
    if (ids.size === 0) return;
    const metadata = new Map(
        source.attachmentRecords().map((attachment) => [
            attachment.id,
            attachment,
        ]),
    );
    const sourceFiles = new AttachmentStore(source.path);
    const destinationFiles = new AttachmentStore(destination.path);
    for (const id of ids) {
        const attachment = metadata.get(id);
        if (attachment === undefined) {
            throw new Error(`Source attachment ${id} is unavailable`);
        }
        const bytes = await sourceFiles.readImage(attachment);
        const stored = await destinationFiles.saveImage(
            bytes,
            attachment,
            attachment.name,
        );
        await destination.appendAttachment(stored);
        copied.add(id);
    }
}

function messageAttachmentIds(message: ModelMessage): string[] {
    return message.role === "user"
        ? message.content.flatMap((content) =>
            content.type === "image_attachment"
                ? [content.attachmentId]
                : []
        )
        : [];
}
