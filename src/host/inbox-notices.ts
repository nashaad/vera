import type { InboxEntry } from "../store/inbox.ts";

export function durableNoticeText(entry: InboxEntry): string | undefined {
    if (entry.address === null) return undefined;
    try {
        const payload: unknown = JSON.parse(entry.payload);
        if (typeof payload === "object" && payload !== null && "type" in payload
            && payload.type === "host_notice" && "version" in payload && payload.version === 1
            && "text" in payload && typeof payload.text === "string") {
            return payload.text;
        }
    } catch {
        return undefined;
    }
    return undefined;
}
