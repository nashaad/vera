import { expect, test } from "bun:test";
import {
    adjustDialEffort,
    composeDialStrip,
    DIAL_DEFAULT_SEPARATOR,
    DIAL_PROVIDER_SEPARATOR,
    dialEffortPending,
    type DialLane,
    type DialPoolEntry,
    type DialStripState,
    moveDialLane,
    openDialStrip,
    renderDialStrip,
} from "../../clients/tui/dials.ts";
import {
    autoModeEdgeIntensity,
    type DialPaintTheme,
    type DialSpan,
    mapDialRows,
    paintDialHud,
} from "../../clients/tui/dial-paint.ts";
import { mixHex, VERA_TUI_THEME } from "../../clients/tui/theme.ts";

const THEME: DialPaintTheme = {
    text: "#ffffff",
    muted: "#666666",
    accent: "#00aaff",
    notice: "#ffaa00",
    background: "#000000",
    success: "#00ff00",
    secondary: "#c586c0",
    accessAsk: "#0066ff",
    accessAuto: "#00cc66",
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
    paintDialHud(rowsOf(state, width), state.lane, THEME, {
        effortPending: dialEffortPending(state),
    });

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

function spanOf(
    painted: readonly (readonly DialSpan[])[],
    startsWith: string,
): DialSpan | undefined {
    for (const row of painted) {
        for (const span of row) {
            if (span.text.trimStart().startsWith(startsWith)) return span;
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

/** The model cell under the cursor, including its optional selection fill. */
function cursorRowSpan(state: DialStripState): DialSpan | undefined {
    const rows = rowsOf(state);
    const map = mapDialRows(rows);
    const painted = paintDialHud(rows, state.lane, THEME);
    const end = map.modelEnd < 0 ? rows.length : map.modelEnd;
    for (let index = map.modelStart; index < end; index += 1) {
        if (!(rows[index] ?? "").includes("\u203a", 2)) continue;
        return painted[index]?.find((span) => span.text.includes("sol"));
    }
    return undefined;
}

test("the active model cursor uses the normal filled selection row", () => {
    expect(cursorRowSpan(strip("model"))).toMatchObject({
        color: THEME.background,
        background: THEME.accent,
    });
    expect(cursorRowSpan(strip("agent"))).toEqual(expect.objectContaining({
        color: settled(THEME.text),
    }));
    expect(cursorRowSpan(strip("agent"))?.background).toBeUndefined();
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
    expect(colorOnAgentRow(strip("agent"), "default")).toBe(THEME.background);
    const away = colorOnAgentRow(strip("model"), "default");
    expect(away).toBe(settled(THEME.text));
    expect(away).not.toBe(THEME.muted);
});

test("unchosen values stay muted even on the focused rung", () => {
    expect(colorOnAgentRow(strip("agent"), "reviewer")).toBe(THEME.muted);
});

test("access modes keep their hue when the cursor is elsewhere", () => {
    expect(spanOf(paint(strip("access")), "›ask")).toMatchObject({
        color: THEME.background,
        background: THEME.accessAsk,
    });
    expect(colorOf(paint(strip("model")), "›ask")).toBe(
        settled(THEME.accessAsk),
    );
});

test("each active access mode fills with its own colour", () => {
    const modeSpan = (mode: string): DialSpan | undefined => {
        let state = opened(mode);
        while (state.lane !== "access") state = moveDialLane(state, 1);
        return spanOf(paint(state), `›${mode}`);
    };
    expect(modeSpan("readonly")).toMatchObject({
        color: THEME.background,
        background: THEME.secondary,
    });
    expect(modeSpan("ask")).toMatchObject({
        color: THEME.background,
        background: THEME.accessAsk,
    });
    expect(modeSpan("auto")).toMatchObject({
        color: THEME.background,
        background: THEME.accessAuto,
    });

    const veraPaint = (state: DialStripState) =>
        paintDialHud(rowsOf(state), state.lane, {
            text: VERA_TUI_THEME.text,
            muted: VERA_TUI_THEME.muted,
            accent: VERA_TUI_THEME.accent,
            notice: VERA_TUI_THEME.notice,
            background: VERA_TUI_THEME.background,
            success: VERA_TUI_THEME.success,
            secondary: VERA_TUI_THEME.secondary,
            accessAsk: VERA_TUI_THEME.accent,
            accessAuto: VERA_TUI_THEME.hud?.auto
                ?? VERA_TUI_THEME.success,
        });
    let veraState = opened("auto");
    while (veraState.lane !== "access") veraState = moveDialLane(veraState, 1);
    expect(spanOf(veraPaint(veraState), "›auto")?.background).toBe("#40C977");
});

test("entering auto draws a tracer only on the HUD's right edge", () => {
    const state = strip("access");
    const rows = rowsOf(state, 60);
    const painted = paintDialHud(rows, state.lane, THEME, {
        autoAnimation: { progress: 0.55, width: 60 },
    });
    const litRows = painted.filter((row) =>
        row.at(-1)?.background !== undefined
    );

    expect(litRows.length).toBeGreaterThan(1);
    expect(litRows.length).toBeLessThanOrEqual(7);
    for (const row of litRows) {
        expect(row.map((span) => span.text).join("")).toHaveLength(60);
        expect(row.at(-1)?.text).toBe(" ");
    }
    expect(painted.flatMap((row) => row).map((span) => span.text).join(""))
        .not.toContain("AUTO");
    expect(painted).toHaveLength(rows.length);
});

test("the auto tracer moves vertically instead of filling a row", () => {
    const peakRow = (progress: number): number => {
        const values = Array.from(
            { length: 20 },
            (_, row) => autoModeEdgeIntensity(progress, row, 20),
        );
        return values.indexOf(Math.max(...values));
    };

    expect(peakRow(0.35)).toBeLessThan(peakRow(0.7));
    expect(autoModeEdgeIntensity(1, 19, 20)).toBe(0);
});

test("the auto tracer survives adversarial widths and progress values", () => {
    const state = strip("access");
    const sentinels = new RegExp(
        `[${DIAL_PROVIDER_SEPARATOR}${DIAL_DEFAULT_SEPARATOR}]`,
        "g",
    );
    const color = /^#[0-9a-f]{6}$/i;
    for (const width of [1, 2, 8, 20, 40, 60, 120]) {
        const rows = rowsOf(state, width);
        const plain = rows.map((row) => row.replace(sentinels, "").replace(/(AGENT\s*)›/, "$1 "));
        for (
            const progress of [
                -1,
                0,
                0.001,
                0.25,
                0.5,
                0.88,
                0.999,
                1,
                2,
                Number.NaN,
                Number.POSITIVE_INFINITY,
            ]
        ) {
            const painted = paintDialHud(rows, state.lane, THEME, {
                autoAnimation: { progress, width },
            });
            expect(painted).toHaveLength(rows.length);
            for (const [index, spans] of painted.entries()) {
                const text = spans.map((span) => span.text).join("");
                expect(text.startsWith(plain[index] ?? "")).toBe(true);
                expect(text.length).toBeLessThanOrEqual(
                    Math.max(width, plain[index]?.length ?? 0),
                );
                expect(text).not.toContain("AUTO");
                for (const span of spans) {
                    expect(span.color).toMatch(color);
                    if (span.background !== undefined) {
                        expect(span.background).toMatch(color);
                    }
                }
            }
        }
    }
});

test("invalid tracer geometry is inert", () => {
    for (
        const [progress, row, rowCount] of [
            [Number.NaN, 0, 10],
            [0.5, Number.NaN, 10],
            [0.5, -1, 10],
            [0.5, 10, 10],
            [0.5, 0, 0],
            [0.5, 0, Number.POSITIVE_INFINITY],
        ]
    ) {
        expect(autoModeEdgeIntensity(progress!, row!, rowCount!)).toBe(0);
    }

    const state = strip("access");
    const rows = rowsOf(state, 60);
    expect(() =>
        paintDialHud(rows, state.lane, THEME, {
            autoAnimation: { progress: 0.5, width: Number.POSITIVE_INFINITY },
        })
    ).not.toThrow();
});











test("every span carries a colour the theme names", () => {
    const known = new Set<string>([
        ...Object.values(THEME),
        ...[
            THEME.text,
            THEME.accent,
            THEME.notice,
            THEME.success,
            THEME.secondary,
            THEME.accessAsk,
            THEME.accessAuto,
        ]
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
                    rows[index]!.replace(sentinels, "").replace(/(AGENT\s*)›/, "$1 "),
                );
            }
        }
    }
});

test("four lanes retain exactly one filled cursor, including when effort is pending", () => {
    const state = moveDialLane(adjustDialEffort(strip("effort"), 1), 2);
    const painted = paint(state);
    expect(painted).toHaveLength(rowsOf(state).length);
    expect(painted.flat().filter((span) => span.background !== undefined)).toHaveLength(1);
    expect(mapDialRows(rowsOf(state)).effortScaleRows).toBe(2);
    expect(rowsOf(state)[0]).toContain("live: default");
});
