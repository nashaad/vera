import { expect, test } from "bun:test";

import {
    canGoBack,
    canGoForward,
    currentRoute,
    HISTORY_LIMIT,
    INITIAL_ROUTER,
    lastSession,
    reduceRouter,
    routeTitle,
    sessionPlace,
    type PageKind,
    type RouterState,
} from "../../clients/ui/src/pages/routes.ts";

function go(state: RouterState, kind: PageKind): RouterState {
    return reduceRouter(state, { type: "navigate", route: { kind } });
}

test("@core back and forward walk the pages visited, and a new page drops the forward ones", () => {
    let state = go(go(INITIAL_ROUTER, "search"), "work");
    expect(currentRoute(state).kind).toBe("work");
    state = reduceRouter(state, { type: "back" });
    state = reduceRouter(state, { type: "back" });
    expect(currentRoute(state).kind).toBe("home");
    expect(canGoBack(state)).toBe(false);
    expect(reduceRouter(state, { type: "back" })).toBe(state);
    state = reduceRouter(state, { type: "forward" });
    expect(currentRoute(state).kind).toBe("search");
    state = go(state, "settings");
    expect(canGoForward(state)).toBe(false);
    expect(state.history.map((route) => route.kind)).toEqual(["home", "search", "settings"]);
});

test("opening the page already shown adds nothing, and history is capped", () => {
    expect(go(INITIAL_ROUTER, "home")).toBe(INITIAL_ROUTER);
    let state = INITIAL_ROUTER;
    for (let index = 0; index < HISTORY_LIMIT * 2; index += 1) state = go(state, index % 2 === 0 ? "work" : "search");
    expect(state.history.length).toBe(HISTORY_LIMIT);
    expect(state.cursor).toBe(HISTORY_LIMIT - 1);
});

test("workspace pages and New Chat in a folder are their own history entries", () => {
    let state = reduceRouter(INITIAL_ROUTER, { type: "navigate", route: { kind: "workspace", folder: "/work/nest" } });
    expect(reduceRouter(state, { type: "navigate", route: { kind: "workspace", folder: "/work/nest" } })).toBe(state);
    state = reduceRouter(state, { type: "navigate", route: { kind: "workspace", folder: "/work/roost" } });
    state = reduceRouter(state, { type: "navigate", route: { kind: "home", folder: "/work/roost" } });
    expect(state.history.length).toBe(4);
    expect(routeTitle(currentRoute(state))).toBe("New Chat");
    state = reduceRouter(state, { type: "back" });
    expect(routeTitle(currentRoute(state))).toBe("roost");
});

test("the last session is the newest one at or before the page shown", () => {
    expect(lastSession(INITIAL_ROUTER)).toBeUndefined();
    let state = reduceRouter(INITIAL_ROUTER, { type: "navigate", route: { kind: "session", agentId: "a", title: "First" } });
    state = reduceRouter(state, { type: "navigate", route: { kind: "session", agentId: "b", title: "Second" } });
    state = go(state, "search");
    expect(lastSession(state)?.agentId).toBe("b");
    state = reduceRouter(reduceRouter(state, { type: "back" }), { type: "back" });
    expect(lastSession(state)?.agentId).toBe("a");
});

test("a session route names a folder or a chat, never a chat's internal folder", () => {
    expect(sessionPlace("/p/crow", false)).toEqual({ workspace: "/p/crow" });
    expect(sessionPlace("", false)).toEqual({});
    expect(sessionPlace("/h/runtime/sessions/c.jsonl.files", true)).toEqual({ chat: true });
});
