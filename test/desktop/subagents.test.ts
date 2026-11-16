import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { CommandRegistry } from "../../clients/ui/src/commands/registry.ts";
import { SESSION_COMMANDS } from "../../clients/ui/src/commands/session-commands.ts";
import { registerSubagentCommands } from "../../clients/ui/src/commands/subagent-commands.ts";
import { defaultLayout, MAX_TABS, type LayoutState } from "../../clients/ui/src/layout/model.ts";
import { reduceLayout, type LayoutAction } from "../../clients/ui/src/layout/reducer.ts";
import { resolveLayout, type ResolvedLayout } from "../../clients/ui/src/layout/resolve.ts";
import { currentToasts, dismissToast } from "../../clients/ui/src/overlays/toasts.ts";
import type { SessionRow } from "../../clients/ui/src/protocol/sessions.ts";
import { ContributionRegistry } from "../../clients/ui/src/registry/contributions.ts";
import { CORE_CONTAINERS, PANE_KINDS, registerCoreContributions } from "../../clients/ui/src/registry/core.ts";
import type { ToolCall } from "../../clients/ui/src/session/model.ts";
import {
    callChildId,
    callDescription,
    callStatusWord,
    childTitleOf,
    isCardCall,
    matchSubagentCalls,
    runSegments,
} from "../../clients/ui/src/session/subagentCards.ts";
import { splitChildren, statusWord } from "../../clients/ui/src/session/subagents.ts";
import { openSubagents, SUBAGENTS_TAB_FULL, type SubagentsHost } from "../../clients/ui/src/subagents/open.ts";
import { openChild, subagentsTab } from "../../clients/ui/src/subagents/store.ts";
import { asyncSubagentStartedText } from "../../src/tools/subagent-started.ts";

const contributions = new ContributionRegistry();
registerCoreContributions(contributions);
const snapshot = contributions.snapshot();

function fakeHost(): { readonly host: SubagentsHost; readonly state: () => LayoutState; readonly actions: LayoutAction[] } {
    let state = defaultLayout();
    const actions: LayoutAction[] = [];
    const host: SubagentsHost = {
        get layout(): ResolvedLayout {
            return resolveLayout(state, snapshot);
        },
        dispatch: (action) => {
            actions.push(action);
            state = reduceLayout(state, action, snapshot);
        },
    };
    return { host, state: () => state, actions };
}

function row(id: string, overrides: Partial<SessionRow> = {}): SessionRow {
    return { id, name: id, workspace: "/work", status: "idle", live: true, chat: false, ...overrides };
}

function call(tool: string, args: Record<string, unknown>, extra: Partial<ToolCall> = {}): ToolCall {
    return { tool, title: tool, args, state: "done", ...extra };
}

const asyncCall = (description: string, childId: string): ToolCall =>
    call("async_subagent", { description }, { output: asyncSubagentStartedText(childId) });

beforeEach(() => subagentsTab.reset());
afterEach(() => {
    subagentsTab.reset();
    for (const toast of currentToasts()) dismissToast(toast.id);
});

describe("matching subagent calls to children", () => {
    test("@core an async call takes the child its output names", () => {
        const first = asyncCall("Count the doubloons", "child-1");
        const second = asyncCall("Count the doubloons", "child-2");
        const rows = [row("child-1", { parentId: "main" }), row("child-2", { parentId: "main" })];
        const matches = matchSubagentCalls([first, second], rows, "main");
        expect(matches.get(first)?.id).toBe("child-1");
        expect(matches.get(second)?.id).toBe("child-2");
    });

    test("@core an async call whose child is not this session's, or not listed, has no match", () => {
        const other = asyncCall("Scout", "child-9");
        const unlisted = asyncCall("Scout", "child-8");
        const rows = [row("child-9", { parentId: "elsewhere" })];
        const matches = matchSubagentCalls([other, unlisted], rows, "main");
        expect(matches.get(other)).toBeUndefined();
        expect(matches.get(unlisted)).toBeUndefined();
    });

    test("@core a blocking call takes the child titled by its description", () => {
        const scout = call("subagent", { description: "Scout the reef" });
        const rows = [
            row("a", { parentId: "main", name: "Chart the harbour" }),
            row("b", { parentId: "main", name: "Scout the reef" }),
            row("c", { parentId: "other", name: "Scout the reef" }),
        ];
        expect(matchSubagentCalls([scout], rows, "main").get(scout)?.id).toBe("b");
    });

    test("@core the Nth blocking call of a title takes the Nth child of that title by age", () => {
        const first = call("subagent", { description: "Scout" });
        const second = call("subagent", { description: "Scout" });
        const rows = [
            row("new", { parentId: "main", name: "Scout", updatedAt: 30 }),
            row("old", { parentId: "main", name: "Scout", updatedAt: 10 }),
        ];
        const matches = matchSubagentCalls([first, second], rows, "main");
        expect(matches.get(first)?.id).toBe("old");
        expect(matches.get(second)?.id).toBe("new");
    });

    test("@core calls the transcript still holds pair with the newest children when older ones are not loaded", () => {
        const only = call("subagent", { description: "Scout" });
        const rows = [
            row("old", { parentId: "main", name: "Scout", updatedAt: 10 }),
            row("new", { parentId: "main", name: "Scout", updatedAt: 30 }),
        ];
        expect(matchSubagentCalls([only], rows, "main").get(only)?.id).toBe("new");
    });

    test("@core a blocking call skips a child an async call already took, and an unnamed or unmatched one has none", () => {
        const taken = asyncCall("Scout", "child-1");
        const blocking = call("subagent", { description: "Scout" });
        const blank = call("subagent", { description: "   " });
        const missing = call("subagent", {});
        const rows = [row("child-1", { parentId: "main", name: "Scout" })];
        const matches = matchSubagentCalls([taken, blocking, blank, missing], rows, "main");
        expect(matches.get(taken)?.id).toBe("child-1");
        expect(matches.get(blocking)).toBeUndefined();
        expect(matches.get(blank)).toBeUndefined();
        expect(matches.get(missing)).toBeUndefined();
    });

    test("only subagent and async_subagent calls are cards", () => {
        expect(isCardCall(call("subagent", {}))).toBe(true);
        expect(isCardCall(call("async_subagent", {}))).toBe(true);
        expect(isCardCall(call("message_subagent", {}))).toBe(false);
        expect(isCardCall(call("read", {}))).toBe(false);
    });

    test("a run splits into cards and the calls between them, in order", () => {
        const read = call("read", {});
        const bash = call("bash", {});
        const spawn = call("subagent", { description: "Scout" });
        const message = call("message_subagent", {});
        const later = call("async_subagent", { description: "Chart" });
        expect(runSegments([read, spawn, bash, message, later])).toEqual([
            { kind: "calls", calls: [read] },
            { kind: "card", call: spawn },
            { kind: "calls", calls: [bash, message] },
            { kind: "card", call: later },
        ]);
        expect(runSegments([read, bash])).toEqual([{ kind: "calls", calls: [read, bash] }]);
        expect(runSegments([])).toEqual([]);
    });

    test("a card opens the listed child, else the child an async call's output names", () => {
        const started = asyncCall("Scout", "child-1");
        expect(callChildId(started, row("child-1"))).toBe("child-1");
        expect(callChildId(started, undefined)).toBe("child-1");
        expect(callChildId(call("async_subagent", { description: "Scout" }), undefined)).toBeUndefined();
        expect(callChildId(call("subagent", { description: "Scout" }), undefined)).toBeUndefined();
    });

    test("a call's description is read only when it is text", () => {
        expect(callDescription(call("subagent", { description: "Scout" }))).toBe("Scout");
        expect(callDescription(call("subagent", { description: 4 }))).toBeUndefined();
    });
});

describe("status words", () => {
    test("each session status has its word", () => {
        expect(statusWord("working")).toBe("Working");
        expect(statusWord("waiting")).toBe("Waiting");
        expect(statusWord("idle")).toBe("Idle");
        expect(statusWord("completed")).toBe("Done");
        expect(statusWord("other")).toBe("Ended");
    });

    test("a call with no child row reads from its own state", () => {
        expect(callStatusWord("running")).toBe("Working");
        expect(callStatusWord("done")).toBe("Done");
        expect(callStatusWord("failed")).toBe("Failed");
    });
});

describe("the Active and Done lists", () => {
    test("working and waiting children are active and the rest are done, in the host's order", () => {
        const rows = [
            row("a", { parentId: "main", status: "completed" }),
            row("b", { parentId: "main", status: "working" }),
            row("c", { parentId: "main", status: "idle" }),
            row("d", { parentId: "main", status: "waiting" }),
            row("e", { parentId: "main", status: "other" }),
            row("f", { parentId: "elsewhere", status: "working" }),
            row("g"),
        ];
        const { active, done } = splitChildren(rows, "main");
        expect(active.map((child) => child.id)).toEqual(["b", "d"]);
        expect(done.map((child) => child.id)).toEqual(["a", "c", "e"]);
    });

    test("a session with no children has two empty lists", () => {
        expect(splitChildren([row("a")], "main")).toEqual({ active: [], done: [] });
    });
});

describe("the Subagents tab store", () => {
    test("showing a child sets the detail and showing none sets the list", () => {
        subagentsTab.show("main", "child-1");
        expect(subagentsTab.snapshot()).toEqual({ parentId: "main", childId: "child-1" });
        subagentsTab.show("main");
        expect(subagentsTab.snapshot()).toEqual({ parentId: "main" });
        subagentsTab.reset();
        expect(subagentsTab.snapshot()).toBeUndefined();
    });

    test("the detail shows only under the session it was opened for", () => {
        subagentsTab.show("main", "child-1");
        expect(openChild(subagentsTab.snapshot(), "main")).toBe("child-1");
        expect(openChild(subagentsTab.snapshot(), "other")).toBeUndefined();
        expect(openChild(undefined, "main")).toBeUndefined();
    });

    test("subscribers hear each change, and a reset of nothing is not one", () => {
        let heard = 0;
        const leave = subagentsTab.subscribe(() => { heard += 1; });
        subagentsTab.reset();
        subagentsTab.show("main", "child-1");
        subagentsTab.reset();
        leave();
        subagentsTab.show("main");
        expect(heard).toBe(2);
    });
});

describe("the Subagents kind", () => {
    test("@core Subagents is a right pane kind with one unsaved tab and no entry", () => {
        const kind = PANE_KINDS.find((candidate) => candidate.id === CORE_CONTAINERS.subagents);
        expect(kind).toMatchObject({ title: "Subagents", maxTabs: 1, transientTabs: true });
        expect(kind?.entry).toBeUndefined();
        expect(contributions.keepsTabsOut(CORE_CONTAINERS.subagents)).toBe(true);
    });

    test("@core opening it shows the tab and the detail, and opening again reuses the tab", () => {
        const { host, state, actions } = fakeHost();
        openSubagents(host, "main", "child-1");
        const tabs = state().tabs.filter((tab) => tab.container === CORE_CONTAINERS.subagents);
        expect(tabs).toHaveLength(1);
        expect(state().locations.rightPane).toMatchObject({ visible: true, active: tabs[0]?.id });
        expect(subagentsTab.snapshot()).toEqual({ parentId: "main", childId: "child-1" });

        openSubagents(host, "main");
        expect(state().tabs.filter((tab) => tab.container === CORE_CONTAINERS.subagents)).toHaveLength(1);
        expect(subagentsTab.snapshot()).toEqual({ parentId: "main" });
        expect(actions.every((action) => action.type === "activateContainer")).toBe(true);
    });

    test("@core with the pane closed it opens the pane, and with every tab taken it says so and changes nothing", () => {
        const closed = fakeHost();
        closed.host.dispatch({ type: "toggleLocation", location: "rightPane" });
        openSubagents(closed.host, "main");
        expect(closed.state().locations.rightPane.visible).toBe(true);

        const full = fakeHost();
        for (let index = 0; index < MAX_TABS; index += 1) full.host.dispatch({ type: "openTab", container: CORE_CONTAINERS.review });
        expect(full.host.layout.tabTotal).toBe(MAX_TABS);
        const before = full.state();
        subagentsTab.show("other", "child-0");
        openSubagents(full.host, "main", "child-1");
        expect(full.state()).toBe(before);
        expect(subagentsTab.snapshot()).toEqual({ parentId: "other", childId: "child-0" });
        expect(currentToasts().map((toast) => toast.text)).toContain(SUBAGENTS_TAB_FULL);
    });
});

describe("the subagents command", () => {
    test("the session command shows the tab through its target", () => {
        const registry = new CommandRegistry();
        let shown = 0;
        const off = registerSubagentCommands(registry, { show: () => { shown += 1; } });
        expect(registry.execute(SESSION_COMMANDS.subagents)).toBe(true);
        expect(shown).toBe(1);
        off();
        expect(registry.has(SESSION_COMMANDS.subagents)).toBe(false);
    });
});
