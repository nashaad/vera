import { expect, test } from "bun:test";
import {
    adjustDialEffort,
    composeDialStrip,
    DIAL_HUD_CAP,
    DIAL_HUD_RECENT_CAP,
    dialStripSelection,
    handleDialStripKey,
    jumpDialStrip,
    moveDialStrip,
    openDialStrip,
    renderEffortScale,
    renderDialStrip,
    type DialPoolEntry,
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

test("the strip caps at six and says how many it did not show", () => {
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
        .toContain("…");
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
    expect(lines.at(-1)?.replace("\u001e", "")).toEndWith("esc close");
    expect(lines.join("\n")).toContain("qwen3:32b");
    expect(lines.join("\n")).not.toContain("openai-codex");
    expect(lines.join("\n")).toContain("[reviewer]");
    expect(lines.join("\n")).not.toContain("full access");
    expect(lines.join("\n")).toContain("EFFORT");
    expect(lines.join("\n")).toContain("AGENT");
    expect(lines.join("\n")).toContain("ACCESS");
    const compact = renderDialStrip(openDialStrip(composition, SOL), "hints", 36);
    expect(compact.join("\n")).not.toContain("MODEL");
    expect(compact.join("\n")).not.toContain("EFFORT");
    expect(compact.at(-1)).toContain("↑/↓ · ←/→");
    const wide = renderDialStrip(
        openDialStrip(composition, SOL),
        "hints",
        90,
    );
    expect(wide.join("\n")).toContain("RECENTLY USED");
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

test("the model lane names where each choice came from", () => {
    const composition = composeDialStrip({
        current: SOL,
        recents: [{ provider: "ollama", model: "qwen3:32b" }],
        pool: POOL,
        includePool: true,
    });
    const lines = renderDialStrip(openDialStrip(composition, SOL), "hints");
    const modelList = lines.join("\n");
    expect(modelList).toContain("● 1 sol");
    expect(modelList).toContain("↺ 2 qwen3:32b");
    expect(modelList).toContain("· 3 luna");
    expect(lines.at(-1)).toContain("● current · ↺ recent · · pool");
});

test("moving sideways discards an uncommitted effort edit", () => {
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
    // Back where it started, and the edit did not follow.
    expect(dialStripSelection(state)?.effort).toBe("low");
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
    expect(renderDialStrip(state, "hints").at(-1)).toContain("no effort dial");
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

test("tab changes HUD lanes and horizontal arrows change that lane", () => {
    const composition = composeDialStrip({
        current: SOL,
        recents: [],
        pool: POOL,
    });
    let state = openDialStrip(composition, SOL, {
        agents: ["default", "reviewer"],
        currentAgent: "default",
        permissionModes: ["readonly", "ask", "auto"],
        currentPermission: "ask",
    });
    const higherEffort = handleDialStripKey(
        state,
        { name: "right" },
        "dials.pair.next",
    );
    expect(higherEffort.kind).toBe("state");
    if (higherEffort.kind !== "state") return;
    state = higherEffort.state;
    expect(dialStripSelection(state)?.effort).toBe("medium");
    const agentLane = handleDialStripKey(state, { name: "tab" }, undefined);
    expect(agentLane.kind).toBe("state");
    if (agentLane.kind !== "state") return;
    state = agentLane.state;
    expect(state.lane).toBe("agent");
    const agentFrame = renderDialStrip(state, "hints", 90);
    expect(agentFrame).toHaveLength(renderDialStrip(
        higherEffort.state,
        "hints",
        90,
    ).length);
    expect(agentFrame.join("\n")).toContain("  MODEL");
    expect(agentFrame.join("\n")).toContain("› AGENT");
    const nextAgent = handleDialStripKey(
        state,
        { name: "right" },
        "dials.pair.next",
    );
    expect(nextAgent.kind).toBe("state");
    if (nextAgent.kind !== "state") return;
    state = nextAgent.state;
    expect(state.agents[state.agentIndex]).toBe("reviewer");
    const modelAgain = handleDialStripKey(
        state,
        { name: "tab", shift: true },
        undefined,
    );
    expect(modelAgain.kind === "state" && modelAgain.state.lane).toBe("model");
});

test("up and down move the vertical model list", () => {
    const composition = composeDialStrip({
        current: SOL,
        recents: [LUNA],
        pool: POOL,
    });
    let state = openDialStrip(composition, SOL);
    const down = handleDialStripKey(
        state,
        { name: "down" },
        "dials.effort.down",
    );
    expect(down.kind).toBe("state");
    if (down.kind !== "state") return;
    state = down.state;
    expect(dialStripSelection(state)).toEqual(LUNA);
    expect(state.index).toBe(1);
    const wrapped = handleDialStripKey(
        state,
        { name: "j" },
        undefined,
    );
    expect(wrapped.kind === "state" && wrapped.state.index).toBe(0);
    const upWrapped = handleDialStripKey(
        wrapped.kind === "state" ? wrapped.state : state,
        { name: "k" },
        undefined,
    );
    expect(upWrapped.kind === "state" && upWrapped.state.index).toBe(1);
});

test("the HUD is modal and h/l mirror horizontal arrows", () => {
    const composition = composeDialStrip({
        current: SOL,
        recents: [],
        pool: POOL,
    });
    let state = openDialStrip(composition, SOL);
    const right = handleDialStripKey(state, { name: "l" }, undefined);
    expect(right.kind).toBe("state");
    if (right.kind !== "state") return;
    state = right.state;
    expect(dialStripSelection(state)?.effort).toBe("medium");
    const left = handleDialStripKey(state, { name: "h" }, undefined);
    expect(left.kind).toBe("state");
    if (left.kind !== "state") return;
    expect(dialStripSelection(left.state)?.effort).toBe("low");
    expect(handleDialStripKey(state, { name: "x", sequence: "x" }, undefined))
        .toEqual({ kind: "ignore" });
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
        .toContain("auto unavailable — plan is readonly");

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
    expect(composition.slots[0]?.efforts).toEqual(["high", "medium", "low"]);
    expect(renderDialStrip(state, "hints").join("\n")).not.toContain(
        "not available",
    );
    state = adjustDialEffort(state, 1);
    expect(dialStripSelection(state)?.effort).toBe("high");
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
