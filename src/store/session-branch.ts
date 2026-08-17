import { rm } from "node:fs/promises";

import { AttachmentStore } from "../attachments/store.ts";
import type { ModelMessage, UserMessage } from "../model/types.ts";
import {
    SessionStore,
    type SessionMessageEntry,
} from "./session-store.ts";

export interface CreateSessionBranchOptions {
    readonly source: SessionStore;
    readonly destinationPath: string;
    readonly sessionId: string;
    readonly position: "before" | "at";
    readonly entryId?: string;
    readonly hideInheritedMessages?: boolean;
}

export interface CreatedSessionBranch {
    readonly store: SessionStore;
    readonly prompt?: UserMessage;
}

export async function createSessionBranch(
    options: CreateSessionBranchOptions,
): Promise<CreatedSessionBranch> {
    const active = options.source.activeEntries();
    const selection = selectBranch(active, options.position, options.entryId);
    const originEntryId = options.position === "before"
        ? selection.promptEntry?.id ?? null
        : options.source.activeHeadId();
    const destination = await SessionStore.create(options.destinationPath, {
        sessionId: options.sessionId,
        cwd: options.source.header.cwd,
        origin: {
            sessionId: options.source.header.id,
            entryId: originEntryId,
            position: options.position,
        },
        ...(options.source.header.startupProfile === undefined
            ? {}
            : { startupProfile: options.source.header.startupProfile }),
    });

    try {
        // Carried with its origin, not as a bare payload. Dropping the origin
        // would turn a setting the branch merely inherited from its agent into
        // a sticky override nobody chose, and the status line would mark it.
        const modelSettings = options.source.modelSettings();
        if (modelSettings !== undefined) {
            await destination.appendModelSettings(
                modelSettings,
                options.source.modelSettingsOrigin(),
            );
        }
        // The permission mode is deliberately not carried: a fork resets
        // execution authority, so there is no posture record to keep an origin
        // on either.
        await copySessionMessageAttachments(
            options.source,
            destination,
            [
                ...selection.entries.map((entry) => entry.message),
                ...(selection.promptEntry === undefined
                    ? []
                    : [selection.promptEntry.message]),
            ],
        );
        for (const entry of selection.entries) {
            await destination.appendMessage(options.hideInheritedMessages === true
                ? { ...entry.message, internal: true } as ModelMessage
                : entry.message);
        }
        return {
            store: destination,
            ...(selection.promptEntry === undefined
                ? {}
                : {
                    prompt: structuredClone(
                        selection.promptEntry.message,
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

function selectBranch(
    active: readonly SessionMessageEntry[],
    position: "before" | "at",
    entryId: string | undefined,
): {
    readonly entries: readonly SessionMessageEntry[];
    readonly promptEntry?: SessionMessageEntry;
} {
    if (position === "at") {
        if (entryId !== undefined) {
            throw new Error("Clone does not accept a source entry");
        }
        return { entries: active };
    }
    if (entryId === undefined) {
        throw new Error("Fork requires a source user message");
    }
    const index = active.findIndex((entry) => entry.id === entryId);
    const promptEntry = active[index];
    if (
        index < 0
        || promptEntry?.message.role !== "user"
        || promptEntry.message.internal === true
    ) {
        throw new Error("Fork source must be an active user message");
    }
    return {
        entries: active.slice(0, index),
        promptEntry,
    };
}

export async function copySessionMessageAttachments(
    source: SessionStore,
    destination: SessionStore,
    messages: readonly ModelMessage[],
): Promise<void> {
    const ids = new Set(messages.flatMap(messageAttachmentIds));
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
