import { describe, expect, test } from "bun:test";

import type { SessionRow } from "../../clients/ui/src/protocol/sessions.ts";
import { CORE_VIEWS } from "../../clients/ui/src/registry/core.ts";
import { canStart, gateView, needsStartToRead, watchEnded } from "../../clients/ui/src/session/liveSession.ts";
import type { SessionWatch } from "../../clients/ui/src/session/model.ts";
import { initialWatch, reduceWatch, watchClosed } from "../../clients/ui/src/session/transcript.ts";
import { parseSessionLine, type SessionMessage } from "../../clients/ui/src/session/wire.ts";

function line(value: unknown): SessionMessage {
    const message = parseSessionLine(JSON.stringify(value));
    if (message === undefined) throw new Error("test line did not parse");
    return message;
}

function failedWith(reason: string): SessionWatch {
    return reduceWatch(initialWatch("a1"), line({ type: "attach_failed", agent_id: "a1", reason }));
}

function loaded(): SessionWatch {
    const attached = reduceWatch(initialWatch("a1"), line({ type: "attached" }));
    return reduceWatch(attached, line({ type: "history", entries: [], status: "idle" }));
}

function row(overrides: Partial<SessionRow> = {}): SessionRow {
    return { id: "s1", name: "s1", workspace: "/work", status: "idle", live: true, chat: false, ...overrides };
}

describe("a session the host stopped", () => {
    test("@core a closed watch offers the start and a watch still attaching does not", () => {
        const attaching = initialWatch("a1");
        const closed = watchClosed(loaded(), "The host closed this session.");
        expect(watchEnded(attaching)).toBe(false);
        expect(canStart(attaching)).toBe(false);
        expect(watchEnded(closed)).toBe(true);
        expect(canStart(closed)).toBe(true);
        expect(canStart(loaded())).toBe(false);
    });

    test("a failed attach offers the start unless the host said a second attach cannot help", () => {
        expect(canStart(failedWith("unavailable"))).toBe(true);
        expect(canStart(failedWith("something_new"))).toBe(true);
        expect(canStart(failedWith("not_found"))).toBe(false);
        expect(canStart(failedWith("history_paging_required"))).toBe(false);
    });

    test("the reason a watch failed is kept for the decision", () => {
        expect(failedWith("not_found").failedReason).toBe("not_found");
        expect(initialWatch("a1").failedReason).toBeUndefined();
    });
});

describe("which views need the session", () => {
    test("@core plan and review offer the start when the watch ended before any history loaded", () => {
        const closed = watchClosed(initialWatch("a1"), "The host closed this session.");
        expect(gateView(CORE_VIEWS.plan, closed)).toEqual({ kind: "start" });
        expect(gateView(CORE_VIEWS.review, closed)).toEqual({ kind: "start" });
        expect(gateView(CORE_VIEWS.plan, failedWith("unavailable"))).toEqual({ kind: "start" });
    });

    test("plan and review read the stored transcript once it has loaded, even after the watch ended", () => {
        const closed = watchClosed(loaded(), "The host closed this session.");
        expect(gateView(CORE_VIEWS.plan, closed)).toEqual({ kind: "open" });
        expect(gateView(CORE_VIEWS.review, closed)).toEqual({ kind: "open" });
    });

    test("a session that cannot be found is named instead of offered", () => {
        const gate = gateView(CORE_VIEWS.plan, failedWith("not_found"));
        expect(gate).toEqual({ kind: "unavailable", reason: "This session no longer exists." });
    });

    test("plan and review stay open while the watch is still opening", () => {
        expect(gateView(CORE_VIEWS.plan, initialWatch("a1"))).toEqual({ kind: "open" });
        expect(gateView(CORE_VIEWS.review, loaded())).toEqual({ kind: "open" });
    });

    test("files, output and browser never wait for the session", () => {
        const closed = watchClosed(initialWatch("a1"), "The host closed this session.");
        for (const view of [CORE_VIEWS.files, CORE_VIEWS.output, CORE_VIEWS.browser, CORE_VIEWS.sessions]) {
            expect(gateView(view, closed)).toEqual({ kind: "open" });
        }
    });
});

describe("customize and a stopped session", () => {
    test("@core a stopped session is read only after the person starts it", () => {
        expect(needsStartToRead(row({ live: true }), undefined)).toBe(false);
        expect(needsStartToRead(row({ live: false }), undefined)).toBe(true);
        expect(needsStartToRead(row({ live: false }), "s1")).toBe(false);
        expect(needsStartToRead(row({ live: false }), "other")).toBe(true);
    });
});
