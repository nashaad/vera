import { expect, test } from "bun:test";
import {
    adjustDialEffort,
    composeDialStrip,
    DIAL_HUD_CAP,
    DIAL_HUD_RECENT_CAP,
    dialStripSelection,
    handleDialStripKey,
    jumpDialStrip,
    DIAL_DEFAULT_SEPARATOR,
    DIAL_EXIT_SEPARATOR,
    DIAL_PROVIDER_SEPARATOR,
    moveDialLane,
    moveDialStrip,
    openDialStrip,
    renderEffortScale,
    renderDialStrip,
    type DialPair,
    type DialLane,
    type DialPoolEntry,
    type DialStripState,
} from "../../clients/tui/dials.ts";

const POOL: readonly DialPoolEntry[] = [
    {
        provider: "openai-codex",
        model: "gpt-5.6-sol",
        poolName: "sol",
        levels: ["low", "medium", "high"],
    },
    {
        provider: "zai",
        model: "glm-5",
        poolName: "luna",
        levels: ["low", "high"],
    },
    { provider: "ollama", model: "qwen3:32b", levels: [] },
];

const SOL = { provider: "openai-codex", model: "gpt-5.6-sol", effort: "low" };
const LUNA = { provider: "zai", model: "glm-5", effort: "high" };

test("position one is always the committed pair, and nothing repeats", () => {
    const composition = composeDialStrip({
        current: SOL,
        recents: [LUNA, SOL],
        pool: POOL,
    });
    expect(composition.slots.map((slot) => slot.label)).toEqual(["sol", "luna"]);
    expect(composition.slots[0]?.source).toBe("current");
    expect(composition.slots[0]?.pair).toEqual(SOL);
});



test("the strip cap does not invent an unreachable overflow row", () => {
    const composition = composeDialStrip({
        current: SOL,
        recents: Array.from({ length: 9 }, (_, index) => ({
            provider: "zai",
            model: `glm-5-${index}`,
        })),
        pool: POOL,
    });
    expect(composition.slots).toHaveLength(6);
    expect(composition.overflow).toBe(4);
    expect(renderDialStrip(openDialStrip(composition, SOL), "hints").join("\n"))
        .not.toContain("…");
});



test("the HUD windows long lanes instead of wrapping them", () => {
    const composition = composeDialStrip({
        current: SOL,
        recents: [{ provider: "ollama", model: "qwen3:32b" }],
        pool: POOL,
        includePool: true,
    });
    const lines = renderDialStrip(
        openDialStrip(composition, SOL, {
            agents: ["default", "researcher", "reviewer"],
            currentAgent: "reviewer",
            permissionModes: ["readonly", "ask", "auto"],
            currentPermission: "full_access",
        }),
        "tab/shift+tab lane · left/right change · enter apply",
        44,
    );
    expect(lines.length).toBeGreaterThanOrEqual(5);
    expect(lines.every((line) => line.replace("\u001e", "").length <= 44)).toBe(true);
    expect(lines.at(-1)?.replace("\u001e", "")).toEndWith("esc cancel");
    expect(lines.join("\n")).toContain("qwen3:32b");
    expect(lines.join("\n")).not.toContain("openai-codex");
    expect(lines.join("\n")).toContain("‹ reviewer ›");
    expect(lines.join("\n")).not.toContain("full access");
    expect(lines.join("\n")).toContain("EFFORT");
    expect(lines.join("\n")).toContain("AGENT");
    expect(lines.join("\n")).toContain("ACCESS");
    const compact = renderDialStrip(
        moveDialLane(openDialStrip(composition, SOL), 2),
        "hints",
        36,
    );
    expect(compact.join("\n")).toContain("MODEL");
    expect(compact.join("\n")).toContain("EFFORT");
    expect(compact.at(-1)).toContain("↑/↓ lane · ←/→");
    const wide = renderDialStrip(
        openDialStrip(composition, SOL),
        "hints",
        90,
    );
    expect(wide).toHaveLength(5);
});

test("the effort scale explains the faster-to-smarter direction when it fits", () => {
    const scale = renderEffortScale(
        ["low", "medium", "high", "xhigh", "max"],
        "high",
        80,
    );
    expect(scale).toHaveLength(3);
    expect(scale[0]).toContain("Faster");
    expect(scale[0]).toContain("Smarter");
    expect(scale[1]).toContain("▲");
    expect(scale[2]).toContain("medium");
    expect(scale.join("\n").length).toBeLessThanOrEqual(80 * 2);
    expect(renderEffortScale(["low", "high"], "low", 48)).toEqual([]);
});



test("moving sideways retains an uncommitted effort edit", () => {
    const composition = composeDialStrip({
        current: SOL,
        recents: [LUNA],
        pool: POOL,
    });
    let state = openDialStrip(composition, SOL);
    state = adjustDialEffort(state, 1);
    expect(dialStripSelection(state)?.effort).toBe("medium");
    state = moveDialStrip(state, 1);
    state = moveDialStrip(state, -1);
    // Returning to a compatible model restores the staged effort.
    expect(dialStripSelection(state)?.effort).toBe("medium");
});

test("effort cycles through the provider default", () => {
    const composition = composeDialStrip({
        current: SOL,
        recents: [],
        pool: POOL,
    });
    let state = openDialStrip(composition, SOL);
    state = adjustDialEffort(state, -1);
    expect(dialStripSelection(state)?.effort).toBeUndefined();
    state = adjustDialEffort(state, -1);
    expect(dialStripSelection(state)?.effort).toBe("high");
    state = adjustDialEffort(state, 1);
    expect(dialStripSelection(state)?.effort).toBeUndefined();
});

test("a pair with no effort dial takes the arrows without complaint", () => {
    const bare = { provider: "ollama", model: "qwen3:32b" };
    const composition = composeDialStrip({
        current: bare,
        recents: [],
        pool: POOL,
    });
    const state = openDialStrip(composition, bare);
    expect(adjustDialEffort(state, 1)).toBe(state);
    expect(adjustDialEffort(state, -1)).toBe(state);
    expect(dialStripSelection(state)).toEqual(bare);
    expect(renderDialStrip(moveDialLane(state, 2), "hints")[0]).toContain(
        "‹ default ›",
    );
});

test("a number jumps to a position, and out of range does nothing", () => {
    const composition = composeDialStrip({
        current: SOL,
        recents: [LUNA],
        pool: POOL,
    });
    const state = openDialStrip(composition, SOL);
    expect(jumpDialStrip(state, 2).index).toBe(1);
    expect(jumpDialStrip(state, 9)).toBe(state);
    expect(jumpDialStrip(state, 0)).toBe(state);
});

test("the HUD opens on its top rung and arrows walk down and wraps", () => {
    const state = openDialStrip(
        composeDialStrip({ current: SOL, recents: [], pool: POOL }),
        SOL,
    );
    expect(state.lane).toBe("effort");
    const walked = ["access", "model", "agent", "effort"].map((_, step) =>
        moveDialLane(state, step + 1).lane
    );
    expect(walked).toEqual(["access", "model", "agent", "effort"]);
    expect(moveDialLane(state, -1).lane).toBe("agent");
});









test("full access is not offered or changed without an explicit HUD move", () => {
    const composition = composeDialStrip({
        current: SOL,
        recents: [],
        pool: POOL,
    });
    const state = openDialStrip(composition, SOL, {
        permissionModes: ["readonly", "ask", "auto"],
        currentPermission: "full_access",
    });
    expect(renderDialStrip(state, "/permissions for more").join("\n"))
        .not.toContain("full access");
    const applied = handleDialStripKey(state, { name: "enter" }, undefined);
    expect(applied.kind === "commit" && applied.permission).toBeUndefined();
});

test("an agent's forbidden access stays visible but cannot be selected", () => {
    const composition = composeDialStrip({
        current: SOL,
        recents: [],
        pool: POOL,
    });
    let state = openDialStrip(composition, SOL, {
        agents: ["default", "plan"],
        currentAgent: "default",
        agentPostures: { plan: "readonly" },
        agentForbiddenAccess: { plan: ["auto", "full_access"] },
        permissionModes: ["readonly", "ask", "auto"],
        currentPermission: "auto",
    });
    state = { ...state, lane: "agent" };
    const plan = handleDialStripKey(
        state,
        { name: "right" },
        "dials.pair.next",
    );
    expect(plan.kind).toBe("state");
    if (plan.kind !== "state") return;
    expect(plan.state.agents[plan.state.agentIndex]).toBe("plan");
    expect(plan.state.permissionModes[plan.state.permissionIndex])
        .toBe("readonly");
    expect(renderDialStrip(plan.state, "hints", 100).join("\n"))
        .toContain("auto (off)");

    const access = { ...plan.state, lane: "access" as const };
    const left = handleDialStripKey(
        access,
        { name: "left" },
        "dials.pair.prev",
    );
    expect(left.kind === "state"
        && left.state.permissionModes[left.state.permissionIndex]).toBe("ask");
    const right = handleDialStripKey(
        left.kind === "state" ? left.state : access,
        { name: "right" },
        "dials.pair.next",
    );
    expect(right.kind === "state"
        && right.state.permissionModes[right.state.permissionIndex])
        .toBe("readonly");
});

test("a ready pool entry with no levels keeps the dial off, catalog or not", () => {
    const bare = { provider: "ollama", model: "qwen3:32b" };
    const composition = composeDialStrip({
        current: bare,
        recents: [],
        pool: [{
            provider: "ollama",
            model: "qwen3:32b",
            levels: [],
            available: true,
        }],
        catalog: [{
            provider: "ollama",
            model: "qwen3:32b",
            levels: ["high", "low"],
        }],
    });
    expect(composition.slots[0]?.efforts).toEqual([]);
    const state = openDialStrip(composition, bare);
    expect(adjustDialEffort(state, 1)).toBe(state);
});

test("a model outside the pool still gets its dial from the catalog", () => {
    const fresh = { provider: "openrouter", model: "moonshotai/kimi-k3" };
    const composition = composeDialStrip({
        current: fresh,
        recents: [],
        pool: POOL,
        catalog: [{
            provider: "openrouter",
            model: "moonshotai/kimi-k3",
            levels: ["high", "medium", "low"],
        }],
    });
    let state = openDialStrip(composition, fresh);
    // Declared smartest first; the track always runs faster to smarter.
    expect(composition.slots[0]?.efforts).toEqual(["low", "medium", "high"]);
    expect(renderDialStrip(state, "hints").join("\n")).not.toContain(
        "not available",
    );
    state = adjustDialEffort(state, 1);
    expect(dialStripSelection(state)?.effort).toBe("low");
});

test("effort levels run faster to smarter whatever order they arrive in", () => {
    const pair = { provider: "openrouter", model: "reversed" };
    const ordered = composeDialStrip({
        current: pair,
        recents: [],
        pool: [{
            provider: "openrouter",
            model: "reversed",
            levels: ["high", "low", "medium"],
        }],
    });
    expect(ordered.slots[0]?.efforts).toEqual(["low", "medium", "high"]);

    // An unrecognised level cannot be ranked, so the list is taken as the
    // strongest-first one its contract promises and reversed. The unknown
    // level keeps the neighbours the provider gave it.
    const custom = composeDialStrip({
        current: pair,
        recents: [],
        pool: [{
            provider: "openrouter",
            model: "reversed",
            levels: ["high", "ludicrous", "low"],
        }],
    });
    expect(custom.slots[0]?.efforts).toEqual(["low", "ludicrous", "high"]);

    // A producer that ships an unrankable list the wrong way round is caught
    // by the levels that can be ranked, so the axis never reads backwards.
    const broken = composeDialStrip({
        current: pair,
        recents: [],
        pool: [{
            provider: "openrouter",
            model: "reversed",
            levels: ["low", "medium", "high", "ludicrous"],
        }],
    });
    expect(broken.slots[0]?.efforts).toEqual(["low", "medium", "high", "ludicrous"]);
});

test("recents cap at five and the pool backfills the rest of the HUD", () => {
    const recents = Array.from({ length: 8 }, (_, index) => ({
        provider: "openrouter",
        model: `recent-${index}`,
    }));
    const pool = Array.from({ length: 8 }, (_, index) => ({
        provider: "openrouter",
        model: `pooled-${index}`,
        levels: ["high"],
        available: true,
    }));
    const composition = composeDialStrip({
        current: { provider: "openrouter", model: "on-now" },
        recents,
        pool,
        includePool: true,
        cap: DIAL_HUD_CAP,
        recentCap: DIAL_HUD_RECENT_CAP,
    });
    expect(composition.slots).toHaveLength(DIAL_HUD_CAP);
    const sources = composition.slots.map((slot) => slot.source);
    expect(sources[0]).toBe("current");
    expect(sources.filter((source) => source === "recent")).toHaveLength(5);
    // One current plus five recents leaves four rows, which the pool takes.
    expect(sources.filter((source) => source === "pool")).toHaveLength(4);
    expect(composition.overflow).toBeGreaterThan(0);
});

test("a recent that is already a pool model does not spend two rows", () => {
    const shared = { provider: "openrouter", model: "shared" };
    const composition = composeDialStrip({
        current: { provider: "openrouter", model: "on-now" },
        recents: [shared],
        pool: [{
            provider: "openrouter",
            model: "shared",
            levels: ["high"],
            available: true,
        }],
        includePool: true,
        cap: DIAL_HUD_CAP,
        recentCap: DIAL_HUD_RECENT_CAP,
    });
    expect(
        composition.slots.filter((slot) => slot.pair?.model === "shared"),
    ).toHaveLength(1);
});

test("one model at several efforts spends one recent row, not several", () => {
    const recents = ["low", "medium", "high"].map((effort) => ({
        provider: "openrouter",
        model: "moonshotai/kimi-k3",
        effort,
    }));
    const pool = Array.from({ length: 8 }, (_, index) => ({
        provider: "openrouter",
        model: `pooled-${index}`,
        levels: ["high"],
        available: true,
    }));
    const composition = composeDialStrip({
        current: { provider: "openrouter", model: "on-now" },
        recents,
        pool,
        includePool: true,
        cap: DIAL_HUD_CAP,
        recentCap: DIAL_HUD_RECENT_CAP,
    });
    const kimi = composition.slots.filter((slot) =>
        slot.pair?.model === "moonshotai/kimi-k3"
    );
    expect(kimi).toHaveLength(1);
    // The four rows the repeats would have taken go back to the pool.
    expect(composition.slots.filter((slot) => slot.source === "pool"))
        .toHaveLength(8);
});

test("a recent at a different effort than the current model is not a row", () => {
    const composition = composeDialStrip({
        current: { provider: "openrouter", model: "kimi", effort: "high" },
        recents: [{ provider: "openrouter", model: "kimi", effort: "low" }],
        pool: [],
        includePool: true,
        cap: DIAL_HUD_CAP,
        recentCap: DIAL_HUD_RECENT_CAP,
    });
    expect(composition.slots).toHaveLength(1);
    expect(composition.slots[0]?.source).toBe("current");
});

const SCALE_POOL: readonly DialPoolEntry[] = [
    {
        provider: "openai-codex",
        model: "gpt-5.6-sol",
        poolName: "sol",
        levels: ["low", "medium", "high"],
        defaultLevel: "medium",
    },
    { provider: "zai", model: "glm-5", poolName: "luna", levels: ["low", "high"] },
    { provider: "ollama", model: "qwen3:32b", levels: [] },
];

const PLAIN_SOL = { provider: "openai-codex", model: "gpt-5.6-sol" };
const QWEN = { provider: "ollama", model: "qwen3:32b" };

/** The strip as a reader sees it, with the styling sentinels taken out. */
function dialText(
    state: DialStripState,
    width = 80,
): readonly string[] {
    return renderDialStrip(state, "hints", width).map((line) =>
        line
            .split(DIAL_PROVIDER_SEPARATOR).join("")
            .split(DIAL_DEFAULT_SEPARATOR).join("")
            .split(DIAL_EXIT_SEPARATOR).join("")
    );
}

function scaleStrip(
    current: DialPair,
    recents: readonly DialPair[] = [LUNA],
): DialStripState {
    return openDialStrip(
        composeDialStrip({ current, recents, pool: SCALE_POOL }),
        current,
        {
            agents: ["default", "reviewer"],
            currentAgent: "default",
            permissionModes: ["readonly", "ask", "auto"],
            currentPermission: "ask",
        },
    );
}















test("arrows walk the rungs in the order they are drawn", () => {
    // Read off the screen rather than restated here: a rung that moves on
    // screen without moving in the walk is the failure this catches.
    const drawn = dialText(scaleStrip(PLAIN_SOL))
        .map((line) => /^[\u203a ] (EFFORT|ACCESS|MODEL|AGENT)/.exec(line)?.[1])
        .filter((label): label is string => label !== undefined)
        .map((label) => label.toLowerCase() as DialLane);
    const walked = drawn.map((_, step) => moveDialLane(scaleStrip(PLAIN_SOL), step).lane);
    expect(walked).toEqual(drawn);
    expect(drawn).toEqual(["effort", "access", "model", "agent"]);
});

// The axis is labelled faster on the left and smarter on the right, so the
// smart end can never be one of the words that means less thinking.
test("the smarter end of the effort axis is never a weak level", () => {
    const pair = { provider: "openrouter", model: "m" };
    const weak = ["off", "none", "minimal", "low"];
    const lists = [
        ["high", "medium", "low"],
        ["low", "medium", "high"],
        ["max", "xhigh", "high", "medium", "low", "minimal"],
        ["ultra", "max", "high", "medium", "low"],
        ["ludicrous", "high", "medium", "low"],
    ];
    for (const levels of lists) {
        const strip = composeDialStrip({
            current: pair,
            recents: [],
            pool: [{ provider: "openrouter", model: "m", levels }],
        });
        const efforts = strip.slots[0]?.efforts ?? [];
        expect(weak).not.toContain(efforts.at(-1) as string);
    }
});

function press(state: DialStripState, name: string): DialStripState {
    const action = handleDialStripKey(state, { name }, undefined);
    expect(action.kind).toBe("state");
    if (action.kind !== "state") throw new Error("expected staged state");
    return action.state;
}

test("arrows stage all lanes and Enter commits them together; Escape commits nothing", () => {
    const original = openDialStrip(composeDialStrip({ current: SOL, recents: [],
        pool: POOL, includePool: true }), SOL, {
        permissionModes: ["ask", "auto"], currentPermission: "ask",
        agents: ["default", "reviewer"], currentAgent: "default",
    });
    let state = press(original, "right");
    expect(dialStripSelection(state)?.effort).toBe("medium");
    state = press(press(state, "down"), "right");
    state = press(press(state, "down"), "right");
    expect(state.lane).toBe("model");
    expect(dialStripSelection(state)?.model).toBe("glm-5");
    state = press(press(state, "down"), "right");
    expect(handleDialStripKey(state, { name: "enter" }, undefined)).toEqual({
        kind: "commit", pair: { provider: "zai", model: "glm-5" },
        permission: "auto", agent: "reviewer",
    });
    expect(handleDialStripKey(state, { name: "escape" }, undefined)).toEqual({ kind: "cancel" });
    expect(dialStripSelection(original)).toEqual(SOL);
    expect(original.permissionModes[original.permissionIndex]).toBe("ask");
});

test("only arrows move; model stepping wraps through a shortlist larger than ten", () => {
    const pool = Array.from({ length: 15 }, (_, index) => ({
        provider: "test", model: `model-${index}`, levels: [],
    }));
    let state = openDialStrip(composeDialStrip({ current: undefined, recents: [],
        pool, includePool: true, cap: Infinity }), undefined);
    state = press(press(state, "down"), "down");
    for (let i = 0; i < 15; i += 1) state = press(state, "right");
    expect(state.index).toBe(0);
    state = press(state, "left");
    expect(state.index).toBe(14);
    for (const name of ["tab", "h", "j", "k", "l", "1", "m"]) {
        expect(handleDialStripKey(state, { name }, undefined)).toEqual({ kind: "ignore" });
    }
    const lines = renderDialStrip(state, "", 60);
    expect(lines).toHaveLength(5);
    expect(lines[2]).toContain("‹ model-14 ›");
    expect(lines[2]).toMatch(/\+\d+/);
    expect(lines.slice(0, 4).filter((line) => line.startsWith("› "))).toHaveLength(1);
});

test("pending values appear beside live values", () => {
    const state = openDialStrip(composeDialStrip({ current: SOL, recents: [], pool: POOL }), SOL);
    expect(renderDialStrip(press(state, "right"), "", 90)[0])
        .toContain("‹ medium › high  live: low");
});

test("unavailable models and access values are marked and skipped", () => {
    const pool = [POOL[0]!, { ...POOL[1]!, available: false }, POOL[2]!];
    let state = openDialStrip(composeDialStrip({ current: SOL, recents: [], pool, includePool: true }), SOL, {
        permissionModes: ["ask", "auto", "full_access"], currentPermission: "auto", disabledPermissionModes: ["full_access"],
    });
    state = moveDialStrip(state, 1);
    expect(dialStripSelection(state)?.model).toBe("qwen3:32b");
    const action = handleDialStripKey({ ...state, lane: "access" }, { name: "right" }, undefined);
    expect(action.kind === "state" && action.state.permissionModes[action.state.permissionIndex]).toBe("ask");
    expect(renderDialStrip(state, "").join("\n")).toContain("full (off)");
});

test("an empty model lane still applies staged access", () => {
    const empty = openDialStrip(composeDialStrip({ current: undefined, recents: [], pool: [], includePool: true }), undefined, {
        permissionModes: ["ask", "auto"], currentPermission: "ask",
    });
    const moved = handleDialStripKey({ ...empty, lane: "access" }, { name: "right" }, undefined);
    expect(moved.kind).toBe("state");
    if (moved.kind !== "state") return;
    expect(handleDialStripKey(moved.state, { name: "enter" }, undefined)).toEqual({
        kind: "commit", pair: undefined, permission: "auto",
    });
});

test("agent changes skip disabled postures and agents without permitted access", () => {
    const original = openDialStrip(composeDialStrip({ current: SOL, recents: [], pool: POOL }), SOL, {
        agents: ["default", "restricted", "blocked"], currentAgent: "default",
        agentPostures: { restricted: "full_access" },
        agentForbiddenAccess: { restricted: ["auto"], blocked: ["ask", "auto"] },
        permissionModes: ["ask", "auto", "full_access"], currentPermission: "auto", disabledPermissionModes: ["full_access"],
    });
    const staged = press({ ...original, lane: "agent" }, "right");
    expect(staged.agents[staged.agentIndex]).toBe("restricted");
    expect(staged.permissionModes[staged.permissionIndex]).toBe("ask");
    expect(handleDialStripKey(staged, { name: "enter" }, undefined)).toEqual({
        kind: "commit", pair: SOL, agent: "restricted", permission: "ask",
    });
    expect(press(staged, "right").agentIndex).toBe(0);
    expect(handleDialStripKey({ ...staged, permissionIndex: 2 }, { name: "enter" }, undefined)).toEqual({ kind: "ignore" });
});
