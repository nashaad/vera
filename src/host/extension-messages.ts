import type { InboxEntry } from "../store/inbox.ts";
import { inboxSourceFamily } from "./inbox-admission.ts";

// No dot, so the admission family comes from the extension id's last segment.
export const EXTENSION_MESSAGE_KIND = "extension_message";

// Families the host itself writes. An extension named like one would borrow its admission.
const HOST_SOURCE_FAMILIES: ReadonlySet<string> = new Set([
    "vera",
    "peer",
    "schedule",
    "scheduler",
    "arc",
    "filesystem",
]);

export interface ExtensionMessagePayload {
    readonly version: 1;
    readonly text: string;
}

export function extensionMessageFamily(extensionId: string): string | undefined {
    const family = inboxSourceFamily({ source: extensionId, kind: EXTENSION_MESSAGE_KIND });
    return HOST_SOURCE_FAMILIES.has(family) ? undefined : family;
}

export function parseExtensionMessage(entry: InboxEntry): ExtensionMessagePayload | undefined {
    if (entry.kind !== EXTENSION_MESSAGE_KIND || entry.address === null) return undefined;
    try {
        const value: unknown = JSON.parse(entry.payload);
        if (
            typeof value === "object"
            && value !== null
            && (value as Record<string, unknown>).version === 1
            && typeof (value as Record<string, unknown>).text === "string"
        ) {
            return { version: 1, text: (value as Record<string, unknown>).text as string };
        }
    } catch {
        // A malformed payload is read as a generic entry.
    }
    return undefined;
}
