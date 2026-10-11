import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { EngineEvent } from "../engine/events.ts";
import { veraProfileDirectory } from "../profile-paths.ts";
import { readRegularFileTextSync } from "../store/regular-file.ts";

export function defaultTrustNoticePath(): string {
    return join(veraProfileDirectory(), "trust-notices.json");
}

// The installed extensions that already showed the auto-mode trust notice in this home.
export class TrustNoticeStore {
    private readonly path: string;
    private readonly shownThisProcess = new Set<string>();

    constructor(path: string = defaultTrustNoticePath()) {
        this.path = path;
    }

    shown(extensionId: string): boolean {
        return this.shownThisProcess.has(extensionId)
            || readShown(this.path).includes(extensionId);
    }

    markShown(extensionId: string): void {
        this.shownThisProcess.add(extensionId);
        const shown = readShown(this.path);
        if (shown.includes(extensionId)) return;
        mkdirSync(dirname(this.path), { recursive: true });
        const body = `${JSON.stringify({ shown: [...shown, extensionId] }, null, 2)}\n`;
        const temporary = `${this.path}.tmp-${process.pid}`;
        writeFileSync(temporary, body);
        renameSync(temporary, this.path);
    }
}

function readShown(path: string): readonly string[] {
    try {
        const parsed: unknown = JSON.parse(readRegularFileTextSync(path));
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            return [];
        }
        const shown = (parsed as { shown?: unknown }).shown;
        if (!Array.isArray(shown)) return [];
        return shown.filter((id): id is string => typeof id === "string");
    } catch {
        return [];
    }
}

export interface TrustNoticeOptions {
    /** Tool name to extension id, from `installedUnreviewedTools()`. */
    readonly tools: ReadonlyMap<string, string>;
    readonly store: TrustNoticeStore;
    readonly approvalMode: () => string;
    readonly append: (text: string) => void;
}

export function trustNoticeText(extensionId: string, toolName: string): string {
    return `${extensionId} ran ${toolName} without review. `
        + "Installed extensions are trusted in auto mode; turn one off in /extensions.";
}

export function trustNoticeSubscriber(
    options: TrustNoticeOptions,
): (event: EngineEvent) => void {
    // Review and approval events come before the call's start event.
    const reviewed = new Set<string>();
    return (event) => {
        if (event.type === "tool_review_decided") {
            reviewed.add(event.toolCall.id);
            return;
        }
        if (event.type === "ui_request" && event.request.type === "tool_approval") {
            reviewed.add(event.request.toolCall.id);
            return;
        }
        if (event.type !== "tool_execution_started") return;
        if (reviewed.delete(event.toolCall.id)) return;
        if (options.approvalMode() !== "auto") return;
        const extensionId = options.tools.get(event.toolCall.name);
        if (extensionId === undefined || options.store.shown(extensionId)) return;
        try {
            options.store.markShown(extensionId);
        } catch {
            // Still show it; the in-process record stops repeats until restart.
        }
        options.append(trustNoticeText(extensionId, event.toolCall.name));
    };
}
