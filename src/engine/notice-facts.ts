export type NoticeFactValue = string | number | boolean;
export type NoticeFacts = Readonly<Record<string, NoticeFactValue>>;

export const NOTICE_FACTS_MAX_ENTRIES = 16;
export const NOTICE_FACT_TEXT_MAX = 200;
export const NOTICE_KEY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export function isNoticeFacts(value: unknown): value is NoticeFacts {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const keys = Object.keys(value);
    if (keys.length > NOTICE_FACTS_MAX_ENTRIES) return false;
    for (const key of keys) {
        if (!NOTICE_KEY_PATTERN.test(key)) return false;
        const entry: unknown = (value as Record<string, unknown>)[key];
        if (typeof entry === "number") {
            if (!Number.isFinite(entry)) return false;
        } else if (typeof entry === "string") {
            if (entry.length > NOTICE_FACT_TEXT_MAX || CONTROL_CHARACTERS.test(entry)) return false;
        } else if (typeof entry !== "boolean") {
            return false;
        }
    }
    return true;
}
