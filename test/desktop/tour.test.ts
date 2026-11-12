import { expect, test } from "bun:test";

import { OVERLAY_COMMANDS, type Overlay } from "../../clients/ui/src/commands/overlay-ids.ts";
import type { SessionRow, SessionStatus } from "../../clients/ui/src/protocol/sessions.ts";
import {
    foundSessionDesc,
    newestWithStatus,
    SHEET_DESCS,
    sessionCards,
    sheetCards,
} from "../../clients/ui/src/pages/tour.ts";

function row(id: string, status: SessionStatus, updatedAt: number | undefined, workspace = "/work/vera"): SessionRow {
    return {
        id,
        name: `Session ${id}`,
        workspace,
        status,
        live: false,
        ...(updatedAt === undefined ? {} : { updatedAt }),
    };
}

test("@core newestWithStatus picks the newest timed row with the status and ignores other statuses", () => {
    const rows = [
        row("old", "working", 100),
        row("other", "idle", 900),
        row("new", "working", 500),
        row("middle", "working", 300),
    ];
    expect(newestWithStatus(rows, "working")?.id).toBe("new");
    expect(newestWithStatus(rows, "idle")?.id).toBe("other");
});

test("rows without a time rank after timed rows and keep the host's order", () => {
    const untimedFirst = [row("a", "waiting", undefined), row("b", "waiting", 10)];
    expect(newestWithStatus(untimedFirst, "waiting")?.id).toBe("b");

    const untimedOnly = [row("a", "completed", undefined), row("b", "completed", undefined)];
    expect(newestWithStatus(untimedOnly, "completed")?.id).toBe("a");
});

test("newestWithStatus gives undefined when no row has the status", () => {
    expect(newestWithStatus([row("a", "idle", 1)], "working")).toBeUndefined();
    expect(newestWithStatus([], "idle")).toBeUndefined();
});

test("the sheet list has one card per overlay in OVERLAY_COMMANDS", () => {
    const overlays = Object.keys(OVERLAY_COMMANDS) as Overlay[];
    const cards = sheetCards();
    expect(cards.length).toBe(overlays.length);
    overlays.forEach((overlay, index) => {
        const card = cards[index];
        expect(card?.name).toBe(OVERLAY_COMMANDS[overlay].title);
        expect(card?.desc).toBe(SHEET_DESCS[overlay]);
        expect(card?.action).toEqual({ kind: "command", commandId: OVERLAY_COMMANDS[overlay].id });
    });
});

test("the desc of a found row is name · folder", () => {
    expect(foundSessionDesc(row("a", "working", 1, "/Users/nash/Projects/vera"))).toBe("Session a · vera");
});

test("session cards are disabled with the connection note when Vera is not attached", () => {
    const cards = sessionCards([row("a", "working", 1)], false);
    expect(cards.map((card) => card.desc)).toEqual([
        "Vera is not connected",
        "Vera is not connected",
        "Vera is not connected",
        "Vera is not connected",
    ]);
    expect(cards.every((card) => card.action === undefined)).toBe(true);
});

test("a session card with no matching row is disabled with None right now", () => {
    const working = sessionCards([row("a", "idle", 1)], true).find((card) => card.id === "working");
    expect(working?.desc).toBe("None right now");
    expect(working?.action).toBeUndefined();
});

test("a session card with a matching row opens that session", () => {
    const cards = sessionCards([row("a", "waiting", 5, "")], true);
    const waiting = cards.find((card) => card.id === "waiting");
    expect(waiting?.desc).toBe("Session a · No folder");
    expect(waiting?.action).toEqual({
        kind: "route",
        route: { kind: "session", agentId: "a", title: "Session a" },
    });
});
