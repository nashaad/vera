import { expect, test } from "bun:test";
import {
    adoptReportedPermission,
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

test("an access mode the session has not reported lights no cell", () => {
    const state = opened({ currentPermission: undefined });
    const access = text(state).split("\n").find((line) => line.includes("ACCESS"));
    expect(access).not.toContain("›");
    expect(access).not.toContain("live:");
    const kept = handleDialStripKey(state, { name: "enter" }, undefined);
    expect(kept.kind === "commit" && kept.permission).toBeUndefined();
    const first = press({ ...state, lane: "access" }, "right");
    expect(first.permissionModes[first.permissionIndex]).toBe("readonly");
    const picked = press(press({ ...state, lane: "access" }, "left"), "left");
    expect(picked.permissionModes[picked.permissionIndex]).toBe("ask");
    expect(handleDialStripKey(picked, { name: "enter" }, undefined)).toEqual({
        kind: "commit",
        agent: "default",
        permission: "ask",
    });
});

test("a mode reported after the HUD opens lights the lane unless access was moved", () => {
    const state = opened({ currentPermission: undefined });
    const lit = adoptReportedPermission(state, "auto");
    expect(lit.permissionModes[lit.permissionIndex]).toBe("auto");
    expect(text(lit)).toContain("›auto");
    expect(handleDialStripKey(lit, { name: "enter" }, undefined)).toEqual({
        kind: "commit",
        agent: "default",
    });
    const moved = press({ ...state, lane: "access" }, "right");
    expect(adoptReportedPermission(moved, "auto")).toBe(moved);
    expect(adoptReportedPermission(lit, "ask")).toBe(lit);
});

test("an agent picked before the mode arrives previews its posture once it does", () => {
    const plan = press(postureDial({ currentPermission: undefined }), "right");
    expect(plan.agents[plan.agentIndex]).toBe("plan");
    const lit = adoptReportedPermission(plan, "auto");
    expect(accessOf(lit)).toBe("readonly");
    expect(text(lit)).toContain("live: auto");
});

test("an agent that refuses the reported mode hands the lane back to the opened agent", () => {
    const writer = press(
        opened({ currentPermission: undefined, agentForbiddenAccess: { reviewer: ["readonly"] } }),
        "right",
    );
    expect(writer.agents[writer.agentIndex]).toBe("reviewer");
    const lit = adoptReportedPermission(writer, "readonly");
    expect(lit.agents[lit.agentIndex]).toBe("default");
    expect(accessOf(lit)).toBe("readonly");
    expect(handleDialStripKey(lit, { name: "enter" }, undefined)).toEqual({
        kind: "commit",
        agent: "default",
    });
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

const accessOf = (state: DialStripState): string | undefined =>
    state.permissionModes[state.permissionIndex];

const postureDial = (
    overrides: Parameters<typeof openDialStrip>[0] = {},
): DialStripState =>
    opened({
        agents: ["default", "plan", "builder", "custom"],
        currentAgent: "default",
        agentPostures: { plan: "readonly", builder: "auto", custom: "reviewer" },
        permissionModes: ["readonly", "ask", "auto"],
        currentPermission: "auto",
        ...overrides,
    });

test("moving to an agent with a narrower posture previews that posture", () => {
    const plan = press(postureDial(), "right");
    expect(plan.agents[plan.agentIndex]).toBe("plan");
    expect(accessOf(plan)).toBe("readonly");
    expect(text(plan)).toContain("live: auto");
    expect(handleDialStripKey(plan, { name: "enter" }, undefined)).toEqual({
        kind: "commit",
        agent: "plan",
        permission: "readonly",
    });
});

test("a posture equal to or wider than the session leaves the preview alone", () => {
    const equal = press(press(postureDial(), "right"), "right");
    expect(equal.agents[equal.agentIndex]).toBe("builder");
    expect(accessOf(equal)).toBe("auto");
    expect(equal.permissionEdited).toBeUndefined();
    expect(handleDialStripKey(equal, { name: "enter" }, undefined)).toEqual({
        kind: "commit",
        agent: "builder",
    });

    const wider = press(
        { ...postureDial({ currentPermission: "ask" }), lane: "agent" },
        "right",
    );
    expect(accessOf(wider)).toBe("readonly");
    const builder = press(wider, "right");
    expect(builder.agents[builder.agentIndex]).toBe("builder");
    expect(accessOf(builder)).toBe("ask");
    expect(builder.permissionEdited).toBeUndefined();
});

test("a custom posture is never taken as narrower", () => {
    const custom = press(postureDial(), "left");
    expect(custom.agents[custom.agentIndex]).toBe("custom");
    expect(accessOf(custom)).toBe("auto");
    expect(custom.permissionEdited).toBeUndefined();
});

test("the preview follows the opened mode, not the previous agent's preview", () => {
    const plan = press(postureDial(), "right");
    expect(accessOf(plan)).toBe("readonly");
    const builder = press(plan, "right");
    expect(builder.agents[builder.agentIndex]).toBe("builder");
    expect(accessOf(builder)).toBe("auto");
    expect(builder.permissionEdited).toBeUndefined();
    const back = press(press(builder, "left"), "left");
    expect(back.agents[back.agentIndex]).toBe("default");
    expect(accessOf(back)).toBe("auto");
    expect(handleDialStripKey(back, { name: "enter" }, undefined))
        .toEqual({ kind: "commit", agent: "default" });
});

test("an access mode chosen on the lane is what the next agent narrows", () => {
    let state = press({ ...postureDial(), lane: "access" }, "left");
    expect(accessOf(state)).toBe("ask");
    state = press({ ...state, lane: "agent" }, "right");
    expect(state.agents[state.agentIndex]).toBe("plan");
    expect(accessOf(state)).toBe("readonly");
    state = press(state, "right");
    expect(state.agents[state.agentIndex]).toBe("builder");
    expect(accessOf(state)).toBe("ask");
    expect(handleDialStripKey(state, { name: "enter" }, undefined)).toEqual({
        kind: "commit",
        agent: "builder",
        permission: "ask",
    });
});

test("a forbidden current mode falls back to the posture or the narrowest allowed mode", () => {
    const state = postureDial({
        agents: ["default", "plan", "strict"],
        agentPostures: { plan: "ask" },
        agentForbiddenAccess: { plan: ["auto"], strict: ["readonly", "auto"] },
    });
    const plan = press(state, "right");
    expect(accessOf(plan)).toBe("ask");
    const strict = press(plan, "right");
    expect(strict.agents[strict.agentIndex]).toBe("strict");
    expect(accessOf(strict)).toBe("ask");
});

test("a forbidden current mode never previews a wider posture", () => {
    const state = postureDial({
        agents: ["default", "careful"],
        agentPostures: { careful: "auto" },
        agentForbiddenAccess: { careful: ["ask"] },
        currentPermission: "ask",
    });
    const careful = press(state, "right");
    expect(careful.agents[careful.agentIndex]).toBe("careful");
    expect(accessOf(careful)).toBe("readonly");
    expect(handleDialStripKey(careful, { name: "enter" }, undefined)).toEqual({
        kind: "commit",
        agent: "careful",
        permission: "readonly",
    });
});

test("a posture the lane cannot show is never previewed", () => {
    const state = postureDial({
        agents: ["default", "plan"],
        agentPostures: { plan: "ask" },
        agentForbiddenAccess: { plan: ["auto"] },
        permissionModes: ["readonly", "auto"],
        currentPermission: "auto",
    });
    const plan = press(state, "right");
    expect(plan.agents[plan.agentIndex]).toBe("plan");
    expect(plan.permissionIndex).toBeGreaterThanOrEqual(0);
    expect(accessOf(plan)).toBe("readonly");
});

test("an agent with no mode the host would accept is never staged", () => {
    const state = postureDial({
        agents: ["default", "sealed", "plain"],
        agentForbiddenAccess: { sealed: ["readonly", "ask"] },
        currentPermission: "ask",
    });
    const skipped = press(state, "right");
    expect(skipped.agents[skipped.agentIndex]).toBe("plain");

    // The host judges the definition from the opened mode, so raising access first does not admit it.
    const raised = press({ ...state, lane: "access" }, "right");
    expect(accessOf(raised)).toBe("auto");
    const next = press({ ...raised, lane: "agent" }, "right");
    expect(next.agents[next.agentIndex]).toBe("plain");
    expect(accessOf(next)).toBe("auto");
});

test("a full access session keeps full access unless the definition narrows or forbids it", () => {
    const state = postureDial({
        agents: ["default", "plain", "plan", "strict"],
        agentPostures: { plan: "ask" },
        agentForbiddenAccess: { strict: ["full_access"] },
        currentPermission: "full_access",
    });
    const plain = press(state, "right");
    expect(plain.agents[plain.agentIndex]).toBe("plain");
    expect(plain.permissionEdited).toBeUndefined();
    expect(handleDialStripKey(plain, { name: "enter" }, undefined))
        .toEqual({ kind: "commit", agent: "plain" });

    const plan = press(plain, "right");
    expect(accessOf(plan)).toBe("ask");
    expect(handleDialStripKey(plan, { name: "enter" }, undefined))
        .toEqual({ kind: "commit", agent: "plan", permission: "ask" });

    const strict = press(plan, "right");
    expect(strict.agents[strict.agentIndex]).toBe("strict");
    expect(accessOf(strict)).toBe("readonly");
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
