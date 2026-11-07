import { describe, expect, test } from "bun:test";

import type { TuiRuntime } from "../../clients/tui/main/runtime.ts";
import {
    handleHostRestarting,
    launcherRelaunch,
    RESTARTING_NOTICE_TEXT,
    type LauncherRelaunchEffects,
} from "../../clients/tui/restart-notice.ts";

function recordingEffects(order: string[], failWrite = false): LauncherRelaunchEffects & {
    readonly records: unknown[];
} {
    const records: unknown[] = [];
    return {
        records,
        writeRecord(launcherKey, record) {
            order.push(`write:${launcherKey}`);
            if (failWrite) throw new Error("disk full");
            records.push(record);
        },
        markTerminalRestored() {
            order.push("restored");
        },
        exit(code) {
            order.push(`exit:${code}`);
        },
    };
}

describe("launcherRelaunch", () => {
    test("without a launcher there is no relaunch path", () => {
        expect(launcherRelaunch(undefined, recordingEffects([]))).toBeUndefined();
    });

    test("writes the record, keeps the alternate screen, then exits with the relaunch code", async () => {
        const order: string[] = [];
        const effects = recordingEffects(order);
        const relaunch = launcherRelaunch("777", effects);
        if (relaunch === undefined) throw new Error("expected a relaunch function");
        await relaunch({ sessionId: "agent-9", draft: { text: "keep me", attachmentIds: [] } });
        expect(order).toEqual(["write:777", "restored", "exit:85"]);
        const [record] = effects.records as { sessionId?: string; draft?: unknown; writtenAt: string }[];
        expect(record?.sessionId).toBe("agent-9");
        expect(record?.draft).toEqual({ text: "keep me", attachmentIds: [] });
        expect(Number.isNaN(Date.parse(record?.writtenAt ?? ""))).toBe(false);
    });

    test("a failed record write still exits with the relaunch code", async () => {
        const order: string[] = [];
        const relaunch = launcherRelaunch("778", recordingEffects(order, true));
        if (relaunch === undefined) throw new Error("expected a relaunch function");
        await relaunch({});
        expect(order).toEqual(["write:778", "restored", "exit:85"]);
    });
});

function fakeRuntime(): TuiRuntime {
    return {
        stopWait: { kind: "stop", waitingOn: [{ session_id: "a1", name: "Fix", status: "working" }] },
        stopWaitCard: { key: "stop:a1", open: true },
        relaunching: undefined,
        client: { agentId: "agent-1" },
        composer: { plainText: "" },
        pendingImages: [],
    } as unknown as TuiRuntime;
}

describe("handleHostRestarting", () => {
    test("shows the notice and drops the stop wait and its card", () => {
        const rt = fakeRuntime();
        const painted: string[] = [];
        handleHostRestarting(rt, undefined, (painting) => {
            painted.push(String(painting.relaunching));
        });
        expect(rt.stopWait).toBeUndefined();
        expect(rt.stopWaitCard).toBeUndefined();
        expect(rt.relaunching).toBe(true);
        expect(painted).toEqual(["true"]);
    });

    test("without a launcher the TUI stays open and asks for no relaunch", async () => {
        const rt = fakeRuntime();
        handleHostRestarting(rt, undefined, () => undefined);
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(rt.relaunching).toBe(true);
        expect(rt.stopWait).toBeUndefined();
    });

    test("with a launcher the relaunch is requested after the notice paints", async () => {
        const rt = fakeRuntime();
        const requests: unknown[] = [];
        handleHostRestarting(rt, async (request) => {
            requests.push(request);
        }, () => undefined);
        expect(requests).toEqual([]);
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(requests).toEqual([{ sessionId: "agent-1" }]);
    });

    test("the notice text is fixed", () => {
        expect(RESTARTING_NOTICE_TEXT).toBe("Restarting to match");
    });
});
