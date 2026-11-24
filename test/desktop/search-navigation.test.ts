import { expect, test } from "bun:test";

import { FIND_CLOSE_COMMAND } from "../../clients/ui/src/commands/keys.ts";
import { closeFindOnSearchEntry, NAVIGATION_COMMANDS, registerNavigationCommands } from "../../clients/ui/src/commands/navigation-commands.ts";
import { CommandRegistry } from "../../clients/ui/src/commands/registry.ts";
import { createSearchFocusRequest, sessionSearchFocus } from "../../clients/ui/src/pages/focusSearch.ts";
import { currentRoute, INITIAL_ROUTER, reduceRouter, type RouterAction } from "../../clients/ui/src/pages/routes.ts";

test("@core Search closes Find and requests focus on every invocation", () => {
    const registry = new CommandRegistry();
    const events: string[] = [];
    const close = registry.register({ id: FIND_CLOSE_COMMAND, title: "Close Find", run: () => events.push("close") });
    const unsubscribe = sessionSearchFocus.subscribe(() => {
        if (sessionSearchFocus.take()) events.push("focus");
    });
    const dispose = registerNavigationCommands(registry, (action) => events.push(action.type));
    try {
        expect(registry.execute(NAVIGATION_COMMANDS.search)).toBe(true);
        expect(registry.execute(NAVIGATION_COMMANDS.search)).toBe(true);
        expect(events).toEqual(["close", "focus", "navigate", "close", "focus", "navigate"]);
    } finally {
        dispose();
        unsubscribe();
        close();
    }
});

test("@core entering Search closes Find from history and direct navigation", () => {
    const registry = new CommandRegistry();
    let closed = 0;
    const dispose = registry.register({ id: FIND_CLOSE_COMMAND, title: "Close Find", run: () => { closed += 1; } });
    let state = INITIAL_ROUTER;
    const transition = (action: RouterAction): void => {
        const previous = currentRoute(state).kind;
        state = reduceRouter(state, action);
        closeFindOnSearchEntry(registry, previous, currentRoute(state).kind);
    };
    try {
        transition({ type: "navigate", route: { kind: "search" } });
        expect(closed).toBe(1);
        transition({ type: "navigate", route: { kind: "home" } });
        transition({ type: "back" });
        expect(closed).toBe(2);
        transition({ type: "back" });
        transition({ type: "forward" });
        expect(closed).toBe(3);
        transition({ type: "navigate", route: { kind: "tour" } });
        transition({ type: "navigate", route: { kind: "search" } });
        expect(closed).toBe(4);
        transition({ type: "navigate", route: { kind: "search" } });
        expect(closed).toBe(4);
    } finally {
        dispose();
    }
});

test("a Search focus request waits for the page and is consumed once", () => {
    const request = createSearchFocusRequest();
    const received: boolean[] = [];
    request.request();
    const unsubscribe = request.subscribe(() => received.push(request.take()));
    expect(received).toEqual([true]);
    expect(request.take()).toBe(false);
    request.request();
    expect(received).toEqual([true, true]);
    unsubscribe();
});
