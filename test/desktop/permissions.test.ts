import { describe, expect, test } from "bun:test";

import {
    defaultModeCommand,
    describePredicate,
    modeLabel,
    modeOptions,
    offeredModeOptions,
    removeGrantCommand,
    sessionModeCommand,
} from "../../clients/ui/src/session/permissions.ts";
import { readFullAccessOffered, storeFullAccessOffered } from "../../clients/ui/src/session/fullAccess.ts";
import { initialWatch, reduceWatch } from "../../clients/ui/src/session/transcript.ts";
import { parseSessionLine } from "../../clients/ui/src/session/wire.ts";

const reply = {
    type: "permissions",
    requestId: "p1",
    mode: "auto",
    pending: false,
    origin: "user",
    inspection: {
        selected: { name: "auto", rules: [], defaultOutcome: "review" },
        availableModes: ["full_access", "ask", "auto", "readonly", "review_all"],
        activeGrants: [{ id: "g1", kind: "command", when: { executable: "git", verb: "read" }, scope: "session", lifetime: "session" }],
        activePreferences: [{ id: "pref1", when: { tool: "web_fetch", host: "example.com" }, createdAt: "2026-11-12T00:00:00Z" }],
    },
    seq: 4,
};

describe("permissions", () => {
    test("a permissions reply becomes the session's approval state", () => {
        const message = parseSessionLine(JSON.stringify(reply));
        if (message === undefined) throw new Error("expected a message");
        const state = reduceWatch(initialWatch("a1"), message);
        expect(state.approval).toEqual({
            requestId: "p1",
            mode: "auto",
            pending: false,
            origin: "user",
            modes: ["full_access", "ask", "auto", "readonly", "review_all"],
            grants: [{ id: "g1", description: "read git" }],
            preferences: [{ id: "pref1", description: "example.com web_fetch" }],
        });
    });

    test("a reply without a mode or pending flag is ignored", () => {
        expect(parseSessionLine(JSON.stringify({ ...reply, pending: "no" }))).toBeUndefined();
        expect(parseSessionLine(JSON.stringify({ ...reply, mode: 3 }))).toBeUndefined();
    });

    test("a refused change is remembered by id", () => {
        const message = parseSessionLine(JSON.stringify({ type: "permissions_rejected", requestId: "p2", reason: "invalid", seq: 5 }));
        if (message === undefined) throw new Error("expected a message");
        expect(reduceWatch(initialWatch("a1"), message).approvalRefused).toBe("p2");
    });

    test("@core the approval menus list Full access only when offered or already in use", () => {
        const listed = (fullAccess: boolean, current: string | undefined) =>
            offeredModeOptions(["review_all"], fullAccess, current).map((option) => option.mode);
        expect(listed(false, "ask")).toEqual(["ask", "auto", "readonly", "review_all"]);
        expect(listed(false, undefined)).toEqual(["ask", "auto", "readonly", "review_all"]);
        expect(listed(true, "ask")).toEqual(["ask", "auto", "readonly", "full_access", "review_all"]);
        expect(listed(false, "full_access")).toEqual(["ask", "auto", "readonly", "full_access", "review_all"]);
    });

    test("the Full access setting is off unless stored on", () => {
        const kept = new Map<string, string>();
        const storage = { getItem: (key: string) => kept.get(key) ?? null, setItem: (key: string, value: string) => void kept.set(key, value) };
        expect(readFullAccessOffered(storage)).toBe(false);
        storeFullAccessOffered(true, storage);
        expect(readFullAccessOffered(storage)).toBe(true);
        storeFullAccessOffered(false, storage);
        expect(readFullAccessOffered(storage)).toBe(false);
        expect(readFullAccessOffered(undefined)).toBe(false);
    });

    test("custom modes follow the built-in ones", () => {
        expect(modeOptions(["ask", "review_all"]).map((option) => option.mode))
            .toEqual(["ask", "auto", "readonly", "full_access", "review_all"]);
        expect(modeLabel("review_all")).toBe("review all");
        expect(modeLabel("full_access")).toBe("Full access");
    });

    test("predicates read in the terminal's order", () => {
        expect(describePredicate({})).toBe("similar actions");
        expect(describePredicate({ tool: "bash", executable: "npm", verb: "execute" })).toBe("execute npm");
        expect(describePredicate({ tool: "edit", pathGlob: "src/**" })).toBe("edit src/**");
    });

    test("session and default mode changes are separate commands", () => {
        expect(JSON.parse(sessionModeCommand("r1", "ask"))).toEqual({ type: "update_session_permission_mode", requestId: "r1", mode: "ask" });
        expect(JSON.parse(defaultModeCommand("r2", "ask"))).toEqual({ type: "update_permissions", requestId: "r2", mode: "ask" });
        expect(JSON.parse(removeGrantCommand("r3", "g1"))).toEqual({ type: "remove_permission_grant", requestId: "r3", id: "g1" });
    });
});
