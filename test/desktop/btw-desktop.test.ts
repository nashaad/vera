import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { BTW_OFF, BTW_WORKING, runBtw, SIDEKICK_TITLE, type BtwContext, type BtwTabs } from "../../clients/ui/src/chat/btw.ts";
import { forgetSidekickOffered, INCLUDED_FRESH_MS, readSidekickOffered } from "../../clients/ui/src/chat/included.ts";
import { CHAT_TABS_FULL } from "../../clients/ui/src/chat/open.ts";
import { chatTabs, type ChatSeed } from "../../clients/ui/src/chat/store.ts";
import { BTW_SLASH_ENTRY, buildSlashEntries, resolveSlashLine } from "../../clients/ui/src/composer/slash/model.ts";
import { runSlashEntry, type SlashRunContext } from "../../clients/ui/src/composer/slash/run.ts";
import type { DesktopBridge, OpenSidekickResult, SyncSidekickResult } from "../../clients/ui/src/protocol/bridge.ts";
import { takePendingPrompt } from "../../clients/ui/src/session/pendingPrompt.ts";
import { SIDEKICK_BUSY_NOTICE } from "../../src/sidekick/branch.ts";

interface Harness {
    readonly context: BtwContext;
    readonly notes: string[];
    readonly restored: { count: number };
    readonly opened: string[];
    readonly shown: string[];
    readonly closed: string[];
    readonly sent: Array<{ pane: string; line: string }>;
    readonly syncs: string[];
    readonly branches: string[];
}

interface Options {
    readonly primary?: string;
    readonly offered?: boolean;
    readonly room?: boolean;
    readonly open?: () => Promise<OpenSidekickResult>;
    readonly sync?: () => Promise<SyncSidekickResult>;
    readonly tabOpens?: boolean;
}

let sidekicks = 0;

function harness(options: Options = {}): Harness {
    const notes: string[] = [];
    const restored = { count: 0 };
    const opened: string[] = [];
    const shown: string[] = [];
    const closed: string[] = [];
    const sent: Harness["sent"] = [];
    const syncs: string[] = [];
    const branches: string[] = [];
    const bridge = {
        openSidekick: async (primary: string) => {
            branches.push(primary);
            return options.open === undefined ? { ok: true, agentId: `side-${(sidekicks += 1)}` } : options.open();
        },
        syncSidekick: async (sidekick: string) => {
            syncs.push(sidekick);
            return options.sync === undefined ? { ok: true, decision: "ok" } : options.sync();
        },
        sendSession: (pane: string, line: string) => {
            sent.push({ pane, line });
        },
    } as unknown as DesktopBridge;
    const tabs: BtwTabs = {
        room: () => options.room !== false,
        open: (seed: ChatSeed) => {
            if (options.tabOpens === false) return undefined;
            const id = `tab.${opened.length}`;
            opened.push(id);
            chatTabs.add(id, seed);
            return id;
        },
        show: (tab) => shown.push(tab),
        close: (tab) => {
            closed.push(tab);
            chatTabs.drop([tab]);
        },
    };
    return {
        notes,
        restored,
        opened,
        shown,
        closed,
        sent,
        syncs,
        branches,
        context: {
            bridge,
            primary: options.primary ?? `primary-${(sidekicks += 1)}`,
            folder: "/nest",
            chat: false,
            tabs,
            offered: async () => options.offered !== false,
            notify: (text) => notes.push(text),
            restore: () => {
                restored.count += 1;
            },
        },
    };
}

beforeEach(() => chatTabs.reset());
afterEach(() => {
    chatTabs.reset();
    forgetSidekickOffered();
});

describe("/btw in the desktop composer", () => {
    test("@core /btw with a question opens the sidekick in a Chat tab and holds the question for its first attach", async () => {
        const { context, opened, branches, notes, sent } = harness({ primary: "crow-1" });
        await runBtw("what did we decide?", context);
        expect(branches).toEqual(["crow-1"]);
        expect(opened).toHaveLength(1);
        const entry = chatTabs.sidekickOf("crow-1");
        expect(entry?.entry).toMatchObject({ kind: "sidekick", title: SIDEKICK_TITLE, folder: "/nest", primary: "crow-1" });
        expect(takePendingPrompt(entry?.entry.agentId ?? "")).toEqual({ text: "what did we decide?", images: [] });
        expect(notes).toEqual([]);
        expect(sent).toEqual([]);
    });

    test("@core /btw alone opens the tab and sends nothing", async () => {
        const { context, opened, syncs } = harness({ primary: "crow-2" });
        await runBtw("", context);
        const entry = chatTabs.sidekickOf("crow-2");
        expect(opened).toHaveLength(1);
        expect(takePendingPrompt(entry?.entry.agentId ?? "")).toBeUndefined();
        expect(syncs).toEqual([]);
    });

    test("@core /btw again shows the same sidekick, and with a question syncs it, then sends to its pane", async () => {
        const first = harness({ primary: "crow-3" });
        await runBtw("", first.context);
        const existing = chatTabs.sidekickOf("crow-3");
        const again = harness({ primary: "crow-3" });
        await runBtw("and the tests?", again.context);
        expect(again.branches).toEqual([]);
        expect(again.shown).toEqual([existing?.tab ?? ""]);
        expect(again.syncs).toEqual([existing?.entry.agentId ?? ""]);
        expect(again.sent).toHaveLength(1);
        expect(again.sent[0]?.pane).toBe(existing?.entry.pane ?? "");
        expect(JSON.parse(again.sent[0]?.line ?? "{}")).toMatchObject({ type: "prompt", content: "and the tests?" });
    });

    test("@core /btw alone on an open sidekick shows its tab without syncing or sending", async () => {
        await runBtw("", harness({ primary: "crow-4" }).context);
        const again = harness({ primary: "crow-4" });
        await runBtw("", again.context);
        expect(again.shown).toHaveLength(1);
        expect(again.syncs).toEqual([]);
        expect(again.sent).toEqual([]);
        expect(again.branches).toEqual([]);
    });

    test("@core /btw close closes the session's sidekick tab, and does nothing when there is none", async () => {
        const none = harness({ primary: "crow-5" });
        await runBtw("close", none.context);
        expect(none.closed).toEqual([]);
        expect(none.branches).toEqual([]);

        await runBtw("", harness({ primary: "crow-5" }).context);
        const tab = chatTabs.sidekickOf("crow-5")?.tab;
        const close = harness({ primary: "crow-5" });
        await runBtw(" Close ", close.context);
        expect(close.closed).toEqual([tab ?? ""]);
        expect(chatTabs.sidekickOf("crow-5")).toBeUndefined();
    });

    test("@core /btw close works while the extension is off, so a tab can always be closed", async () => {
        await runBtw("", harness({ primary: "crow-6" }).context);
        const close = harness({ primary: "crow-6", offered: false });
        await runBtw("close", close.context);
        expect(close.closed).toHaveLength(1);
        expect(close.notes).toEqual([]);
    });

    test("@core with the extension off it says so, puts the line back and branches nothing", async () => {
        const { context, notes, restored, branches, opened } = harness({ offered: false });
        await runBtw("hello", context);
        expect(notes).toEqual([BTW_OFF]);
        expect(restored.count).toBe(1);
        expect(branches).toEqual([]);
        expect(opened).toEqual([]);
    });

    test("@core a refused branch says why, puts the line back and opens no tab", async () => {
        const { context, notes, restored, opened } = harness({ open: async () => ({ ok: false, reason: "That session is not available for a side chat." }) });
        await runBtw("hello", context);
        expect(notes).toEqual(["That session is not available for a side chat."]);
        expect(restored.count).toBe(1);
        expect(opened).toEqual([]);
    });

    test("@core no room for another Chat tab branches nothing, and a tab that fails to open says so", async () => {
        const full = harness({ room: false });
        await runBtw("hello", full.context);
        expect(full.notes).toEqual([CHAT_TABS_FULL]);
        expect(full.branches).toEqual([]);
        expect(full.restored.count).toBe(1);

        const refused = harness({ tabOpens: false });
        await runBtw("hello", refused.context);
        expect(refused.notes).toEqual([CHAT_TABS_FULL]);
        expect(refused.restored.count).toBe(1);
    });

    test("@core a primary mid-turn gives the soft notice and sends nothing", async () => {
        await runBtw("", harness({ primary: "crow-7" }).context);
        const busy = harness({ primary: "crow-7", sync: async () => ({ ok: true, decision: "busy" }) });
        await runBtw("now?", busy.context);
        expect(busy.notes).toEqual([SIDEKICK_BUSY_NOTICE]);
        expect(busy.sent).toEqual([]);
        expect(busy.restored.count).toBe(0);
    });

    test("@core a sync that fails says why, puts the line back and sends nothing", async () => {
        await runBtw("", harness({ primary: "crow-8" }).context);
        const failed = harness({ primary: "crow-8", sync: async () => ({ ok: false, reason: "BTW primary context is unavailable" }) });
        await runBtw("now?", failed.context);
        expect(failed.notes).toEqual(["BTW primary context is unavailable"]);
        expect(failed.restored.count).toBe(1);
        expect(failed.sent).toEqual([]);
    });

    test("@core a rewound primary replaces the sidekick in the same tab and asks the question there", async () => {
        await runBtw("", harness({ primary: "crow-9" }).context);
        const before = chatTabs.sidekickOf("crow-9");
        const stale = harness({ primary: "crow-9", sync: async () => ({ ok: true, decision: "stale" }) });
        await runBtw("again", stale.context);
        const after = chatTabs.sidekickOf("crow-9");
        expect(stale.branches).toEqual(["crow-9"]);
        expect(after?.tab).toBe(before?.tab ?? "");
        expect(after?.entry.pane).toBe(before?.entry.pane);
        expect(after?.entry.agentId).not.toBe(before?.entry.agentId);
        expect(takePendingPrompt(after?.entry.agentId ?? "")).toEqual({ text: "again", images: [] });
        expect(stale.sent).toEqual([]);
    });

    test("@core a second /btw while the first is still opening is refused, and nothing is branched twice", async () => {
        let release: (value: OpenSidekickResult) => void = () => undefined;
        const slow = harness({ primary: "crow-10", open: () => new Promise<OpenSidekickResult>((resolve) => { release = resolve; }) });
        const first = runBtw("one", slow.context);
        await Promise.resolve();
        const second = harness({ primary: "crow-10" });
        await runBtw("two", second.context);
        expect(second.notes).toEqual([BTW_WORKING]);
        expect(second.restored.count).toBe(1);
        expect(second.branches).toEqual([]);
        release({ ok: true, agentId: "side-slow" });
        await first;
        expect(chatTabs.sidekickOf("crow-10")?.entry.agentId).toBe("side-slow");
    });

    test("@core each session has its own sidekick", async () => {
        await runBtw("", harness({ primary: "crow-a" }).context);
        await runBtw("", harness({ primary: "crow-b" }).context);
        expect(chatTabs.sidekickOf("crow-a")?.tab).not.toBe(chatTabs.sidekickOf("crow-b")?.tab);
    });
});

describe("the /btw menu entry", () => {
    const extension = { name: "btw", description: "from the extension", usage: "", source: "vera.btw/btw" };

    test("@core /btw is listed only when the window offers it, and the extension's own entry never is", () => {
        const names = (entries: ReturnType<typeof buildSlashEntries>): string[] => entries.map((entry) => entry.name);
        expect(names(buildSlashEntries([extension], []))).not.toContain("btw");
        const offered = buildSlashEntries([extension], [], new Set(), true);
        expect(names(offered).filter((name) => name === "btw")).toHaveLength(1);
        expect(offered.find((entry) => entry.name === "btw")).toBe(BTW_SLASH_ENTRY);
    });

    test("@core a typed /btw line resolves to the window's entry with its arguments", () => {
        const entries = buildSlashEntries([extension], [], new Set(), true);
        const resolved = resolveSlashLine(entries, "/btw what did we decide?");
        expect(resolved.kind === "command" ? resolved.entry : undefined).toBe(BTW_SLASH_ENTRY);
        expect(resolved.kind === "command" ? resolved.args : undefined).toBe("what did we decide?");
        expect(resolveSlashLine(buildSlashEntries([extension], []), "/btw hi").kind).toBe("unknown");
    });

    test("@core running the entry hands the arguments to /btw, and without a session it says so", async () => {
        const got: string[] = [];
        const notes: string[] = [];
        const base: SlashRunContext = { session: undefined, run: () => undefined, notify: (text) => notes.push(text), restore: () => undefined };
        await runSlashEntry(BTW_SLASH_ENTRY, "hello", { ...base, btw: async (args) => { got.push(args); } });
        await runSlashEntry(BTW_SLASH_ENTRY, "hello", base);
        expect(got).toEqual(["hello"]);
        expect(notes).toEqual(["/btw needs an open session"]);
    });
});

describe("reading whether /btw is on", () => {
    function bridgeReading(answers: Array<{ ok: true; disabled: string[] } | { ok: false } | "throw">): { bridge: DesktopBridge; reads: () => number } {
        let reads = 0;
        const bridge = {
            readIncludedExtensions: async () => {
                const answer = answers[Math.min(reads, answers.length - 1)];
                reads += 1;
                if (answer === "throw" || answer === undefined) throw new Error("channel closed");
                return answer.ok ? answer : { ok: false, reason: "The task failed." };
            },
        } as unknown as DesktopBridge;
        return { bridge, reads: () => reads };
    }

    test("@core it is on unless config.json disables vera.btw", async () => {
        expect(await readSidekickOffered(bridgeReading([{ ok: true, disabled: [] }]).bridge)).toBe(true);
        forgetSidekickOffered();
        expect(await readSidekickOffered(bridgeReading([{ ok: true, disabled: ["vera.other"] }]).bridge)).toBe(true);
        forgetSidekickOffered();
        expect(await readSidekickOffered(bridgeReading([{ ok: true, disabled: ["vera.btw"] }]).bridge)).toBe(false);
    });

    test("@core an answer is reused for the fresh window, then read again, and parallel reads share one request", async () => {
        const { bridge, reads } = bridgeReading([{ ok: true, disabled: [] }, { ok: true, disabled: ["vera.btw"] }]);
        let now = 1_000;
        const clock = (): number => now;
        const [a, b] = await Promise.all([readSidekickOffered(bridge, clock), readSidekickOffered(bridge, clock)]);
        expect([a, b]).toEqual([true, true]);
        expect(reads()).toBe(1);
        now += INCLUDED_FRESH_MS - 1;
        expect(await readSidekickOffered(bridge, clock)).toBe(true);
        expect(reads()).toBe(1);
        now += 2;
        expect(await readSidekickOffered(bridge, clock)).toBe(false);
        expect(reads()).toBe(2);
    });

    test("@core a read that fails or throws counts as off and is tried again next time", async () => {
        const failing = bridgeReading([{ ok: false }, { ok: true, disabled: [] }]);
        expect(await readSidekickOffered(failing.bridge)).toBe(false);
        expect(await readSidekickOffered(failing.bridge)).toBe(true);
        expect(failing.reads()).toBe(2);
        forgetSidekickOffered();
        const throwing = bridgeReading(["throw"]);
        expect(await readSidekickOffered(throwing.bridge)).toBe(false);
        expect(await readSidekickOffered(throwing.bridge)).toBe(false);
        expect(throwing.reads()).toBe(2);
    });
});
