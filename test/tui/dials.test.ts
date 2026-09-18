import { expect, test } from "bun:test";
import {
    DIAL_EXIT_SEPARATOR,
    type DialLane,
    type DialStripState,
    handleDialStripKey,
    moveDialLane,
    openDialStrip,
    renderDialStrip,
} from "../../clients/tui/dials.ts";

function opened(
    overrides: Parameters<typeof openDialStrip>[0] = {},
): DialStripState {
    return openDialStrip({
        agents: ["default", "reviewer"],
        currentAgent: "default",
        permissionModes: ["readonly", "ask", "auto"],
        currentPermission: "ask",
        ...overrides,
    });
}

function press(
    state: DialStripState,
    key: string | { readonly name: string; readonly shift?: boolean },
): DialStripState {
    const action = handleDialStripKey(
        state,
        typeof key === "string" ? { name: key } : key,
        undefined,
    );
    expect(action.kind).toBe("state");
    if (action.kind !== "state") throw new Error("expected staged state");
    return action.state;
}

const text = (state: DialStripState, width = 100): string =>
    renderDialStrip(state, "hints", width).join("\n");

test("the HUD is two lanes, spaced, over one footer", () => {
    const lines = renderDialStrip(opened(), "hints", 100);
    expect(lines).toHaveLength(5);
    expect(lines[0]).toContain("AGENT");
    expect(lines[1]).toBe("");
    expect(lines[2]).toContain("ACCESS");
    expect(lines[3]).toBe("");
    expect(lines.at(-1)).toContain("hints");
    expect(lines.at(-1)?.replace(DIAL_EXIT_SEPARATOR, "")).toEndWith(
        "esc cancel",
    );
    expect(lines.join("\n")).not.toContain("MODEL");
    expect(lines.join("\n")).not.toContain("EFFORT");
});

test("the HUD opens on the agent rung, and arrows walk the lanes and wrap", () => {
    const state = opened();
    expect(state.lane).toBe("agent");
    expect(moveDialLane(state, 1).lane).toBe("access");
    expect(moveDialLane(state, 2).lane).toBe("agent");
    expect(moveDialLane(state, -1).lane).toBe("access");
});

test("arrows walk the rungs in the order they are drawn", () => {
    // Read off the screen rather than restated here: a rung that moves on
    // screen without moving in the walk is the failure this catches.
    const drawn = renderDialStrip(opened(), "hints", 100)
        .map((line) => /^[› ] (ACCESS|AGENT)/.exec(line)?.[1])
        .filter((label): label is string => label !== undefined)
        .map((label) => label.toLowerCase() as DialLane);
    expect(drawn).toEqual(["agent", "access"]);
    expect(drawn.map((_, step) => moveDialLane(opened(), step).lane))
        .toEqual(drawn);
});

test("vertical arrows change lane and horizontal arrows change the choice", () => {
    const state = opened();
    for (const [lane, key, next] of [
        ["agent", "down", "access"],
        ["agent", "up", "access"],
        ["access", "down", "agent"],
        ["access", "up", "agent"],
    ] as const) {
        expect(press({ ...state, lane }, key).lane).toBe(next);
    }
    const agent = press(state, "right");
    expect(agent.lane).toBe("agent");
    expect(agent.agents[agent.agentIndex]).toBe("reviewer");
    const access = press({ ...state, lane: "access" }, "right");
    expect(access.lane).toBe("access");
    expect(access.permissionModes[access.permissionIndex]).toBe("auto");
});

test("Tab and reverse Tab cycle the lanes without staging values", () => {
    const original = opened();
    let state = original;
    for (const lane of ["access", "agent"] as const) {
        state = press(state, "tab");
        expect(state.lane).toBe(lane);
        expect(state.agents[state.agentIndex]).toBe("default");
        expect(state.permissionEdited).toBeUndefined();
    }
    for (const key of [{ name: "tab", shift: true }, { name: "backtab" }]) {
        const action = handleDialStripKey(original, key, undefined);
        expect(action.kind === "state" && action.state.lane).toBe("access");
    }
});

test("arrows stage their values, Enter applies them, and Escape cancels", () => {
    const original = opened();
    let state = press(original, "right");
    state = press(press(state, "tab"), "right");
    expect(handleDialStripKey(state, { name: "enter" }, undefined)).toEqual({
        kind: "commit",
        agent: "reviewer",
        permission: "auto",
    });
    expect(handleDialStripKey(state, { name: "escape" }, undefined))
        .toEqual({ kind: "cancel" });
    expect(original.agents[original.agentIndex]).toBe("default");
    expect(original.permissionModes[original.permissionIndex]).toBe("ask");
});

test("an untouched access lane is left out of the commit", () => {
    const applied = handleDialStripKey(opened(), { name: "enter" }, undefined);
    expect(applied).toEqual({ kind: "commit", agent: "default" });
});

test("a staged value appears beside the live one", () => {
    expect(text(press(opened(), "right"))).toContain("live: default");
    expect(text(press({ ...opened(), lane: "access" }, "right")))
        .toContain("live: ask");
});

test("full access is not offered or changed without an explicit HUD move", () => {
    const state = opened({ currentPermission: "full_access" });
    expect(text(state)).not.toContain("full access");
    const applied = handleDialStripKey(state, { name: "enter" }, undefined);
    expect(applied.kind === "commit" && applied.permission).toBeUndefined();
});

test("unavailable access values are marked and skipped", () => {
    const state = opened({
        permissionModes: ["ask", "auto", "full_access"],
        currentPermission: "auto",
        disabledPermissionModes: ["full_access"],
    });
    const moved = handleDialStripKey(
        { ...state, lane: "access" },
        { name: "right" },
        undefined,
    );
    expect(moved.kind === "state"
        && moved.state.permissionModes[moved.state.permissionIndex]).toBe("ask");
    expect(text(state)).toContain("full (off)");
});

test("an empty agent lane still applies staged access", () => {
    const empty = openDialStrip({
        permissionModes: ["ask", "auto"],
        currentPermission: "ask",
    });
    const moved = press({ ...empty, lane: "access" }, "right");
    expect(handleDialStripKey(moved, { name: "enter" }, undefined)).toEqual({
        kind: "commit",
        permission: "auto",
    });
    expect(text(empty)).toContain("unavailable");
});

test("an agent's forbidden access stays visible but cannot be selected", () => {
    const state = opened({
        agents: ["default", "plan"],
        currentAgent: "default",
        agentPostures: { plan: "readonly" },
        agentForbiddenAccess: { plan: ["auto", "full_access"] },
        currentPermission: "auto",
    });
    const plan = press(state, "right");
    expect(plan.agents[plan.agentIndex]).toBe("plan");
    expect(plan.permissionModes[plan.permissionIndex]).toBe("readonly");
    expect(text(plan)).toContain("auto (off)");

    const access = { ...plan, lane: "access" as const };
    const left = press(access, "left");
    expect(left.permissionModes[left.permissionIndex]).toBe("ask");
    const right = press(left, "right");
    expect(right.permissionModes[right.permissionIndex]).toBe("readonly");
});

test("agent changes skip disabled postures and agents without permitted access", () => {
    const original = opened({
        agents: ["default", "restricted", "blocked"],
        currentAgent: "default",
        agentPostures: { restricted: "full_access" },
        agentForbiddenAccess: {
            restricted: ["auto"],
            blocked: ["ask", "auto"],
        },
        permissionModes: ["ask", "auto", "full_access"],
        currentPermission: "auto",
        disabledPermissionModes: ["full_access"],
    });
    const staged = press(original, "right");
    expect(staged.agents[staged.agentIndex]).toBe("restricted");
    expect(staged.permissionModes[staged.permissionIndex]).toBe("ask");
    expect(handleDialStripKey(staged, { name: "enter" }, undefined)).toEqual({
        kind: "commit",
        agent: "restricted",
        permission: "ask",
    });
    expect(press(staged, "right").agentIndex).toBe(0);
    expect(
        handleDialStripKey(
            { ...staged, permissionIndex: 2 },
            { name: "enter" },
            undefined,
        ),
    ).toEqual({ kind: "ignore" });
});

test("the HUD windows a long lane instead of wrapping it", () => {
    const state = opened({
        agents: ["default", "researcher", "reviewer", "archaeologist"],
        currentAgent: "archaeologist",
    });
    for (const width of [80, 60, 44, 30, 20]) {
        const lines = renderDialStrip(state, "hints", width);
        expect(lines).toHaveLength(5);
        for (const line of lines) {
            expect(line.replace(DIAL_EXIT_SEPARATOR, "").length)
                .toBeLessThanOrEqual(width);
        }
    }
    expect(text(state, 44)).toContain("›archaeologist");
    expect(text(state, 44)).not.toContain("researcher");
});

test("keys the HUD does not use are ignored", () => {
    const state = opened();
    for (const key of [
        { name: "h" },
        { name: "1" },
        { name: "m" },
        { name: "x", ctrl: true },
    ]) {
        expect(handleDialStripKey(state, key, undefined))
            .toEqual({ kind: "ignore" });
    }
});
