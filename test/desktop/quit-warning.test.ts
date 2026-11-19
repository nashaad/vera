import { expect, test } from "bun:test";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { DesktopBridge } from "../../clients/ui/src/protocol/bridge.ts";
import type { AgentListFacts } from "../../clients/ui/src/protocol/client.ts";
import { unwatchDesktopSession, watchDesktopSession, watchedDesktopSessions } from "../../clients/ui/src/protocol/watchedSessions.ts";
import { QuitBackgroundCommandsSheet, quitBackgroundCommandWarningText } from "../../clients/ui/src/session/QuitBackgroundCommandsSheet.tsx";
import { QUIT_STOP_DEADLINE_MS, QuitWarningController, type QuitWarning } from "../../clients/ui/src/session/quitWarning.ts";

function deferred<T>() {
    let resolve: (value: T) => void = () => {};
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
}

function unload() {
    let prevented = false;
    const event = {
        returnValue: "unchanged",
        preventDefault: () => { prevented = true; },
    } as unknown as BeforeUnloadEvent;
    return { event, prevented: () => prevented };
}

async function tick(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
}

test("@core quit confirmation has approved text and choices", () => {
    expect(quitBackgroundCommandWarningText(1)).toBe("1 background command is running.");
    expect(quitBackgroundCommandWarningText(2)).toBe("2 background commands are running.");
    const calls: string[] = [];
    const props = {
        count: 2,
        onCancel: () => { calls.push("cancel"); },
        onKeepRunning: () => { calls.push("keep"); },
        onStop: () => { calls.push("stop"); },
    };
    const html = renderToStaticMarkup(createElement(QuitBackgroundCommandsSheet, props));
    expect(html).toContain("Quit Vera?");
    expect(html).toContain(">Cancel</button>");
    expect(html).toContain(">Keep running</button>");
    expect(html).toContain('class="button-primary session-sheet-action">Stop and quit</button>');
    expect(html).toContain("Keep running: stops after ten idle minutes.");
    expect(html.indexOf("Keep running: stops after ten idle minutes.")).toBeGreaterThan(html.indexOf(">Stop and quit</button>"));
    interface ButtonProps { onClick: () => void }
    interface ButtonRowProps { children: readonly ReactElement<ButtonProps>[] }
    interface FooterProps { children: readonly [ReactElement<ButtonRowProps>, ReactElement] }
    interface SheetProps { foot: ReactElement<FooterProps>; onClose: () => void }
    const sheet = QuitBackgroundCommandsSheet(props) as ReactElement<SheetProps>;
    sheet.props.onClose();
    for (const button of sheet.props.foot.props.children[0].props.children) button.props.onClick();
    expect(calls).toEqual(["cancel", "cancel", "keep", "stop"]);
});

test("@core renderer reload does not begin a quit warning or close the window", async () => {
    const warnings: Array<QuitWarning | undefined> = [];
    let reads = 0;
    let windowsClosed = 0;
    const controller = new QuitWarningController({
        watchedSessions: () => ["crow"],
        listAgents: async () => { reads += 1; return { agents: [{ id: "crow", background_commands: 1 }] }; },
        closeSession: async () => { throw new Error("unexpected close"); },
        showWarning: (warning) => { warnings.push(warning); },
        closeWindow: () => { windowsClosed += 1; },
    });
    const reload = unload();
    controller.beforeUnload(reload.event, false);
    await tick();
    expect(reload.prevented()).toBe(false);
    expect(reads).toBe(0);
    expect(warnings).toEqual([]);
    expect(windowsClosed).toBe(0);

    const quit = unload();
    controller.beforeUnload(quit.event, true);
    await tick();
    expect(quit.prevented()).toBe(true);
    expect(warnings).toEqual([{ count: 1, agentIds: ["crow"] }]);
    controller.cancel();

    const reloadAfterCancel = unload();
    controller.beforeUnload(reloadAfterCancel.event, false);
    await tick();
    expect(reloadAfterCancel.prevented()).toBe(false);
    expect(reads).toBe(1);
    expect(windowsClosed).toBe(0);
});

test("@core desktop quit counts distinct sessions across main, chat and subagent panes", () => {
    const watched: string[] = [];
    const unwatched: string[] = [];
    const bridge = {
        watchSession: (pane: string, agentId: string) => { watched.push(`${pane}:${agentId}`); },
        unwatchSession: (pane: string) => { unwatched.push(pane); },
    } as unknown as DesktopBridge;
    try {
        watchDesktopSession(bridge, "main", "crow");
        watchDesktopSession(bridge, "chat:0", "raven");
        watchDesktopSession(bridge, "subagent", "gull");
        expect(watchedDesktopSessions()).toEqual(["crow", "raven", "gull"]);
        watchDesktopSession(bridge, "chat:0", "crow");
        expect(watchedDesktopSessions()).toEqual(["crow", "gull"]);
        unwatchDesktopSession(bridge, "main");
        expect(watchedDesktopSessions()).toEqual(["crow", "gull"]);
        unwatchDesktopSession(bridge, "chat:0");
        expect(watchedDesktopSessions()).toEqual(["gull"]);
    } finally {
        unwatchDesktopSession(bridge, "main");
        unwatchDesktopSession(bridge, "chat:0");
        unwatchDesktopSession(bridge, "subagent");
    }
    expect(watchedDesktopSessions()).toEqual([]);
    expect(watched).toEqual(["main:crow", "chat:0:raven", "subagent:gull", "chat:0:crow"]);
    expect(unwatched).toEqual(["main", "chat:0", "main", "chat:0", "subagent"]);
});

test("@core a subagent pane with background commands shows a quit warning", async () => {
    const bridge = {
        watchSession: () => {},
        unwatchSession: () => {},
    } as unknown as DesktopBridge;
    const warnings: Array<QuitWarning | undefined> = [];
    const controller = new QuitWarningController({
        watchedSessions: watchedDesktopSessions,
        listAgents: async () => ({ agents: [{ id: "gull", background_commands: 1 }] }),
        closeSession: async () => {},
        showWarning: (warning) => { warnings.push(warning); },
        closeWindow: () => {},
    });
    watchDesktopSession(bridge, "subagent", "gull");
    try {
        const event = unload();
        controller.beforeUnload(event.event, true);
        await tick();
        expect(event.prevented()).toBe(true);
        expect(warnings).toEqual([{ count: 1, agentIds: ["gull"] }]);
    } finally {
        unwatchDesktopSession(bridge, "subagent");
    }
});

test("@core stop and quit closes every counted pane", async () => {
    const bridge = {
        watchSession: () => {},
        unwatchSession: () => {},
    } as unknown as DesktopBridge;
    const warnings: Array<QuitWarning | undefined> = [];
    const closed: string[] = [];
    const controller = new QuitWarningController({
        watchedSessions: watchedDesktopSessions,
        listAgents: async () => ({ agents: [
            { id: "crow", background_commands: 1 },
            { id: "raven", background_commands: 2 },
            { id: "gull", background_commands: 5 },
        ] }),
        closeSession: async (id) => { closed.push(id); },
        showWarning: (warning) => { warnings.push(warning); },
        closeWindow: () => {},
    });
    watchDesktopSession(bridge, "main", "crow");
    watchDesktopSession(bridge, "chat:0", "raven");
    watchDesktopSession(bridge, "subagent", "gull");
    try {
        controller.beforeUnload(unload().event, true);
        await tick();
        expect(warnings).toEqual([{ count: 8, agentIds: ["crow", "raven", "gull"] }]);
        await controller.stopAndQuit();
        expect(closed).toEqual(["crow", "raven", "gull"]);
    } finally {
        unwatchDesktopSession(bridge, "main");
        unwatchDesktopSession(bridge, "chat:0");
        unwatchDesktopSession(bridge, "subagent");
    }
});

test("@core quit reads all distinct open sessions before teardown and cancel retains state", async () => {
    const answer = deferred<AgentListFacts>();
    const warnings: Array<QuitWarning | undefined> = [];
    const closed: string[] = [];
    let windowsClosed = 0;
    let reads = 0;
    const controller = new QuitWarningController({
        watchedSessions: () => ["crow", "raven", "crow"],
        listAgents: async () => { reads += 1; return answer.promise; },
        closeSession: async (id) => { closed.push(id); },
        showWarning: (warning) => { warnings.push(warning); },
        closeWindow: () => { windowsClosed += 1; },
    });
    const first = unload();
    controller.beforeUnload(first.event, true);
    const repeated = unload();
    controller.beforeUnload(repeated.event, true);
    expect(first.prevented()).toBe(true);
    expect(repeated.prevented()).toBe(true);
    expect(reads).toBe(2);
    expect(windowsClosed).toBe(0);
    expect(closed).toEqual([]);
    answer.resolve({ agents: [
        { id: "crow", background_commands: 1 },
        { id: "raven", background_commands: 2 },
    ] });
    await tick();
    expect(warnings).toEqual([{ count: 3, agentIds: ["crow", "raven"] }]);
    expect(windowsClosed).toBe(0);
    controller.cancel();
    expect(warnings.at(-1)).toBeUndefined();
    expect(windowsClosed).toBe(0);
    expect(closed).toEqual([]);
    const retry = unload();
    controller.beforeUnload(retry.event, true);
    await tick();
    expect(retry.prevented()).toBe(true);
    expect(warnings.at(-1)).toEqual({ count: 3, agentIds: ["crow", "raven"] });
    controller.keepRunning();
    expect(windowsClosed).toBe(1);
    expect(closed).toEqual([]);
    const allowed = unload();
    controller.beforeUnload(allowed.event, true);
    expect(allowed.prevented()).toBe(false);
});

test("@core quit rechecks counts when open panes change during the lookup", async () => {
    const firstAnswer = deferred<AgentListFacts>();
    const warnings: Array<QuitWarning | undefined> = [];
    let open = ["crow"];
    let reads = 0;
    const controller = new QuitWarningController({
        watchedSessions: () => open,
        listAgents: async () => {
            reads += 1;
            if (reads === 1) return firstAnswer.promise;
            return { agents: [{ id: "raven", background_commands: 2 }] };
        },
        closeSession: async () => {},
        showWarning: (warning) => { warnings.push(warning); },
        closeWindow: () => {},
    });
    controller.beforeUnload(unload().event, true);
    open = ["raven"];
    firstAnswer.resolve({ agents: [{ id: "crow", background_commands: 1 }] });
    await tick();
    expect(reads).toBe(2);
    expect(warnings).toEqual([{ count: 2, agentIds: ["raven"] }]);
});

test("@core quit with no background commands continues without a warning", async () => {
    const warnings: Array<QuitWarning | undefined> = [];
    let windowsClosed = 0;
    const controller = new QuitWarningController({
        watchedSessions: () => ["crow"],
        listAgents: async () => ({ agents: [{ id: "crow" }] }),
        closeSession: async () => { throw new Error("unexpected close"); },
        showWarning: (warning) => { warnings.push(warning); },
        closeWindow: () => { windowsClosed += 1; },
    });
    const first = unload();
    controller.beforeUnload(first.event, true);
    expect(first.prevented()).toBe(true);
    expect(windowsClosed).toBe(0);
    await tick();
    expect(windowsClosed).toBe(1);
    expect(warnings.every((warning) => warning === undefined)).toBe(true);
    const allowed = unload();
    controller.beforeUnload(allowed.event, true);
    expect(allowed.prevented()).toBe(false);
});

test("quit retains the existing fallback when a command count cannot be verified", async () => {
    const warnings: Array<QuitWarning | undefined> = [];
    let windowsClosed = 0;
    const controller = new QuitWarningController({
        watchedSessions: () => ["crow"],
        listAgents: async () => { throw new Error("unavailable"); },
        closeSession: async () => { throw new Error("unexpected close"); },
        showWarning: (warning) => { warnings.push(warning); },
        closeWindow: () => { windowsClosed += 1; },
    });
    controller.beforeUnload(unload().event, true);
    await tick();
    expect(windowsClosed).toBe(1);
    expect(warnings.every((warning) => warning === undefined)).toBe(true);
});

test("@core quit stops every counted session and waits for all close requests", async () => {
    const a = deferred<void>();
    const b = deferred<void>();
    const closed: string[] = [];
    let windowsClosed = 0;
    const controller = new QuitWarningController({
        watchedSessions: () => ["crow", "raven", "empty"],
        listAgents: async () => ({ agents: [{ id: "crow", background_commands: 1 }, { id: "raven", background_commands: 2 }, { id: "empty" }] }),
        closeSession: (id) => { closed.push(id); return id === "crow" ? a.promise : b.promise; },
        showWarning: () => {},
        closeWindow: () => { windowsClosed += 1; },
    });
    controller.beforeUnload(unload().event, true);
    await tick();
    const quit = controller.stopAndQuit();
    await tick();
    expect(closed).toEqual(["crow", "raven"]);
    expect(windowsClosed).toBe(0);
    a.resolve();
    await tick();
    expect(windowsClosed).toBe(0);
    b.resolve();
    await quit;
    expect(windowsClosed).toBe(1);
});

test("@core stop and quit skips conversations no longer open at dispatch", async () => {
    let open = ["crow", "raven"];
    const closed: string[] = [];
    let windowsClosed = 0;
    const controller = new QuitWarningController({
        watchedSessions: () => open,
        listAgents: async () => ({ agents: [
            { id: "crow", background_commands: 1 },
            { id: "raven", background_commands: 1 },
        ] }),
        closeSession: async (id) => { closed.push(id); },
        showWarning: () => {},
        closeWindow: () => { windowsClosed += 1; },
    });
    controller.beforeUnload(unload().event, true);
    await tick();
    const quit = controller.stopAndQuit();
    open = ["crow"];
    await quit;
    expect(closed).toEqual(["crow"]);
    expect(windowsClosed).toBe(1);
});

test("@core stop and quit uses one bounded deadline even if a close never answers", async () => {
    expect(QUIT_STOP_DEADLINE_MS).toBe(3_000);
    const never = new Promise<void>(() => {});
    const closed: string[] = [];
    let windowsClosed = 0;
    const controller = new QuitWarningController({
        watchedSessions: () => ["crow", "raven"],
        listAgents: async () => ({ agents: [{ id: "crow", background_commands: 1 }, { id: "raven", background_commands: 1 }] }),
        closeSession: (id) => { closed.push(id); return never; },
        showWarning: () => {},
        closeWindow: () => { windowsClosed += 1; },
        stopDeadlineMs: 20,
    });
    controller.beforeUnload(unload().event, true);
    await tick();
    await controller.stopAndQuit();
    expect(closed).toEqual(["crow", "raven"]);
    expect(windowsClosed).toBe(1);
});
