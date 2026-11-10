import type { NoticeEvent } from "../engine/events.ts";
import { isNoticeFacts, NOTICE_KEY_PATTERN } from "../engine/notice-facts.ts";
import type { ModelNotice } from "../sdk/model-middleware.ts";

export function extensionNoticeEvent(notice: string | ModelNotice, source: string): NoticeEvent {
    if (typeof notice === "string") {
        return { type: "notice", key: "extension", count: 1, text: notice, source };
    }
    if (!NOTICE_KEY_PATTERN.test(notice.key)) throw new Error("Invalid notice key");
    if (!isNoticeFacts(notice.facts)) throw new Error("Invalid notice facts");
    return { type: "notice", key: notice.key, count: 1, source, facts: { ...notice.facts } };
}
