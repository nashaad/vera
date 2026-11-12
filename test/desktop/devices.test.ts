import { expect, test } from "bun:test";

import {
    deviceDetail,
    deviceHealth,
    deviceLabel,
    newestRows,
    sessionCountLabel,
} from "../../clients/ui/src/pages/devices.ts";
import type { SessionRow } from "../../clients/ui/src/protocol/sessions.ts";
import type { UiState } from "../../clients/ui/src/state/connection.ts";

const ready = { pid: 42, buildId: "abc1234def", home: "/Users/someone/.vera", attachedAt: 0 };
const identity = { protocol_version: 3, pid: 42 } as UiState["identity"];

function row(id: string, extra: Partial<SessionRow> = {}): SessionRow {
    return { id, name: id, workspace: "/p/crow", status: "idle", live: false, ...extra };
}

test("the local machine is named by platform", () => {
    expect(deviceLabel("darwin")).toBe("This Mac");
    expect(deviceLabel("win32")).toBe("This PC");
    expect(deviceLabel("linux")).toBe("This computer");
    expect(deviceLabel("")).toBe("This computer");
});

test("@core health is ok when attached, warn while starting or waiting, and fail otherwise", () => {
    expect(deviceHealth({ phase: "attached", ready })).toBe("ok");
    expect(deviceHealth({ phase: "starting" })).toBe("warn");
    expect(deviceHealth({ phase: "waiting" })).toBe("warn");
    expect(deviceHealth({ phase: "disconnected" })).toBe("fail");
    expect(deviceHealth({ phase: "failed" })).toBe("fail");
    expect(deviceHealth({ phase: "missing" })).toBe("fail");
});

test("the detail names the build and protocol only when the host reported them", () => {
    expect(deviceDetail({ phase: "attached", ready, identity })).toBe("Host running · build abc1234 · protocol v3");
    expect(deviceDetail({ phase: "attached", ready: { ...ready, buildId: null } })).toBe("Host running");
    expect(deviceDetail({ phase: "disconnected", ready })).toBe("Disconnected");
});

test("sessions sort newest first and rows without a time go last", () => {
    const sorted = newestRows([row("old", { updatedAt: 1 }), row("none"), row("new", { updatedAt: 9 })]);
    expect(sorted.map((entry) => entry.id)).toEqual(["new", "old", "none"]);
});

test("the session count label pluralises", () => {
    expect(sessionCountLabel(1)).toBe("1 session");
    expect(sessionCountLabel(0)).toBe("0 sessions");
    expect(sessionCountLabel(3)).toBe("3 sessions");
});
