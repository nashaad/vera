import { expect, test } from "bun:test";

import {
    NO_SESSION_EVIDENCE,
    readSessionEvidence,
    type SessionEvidence,
    type SessionPlace,
} from "../../clients/ui/src/session/evidence.ts";
import type { Block, SessionWatch, ToolCall } from "../../clients/ui/src/session/model.ts";
import { initialWatch, reduceWatch, watchClosed } from "../../clients/ui/src/session/transcript.ts";

function watch(patch: Partial<SessionWatch> = {}): SessionWatch {
    return { ...reduceWatch(initialWatch("a1"), { type: "attached" } as never), ...patch };
}

function tools(key: string, ...calls: ToolCall[]): Block {
    return { kind: "tools", key, calls, active: false };
}

function call(presentation?: ToolCall["presentation"]): ToolCall {
    return { tool: "edit", title: "edit a.ts", args: {}, state: "done", ...(presentation === undefined ? {} : { presentation }) };
}

const DIFF = { kind: "diff", diff: { path: "a.ts", added: 1, removed: 0, patches: [] } } as unknown as ToolCall["presentation"];
const CHECKLIST = { kind: "checklist", checklist: { items: [] } } as unknown as ToolCall["presentation"];
const FOLDER: SessionPlace = { folder: "/work/vera", chat: false };
const CHAT: SessionPlace = { folder: "/h/chat.files", chat: true };

function read(open: SessionWatch, place = FOLDER, seen: SessionEvidence = NO_SESSION_EVIDENCE): SessionEvidence {
    return readSessionEvidence(open, place, seen);
}

test("@core a session with nothing yet has no evidence beyond its folder", () => {
    expect(read(watch({ loaded: true }), { folder: undefined, chat: false })).toEqual(NO_SESSION_EVIDENCE);
    expect(read(watch({ loaded: true }))).toEqual({ ...NO_SESSION_EVIDENCE, files: true });
});

test("@core a diff or a checklist from history or the live turn turns on review or plan", () => {
    const withDiff = watch({ history: [tools("t1", call(DIFF))] });
    expect(read(withDiff)).toMatchObject({ review: true, plan: false });
    const withChecklist = watch({ live: [tools("t2", call(CHECKLIST))] });
    expect(read(withChecklist)).toMatchObject({ review: false, plan: true });
    expect(read(watch({ history: [tools("t3", call(), call({ kind: "tool_notice", text: "big" }))] }))).toMatchObject({ review: false, plan: false });
});

test("@core Files is available for chat and session folders", () => {
    expect(read(watch(), CHAT).files).toBe(true);
    expect(read(watch(), { folder: undefined, chat: false }).files).toBe(false);
    expect(read(watch(), { folder: "", chat: true }).files).toBe(false);
    expect(read(watch(), FOLDER).files).toBe(true);
});

test("@core context use or a stopped session turns the context pill on", () => {
    expect(read(watch()).context).toBe(false);
    expect(read(watch({ context: { tokens: 10, capacity: 100, components: [] } as never })).context).toBe(true);
    expect(read(watchClosed(watch(), "closed"))).toMatchObject({ context: true });
});

test("@core evidence already seen stays on while the same session is open", () => {
    const seen: SessionEvidence = { review: true, plan: true, files: true, context: true };
    expect(read(watch(), { folder: undefined, chat: false }, seen)).toEqual(seen);
});

test("evidence is read from the same blocks again without a new scan changing the answer", () => {
    const blocks = [tools("t1", call(DIFF)), tools("t2", call(CHECKLIST))];
    const open = watch({ history: blocks });
    const first = read(open);
    expect(read(open)).toEqual(first);
    expect(first).toMatchObject({ review: true, plan: true });
});
