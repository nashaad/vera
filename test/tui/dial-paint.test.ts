import { expect, test } from "bun:test";
import {
    adjustDialEffort,
    composeDialStrip,
    DIAL_DEFAULT_SEPARATOR,
    DIAL_PROVIDER_SEPARATOR,
    type DialLane,
    type DialPoolEntry,
    type DialStripState,
    moveDialLane,
    openDialStrip,
    renderDialStrip,
} from "../../clients/tui/dials.ts";
import {
    type DialPaintTheme,
    type DialSpan,
    mapDialRows,
    paintDialHud,
} from "../../clients/tui/dial-paint.ts";
import { mixHex } from "../../clients/tui/theme.ts";

const THEME: DialPaintTheme = {
    text: "#ffffff",
    muted: "#666666",
    accent: "#00aaff",
    notice: "#ffaa00",
    background: "#000000",
    success: "#00ff00",
};
/** What a chosen value looks like on a rung the cursor has left. */
const settled = (hex: string): string => mixHex(THEME.background, hex, 0.45);

const POOL: readonly DialPoolEntry[] = [
    {
        provider: "openai-codex",
        model: "gpt-5.6-sol",
        poolName: "sol",
        levels: ["low", "medium", "high"],
        defaultLevel: "medium",
    },
    {
        provider: "zai",
        model: "glm-5",
        poolName: "luna",
        levels: ["low", "high"],
    },
];
const SOL = { provider: "openai-codex", model: "gpt-5.6-sol" };
const LUNA = { provider: "zai", model: "glm-5" };

function opened(permission = "ask"): DialStripState {
    return openDialStrip(
        composeDialStrip({ current: SOL, recents: [LUNA], pool: POOL }),
        SOL,
        {
            agents: ["default", "reviewer"],
            currentAgent: "default",
            permissionModes: ["readonly", "ask", "auto"],
            currentPermission: permission,
        },
    );
}

/** The HUD with a given rung focused, reached the way tab reaches it. */
function strip(lane: DialLane): DialStripState {
    let state = opened();
    while (state.lane !== lane) state = moveDialLane(state, 1);
    return state;
}

const rowsOf = (state: DialStripState, width = 80): readonly string[] =>
    renderDialStrip(state, "hints", width).slice(0, -1);

const paint = (state: DialStripState, width = 80) =>
    paintDialHud(rowsOf(state, width), state.lane, THEME);

/** The colour of the first span whose text opens with `startsWith`. */
function colorOf(
    painted: readonly (readonly DialSpan[])[],
    startsWith: string,
): string | undefined {
    for (const row of painted) {
        for (const span of row) {
            if (span.text.trimStart().startsWith(startsWith)) return span.color;
        }
    }
    return undefined;
}

/** Every rung's label and whether it is lit, as one readable map. */
function laneWeights(lane: DialLane): Record<string, string> {
    const state = strip(lane);
    const rows = rowsOf(state);
    const painted = paintDialHud(rows, lane, THEME);
    const weights: Record<string, string> = {};
    for (const [index, row] of rows.entries()) {
        const label = /^[› ] (EFFORT|ACCESS|MODEL|AGENT)/.exec(row)?.[1];
        if (label === undefined) continue;
        weights[label] = painted[index]?.[0]?.color === THEME.text
            ? "bright"
            : "muted";
    }
    return weights;
}

test("only the focused rung's label is lit", () => {
    expect(laneWeights("effort")).toEqual({
        EFFORT: "bright",
        ACCESS: "muted",
        MODEL: "muted",
        AGENT: "muted",
    });
    expect(laneWeights("access")).toEqual({
        EFFORT: "muted",
        ACCESS: "bright",
        MODEL: "muted",
        AGENT: "muted",
    });
    expect(laneWeights("model")).toEqual({
        EFFORT: "muted",
        ACCESS: "muted",
        MODEL: "bright",
        AGENT: "muted",
    });
    expect(laneWeights("agent")).toEqual({
        EFFORT: "muted",
        ACCESS: "muted",
        MODEL: "muted",
        AGENT: "bright",
    });
});

/** The colour of a span on one named rung, ignoring the rest of the HUD. */
function colorOnAgentRow(
    state: DialStripState,
    startsWith: string,
): string | undefined {
    const rows = rowsOf(state);
    const row = paintDialHud(rows, state.lane, THEME)[mapDialRows(rows).agent];
    return row?.find((span) => span.text.trimStart().startsWith(startsWith))
        ?.color;
}

test("a chosen value on an unfocused rung sits between lit and muted", () => {
    // The agent rung holds "default" either way: focused it is full text,
    // left behind it settles, and it never drops to the unchosen weight.
    expect(colorOnAgentRow(strip("agent"), "[default]")).toBe(THEME.text);
    const away = colorOnAgentRow(strip("model"), "[default]");
    expect(away).toBe(settled(THEME.text));
    expect(away).not.toBe(THEME.muted);
});

test("unchosen values stay muted even on the focused rung", () => {
    expect(colorOnAgentRow(strip("agent"), "reviewer")).toBe(THEME.muted);
});

test("access modes keep their hue when the cursor is elsewhere", () => {
    expect(colorOf(paint(strip("access")), "[ask]")).toBe(THEME.accent);
    expect(colorOf(paint(strip("model")), "[ask]")).toBe(settled(THEME.accent));
});

test("each access mode gets its own colour", () => {
    const modeColor = (mode: string): string | undefined => {
        let state = opened(mode);
        while (state.lane !== "access") state = moveDialLane(state, 1);
        return colorOf(paint(state), `[${mode}]`);
    };
    expect(modeColor("readonly")).toBe("#c586c0");
    expect(modeColor("ask")).toBe(THEME.accent);
    expect(modeColor("auto")).toBe(THEME.success);
});

test("the effort track lights only while the effort rung is focused", () => {
    expect(colorOf(paint(strip("effort")), "──")).toBe(THEME.accent);
    expect(colorOf(paint(strip("model")), "──")).toBe(THEME.muted);
});

test("the resolved-default marker keeps its notice colour, settled when away", () => {
    expect(colorOf(paint(strip("effort")), "▲")).toBe(THEME.notice);
    expect(colorOf(paint(strip("model")), "▲")).toBe(settled(THEME.notice));
});

test("the whole effort block counts as one rung", () => {
    const rows = rowsOf(strip("effort"));
    const map = mapDialRows(rows);
    expect(map.effortScaleRows).toBe(2);
    const painted = paintDialHud(rows, "effort", THEME);
    // The axis caption a row above EFFORT belongs to the focused rung, and the
    // level labels a row below it do too.
    for (const row of [map.effort - 1, map.effort + 1]) {
        expect(painted[row]?.some((span) => span.color === THEME.accent))
            .toBe(true);
    }
});

test("stepping the effort dial keeps the levels on the track colour", () => {
    const painted = paint(adjustDialEffort(strip("effort"), 1));
    expect(colorOf(painted, "low")).toBe(THEME.accent);
});

test("every span carries a colour the theme names", () => {
    const known = new Set<string>([
        ...Object.values(THEME),
        "#c586c0",
        ...[THEME.text, THEME.accent, THEME.notice, THEME.success, "#c586c0"]
            .map(settled),
    ]);
    for (const lane of ["effort", "access", "model", "agent"] as const) {
        for (const row of paint(strip(lane))) {
            for (const span of row) expect([...known]).toContain(span.color);
        }
    }
});

test("painting covers every row and drops none of its text", () => {
    const sentinels = new RegExp(
        `[${DIAL_PROVIDER_SEPARATOR}${DIAL_DEFAULT_SEPARATOR}]`,
        "g",
    );
    for (const lane of ["effort", "access", "model", "agent"] as const) {
        for (const width of [80, 50, 40]) {
            const rows = rowsOf(strip(lane), width);
            const painted = paintDialHud(rows, lane, THEME);
            expect(painted).toHaveLength(rows.length);
            for (const [index, row] of painted.entries()) {
                expect(row.map((span) => span.text).join("")).toBe(
                    rows[index]!.replace(sentinels, ""),
                );
            }
        }
    }
});
