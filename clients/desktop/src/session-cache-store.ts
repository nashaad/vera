import { closeSync, openSync, readSync, renameSync } from "node:fs";

import { JsonFileStore } from "./json-file-store.ts";
import { parseSessionCache, sessionCachePath } from "../../ui/src/protocol/sessionCache.ts";
import { SESSIONS_PAGE_SIZE, sessionRows, type SessionRow } from "../../ui/src/protocol/sessions.ts";

const MAX_CACHE_CHARS = 65_536;
const MAX_CACHE_BYTES = 256 * 1024;
const SAVE_DELAY_MS = 1_000;

export class SessionCacheStore extends JsonFileStore<readonly SessionRow[]> {
    private readonly filePath: string;

    constructor(home: string) {
        const path = sessionCachePath(home);
        super(path, MAX_CACHE_CHARS, parseSessionCache);
        this.filePath = path;
    }

    override load(): readonly SessionRow[] | undefined {
        let fd: number | undefined;
        let invalid = false;
        try {
            fd = openSync(this.filePath, "r");
            const buffer = Buffer.allocUnsafe(MAX_CACHE_BYTES + 1);
            let length = 0;
            while (length < buffer.length) {
                const read = readSync(fd, buffer, length, buffer.length - length, null);
                if (read === 0) break;
                length += read;
            }
            if (length > MAX_CACHE_BYTES) {
                invalid = true;
                return undefined;
            }
            const text = buffer.toString("utf8", 0, length);
            const rows = text.length <= MAX_CACHE_CHARS ? parseSessionCache(JSON.parse(text)) : undefined;
            invalid = rows === undefined;
            return rows;
        } catch (error) {
            invalid = error instanceof SyntaxError;
            return undefined;
        } finally {
            if (fd !== undefined) {
                try { closeSync(fd); } catch {}
            }
            if (invalid) {
                try { renameSync(this.filePath, `${this.filePath}.bad`); } catch {}
            }
        }
    }
}

export class SessionCacheWriter {
    private saved: string | undefined;
    private pending: readonly SessionRow[] | undefined;
    private timer: ReturnType<typeof setTimeout> | undefined;

    constructor(private readonly store: SessionCacheStore) {
        const rows = store.load();
        this.saved = rows === undefined ? undefined : JSON.stringify(rows);
    }

    accept(requestText: string, replyText: string): void {
        if (!requestText.includes('"list_agents"') || replyText.length > 1_048_576) return;
        let request: unknown;
        try { request = JSON.parse(requestText); } catch { return; }
        if (typeof request !== "object" || request === null || Array.isArray(request)) return;
        const sent = request as Record<string, unknown>;
        if (sent.type !== "list_agents" || sent.limit !== SESSIONS_PAGE_SIZE || sent.order !== "recent"
            || sent.cursor !== undefined) return;
        let reply: unknown;
        try { reply = JSON.parse(replyText); } catch { return; }
        if (typeof reply !== "object" || reply === null || Array.isArray(reply)) return;
        const received = reply as Record<string, unknown>;
        if (received.type !== "agent_list" || !Array.isArray(received.agents)) return;
        const rows = sessionRows({ agents: received.agents }).slice(0, SESSIONS_PAGE_SIZE);
        if (JSON.stringify(rows) === this.saved) {
            this.pending = undefined;
            if (this.timer !== undefined) clearTimeout(this.timer);
            this.timer = undefined;
            return;
        }
        this.pending = rows;
        if (this.timer === undefined) this.timer = setTimeout(() => this.flush(), SAVE_DELAY_MS);
    }

    flush(): void {
        if (this.timer !== undefined) clearTimeout(this.timer);
        this.timer = undefined;
        const rows = this.pending;
        this.pending = undefined;
        if (rows === undefined) return;
        try {
            if (this.store.save(rows)) this.saved = JSON.stringify(rows);
        } catch {}
    }
}
