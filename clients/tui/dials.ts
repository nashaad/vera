/**
 * The dial strip: model × effort, flipped from one visible line.
 *
 * Replaces quickslots, and the difference is the point. A quickslot was a
 * numbered box you cycled blind; a dial is a pair you can see before you take
 * it. Nothing here changes state on its own — the strip only ever proposes,
 * and Enter is the only thing that commits.
 *
 * Everything in this file is pure. The strip's whole behaviour is a function
 * from a snapshot and a keypress to the next snapshot, which is what makes it
 * testable without a terminal.
 */

import { isTuiDialTabKey } from "./keymap.ts";

/** A model with the effort it runs at, when the model has an effort dial. */
export interface DialPair {
    readonly provider?: string;
    readonly model: string;
    /** Absent when the model publishes no levels at all. Its own value. */
    readonly effort?: string;
}

/** What the strip needs to know about one model the user has admitted. */
export interface DialPoolEntry {
    readonly provider: string;
    readonly model: string;
    readonly poolName?: string;
    readonly levels: readonly string[];
    /** The level the model runs at when no effort is chosen, when it says. */
    readonly defaultLevel?: string;
    /**
     * False on an entry that cannot run right now. Such an entry states no
     * levels, so it must not stand in for the catalog's.
     */
    readonly available?: boolean;
}

/** Internal separator: the TUI paints the provider suffix in a quieter tone. */
export const DIAL_PROVIDER_SEPARATOR = "\u001f";

/**
 * Marks the default chip that sits in the gutter beside the effort track.
 *
 * Default is not a point on the Faster/Smarter axis, it is the choice to let
 * the model decide, so it is painted in its own colour rather than reading as
 * one more stop on the line.
 */
export const DIAL_DEFAULT_SEPARATOR = "\u001d";
/** Internal separator for the independently styled, right-aligned exit cue. */
export const DIAL_EXIT_SEPARATOR = "\u001e";

export type DialSlotSource = "current" | "recent" | "pool";

export interface DialSlot {
    /** The pool name when present, otherwise a shortened model id. */
    readonly label: string;
    /** The model/provider pair this row selects. */
    readonly pair?: DialPair;
    readonly source: DialSlotSource;
    /** The levels this model publishes, empty when it has no effort dial. */
    readonly efforts: readonly string[];
    /** What choosing default resolves to, when the model says. */
    readonly defaultEffort?: string;
    /** Why it cannot be selected, when it cannot. */
    readonly unavailable?: "not in your pool";
}

export interface DialStripComposition {
    readonly slots: readonly DialSlot[];
    /** The three most recently used pairs, newest first, for the HUD shortcut. */
    readonly recent: readonly DialSlot[];
    /** Slots beyond the cap, shown as a trailing ellipsis rather than dropped. */
    readonly overflow: number;
}

/** How many slots fit on one line before the rest become an ellipsis. */
export const DIAL_STRIP_CAP = 6;

/**
 * How many rows the HUD offers, and how many of them recents may take.
 *
 * Five and five is a shape, not a promise. Recents are usually pool models
 * too, and a row is only ever shown once, so the pool backfills whatever the
 * recents did not use. Guaranteeing a true 5+5 would mean printing one model
 * on two rows under two digits, which is worse than a floating split.
 */
export const DIAL_HUD_CAP = 10;
export const DIAL_HUD_RECENT_CAP = 5;

function pairOf(entry: DialPoolEntry, effort: string | undefined): DialPair {
    return {
        provider: entry.provider,
        model: entry.model,
        ...(effort === undefined ? {} : { effort }),
    };
}

/**
 * The strip, in order.
 *
 * Position 1 is always the pair the session is committed to, by construction,
 * so "the pair I am on is not in the list" cannot happen. Favourites follow in
 * the order they were written, then recents newest first, and a pair already
 * shown is not shown twice.
 */
export function composeDialStrip(options: {
    readonly current: DialPair | undefined;
    /** The session's model settings over time, oldest first. */
    readonly recents: readonly DialPair[];
    readonly pool: readonly DialPoolEntry[];
    /**
     * Level facts for models the pool has no ready entry for. Facts only: a
     * catalog entry never becomes a row on the strip.
     */
    readonly catalog?: readonly DialPoolEntry[];
    readonly cap?: number;
    /** How many recents may take rows before the pool backfills the rest. */
    readonly recentCap?: number;
    readonly includePool?: boolean;
}): DialStripComposition {
    const cap = options.cap ?? DIAL_STRIP_CAP;
    const recentCap = options.recentCap ?? Number.POSITIVE_INFINITY;
    const catalog = options.catalog ?? [];
    const slots: DialSlot[] = [];
    const seen = new Set<string>();

    if (options.current !== undefined) {
        slots.push(slotFor(options.current, "current", options.pool, catalog));
        seen.add(pairKey(options.current));
        seen.add(modelKey(options.current));
    }
    let recentRows = 0;
    for (const pair of [...options.recents].reverse()) {
        if (recentRows >= recentCap) break;
        // Recents dedupe on the model rather than the pair: one model turned
        // through three efforts is one model, and each row carries the whole
        // effort scale anyway. Keying on the pair would spend the recent rows
        // on a single model and leave nothing for the pool to backfill into.
        const key = modelKey(pair);
        if (seen.has(key)) continue;
        seen.add(key);
        seen.add(pairKey(pair));
        recentRows += 1;
        slots.push(slotFor(pair, "recent", options.pool, catalog));
    }
    if (options.includePool === true) {
        for (const entry of options.pool) {
            const pair = pairOf(entry, undefined);
            if (slots.some((slot) => slot.pair?.model === pair.model
                && slot.pair.provider === pair.provider)) continue;
            seen.add(pairKey(pair));
            slots.push(slotFor(pair, "pool", options.pool, catalog));
        }
    }
    const visible = slots.slice(0, cap);
    const recent: DialSlot[] = [];
    const recentSeen = new Set<string>();
    for (const pair of [...options.recents].reverse()) {
        const key = modelKey(pair);
        if (recentSeen.has(key)) continue;
        recentSeen.add(key);
        recent.push(slotFor(pair, "recent", options.pool, catalog));
        if (recent.length === 3) break;
    }
    return {
        slots: visible,
        recent,
        overflow: slots.length - visible.length,
    };
}

/** One model, whatever effort it is turned to. */
export function modelKey(pair: DialPair): string {
    return `${pair.provider ?? ""}/${pair.model}`;
}

/** Absent effort is its own value: a model with no dial has exactly one pair. */
export function pairKey(pair: DialPair): string {
    return `${pair.provider ?? ""}/${pair.model}/${pair.effort ?? ""}`;
}

function findEntry(
    pair: DialPair,
    entries: readonly DialPoolEntry[],
): DialPoolEntry | undefined {
    return entries.find((candidate) =>
        candidate.model === pair.model
        && (pair.provider === undefined || candidate.provider === pair.provider)
    );
}

/**
 * Where each ladder level sits on the faster-to-smarter axis, used only to
 * check that a list arrived the way its contract promises.
 */
const EFFORT_RANK: Readonly<Record<string, number>> = {
    off: 0,
    none: 0,
    minimal: 1,
    low: 2,
    medium: 3,
    high: 4,
    xhigh: 5,
    max: 6,
};

/**
 * The model's levels, faster first, which is the direction the track is
 * labelled in.
 *
 * Every level named: rank them, which repairs any order they arrive in.
 *
 * Otherwise the names cannot decide it, and `CatalogModel.levels` already
 * requires strongest first of every producer, so reversing that is the answer.
 * The rank check then acts as a guard rather than as the ordering: if the
 * levels that can be ranked come out running the wrong way, a producer broke
 * the contract and the list is flipped back. This keeps the axis honest
 * without knowing what an unrecognised level means, and leaves such a level
 * beside the neighbours the provider gave it, which is the only claim anyone
 * has made about where it belongs. Fewer than two rankable levels, or
 * rankable levels that do not run cleanly one way, say nothing, so the list
 * stands.
 */
function orderEfforts(levels: readonly string[]): readonly string[] {
    if (levels.every((level) => EFFORT_RANK[level] !== undefined)) {
        return [...levels].sort((a, b) =>
            (EFFORT_RANK[a] ?? 0) - (EFFORT_RANK[b] ?? 0)
        );
    }
    const ordered = [...levels].reverse();
    return runsBackwards(ordered) ? [...ordered].reverse() : ordered;
}

function runsBackwards(levels: readonly string[]): boolean {
    const ranks = levels
        .map((level) => EFFORT_RANK[level])
        .filter((rank): rank is number => rank !== undefined);
    if (ranks.length < 2) {
        return false;
    }
    let rising = 0;
    let falling = 0;
    for (let index = 1; index < ranks.length; index += 1) {
        const step = (ranks[index] as number) - (ranks[index - 1] as number);
        if (step > 0) rising += 1;
        if (step < 0) falling += 1;
    }
    return falling > 0 && rising === 0;
}

function slotFor(
    pair: DialPair,
    source: DialSlotSource,
    pool: readonly DialPoolEntry[],
    catalog: readonly DialPoolEntry[] = [],
): DialSlot {
    const entry = findEntry(pair, pool);
    // A ready entry answers on its own, empty list included: that is the pool
    // saying this model has no reasoning control. Only when no ready entry
    // exists does the catalog answer, which is the case for a model reached
    // by name that the pool never admitted.
    const ready = entry !== undefined && entry.available !== false;
    const facts = ready ? entry : findEntry(pair, catalog);
    return {
        label: entry?.poolName ?? shortModel(pair.model),
        pair,
        source,
        efforts: orderEfforts(facts?.levels ?? []),
        ...(facts?.defaultLevel === undefined
            ? {}
            : { defaultEffort: facts.defaultLevel }),
    };
}

function shortModel(model: string): string {
    return model.split("/").at(-1) ?? model;
}

export interface DialStripState {
    readonly slots: readonly DialSlot[];
    readonly overflow: number;
    readonly index: number;
    /**
     * The effort chosen on the highlighted row but not committed.
     *
     * Held for the highlighted row alone: moving sideways discards it, because
     * an edit that followed you along the strip would be a second, invisible
     * dial. Moving away discards the pending edit.
     */
    /** `null` means the explicit provider-default choice; absent means unedited. */
    readonly editedEffort?: string | null;
    /** The pair the strip opened with, which is what escape puts back. */
    readonly opened?: DialPair;
    readonly lane: DialLane;
    readonly agents: readonly string[];
    readonly agentIndex: number;
    readonly openedAgent?: string;
    readonly agentPostures: Readonly<Record<string, string>>;
    readonly agentForbiddenAccess: Readonly<Record<string, readonly string[]>>;
    readonly permissionModes: readonly string[];
    readonly permissionIndex: number;
    readonly openedPermission?: string;
    readonly permissionEdited?: boolean;
    readonly recent: readonly DialSlot[];
}

export function openDialStrip(
    composition: DialStripComposition,
    current: DialPair | undefined,
    options: {
        readonly agents?: readonly string[];
        readonly currentAgent?: string;
        readonly agentPostures?: Readonly<Record<string, string>>;
        readonly agentForbiddenAccess?: Readonly<
            Record<string, readonly string[]>
        >;
        readonly permissionModes?: readonly string[];
        readonly currentPermission?: string;
    } = {},
): DialStripState {
    const agents = options.agents ?? [];
    const permissionModes = options.permissionModes ?? [];
    return {
        slots: composition.slots,
        overflow: composition.overflow,
        index: 0,
        // The top rung, so tab walks down the HUD from where the eye starts
        // rather than entering the stack partway and wrapping.
        lane: "effort",
        agents,
        agentIndex: Math.max(0, agents.indexOf(options.currentAgent ?? "")),
        agentPostures: options.agentPostures ?? {},
        agentForbiddenAccess: options.agentForbiddenAccess ?? {},
        permissionModes,
        recent: composition.recent,
        permissionIndex: permissionModes.indexOf(options.currentPermission ?? ""),
        ...(current === undefined ? {} : { opened: current }),
        ...(options.currentAgent === undefined
            ? {}
            : { openedAgent: options.currentAgent }),
        ...(options.currentPermission === undefined
            ? {}
            : { openedPermission: options.currentPermission }),
    };
}

// Ordered the way the rungs are stacked on screen, so tab walks down the HUD
// rather than jumping around it.
/** The rungs of the HUD, one of which holds the focus. */
export type DialLane = "model" | "effort" | "agent" | "access";

const DIAL_LANES = ["effort", "access", "model", "agent"] as const;

export function moveDialLane(
    state: DialStripState,
    delta: number,
): DialStripState {
    const at = DIAL_LANES.indexOf(state.lane);
    const next = (at + delta + DIAL_LANES.length) % DIAL_LANES.length;
    return { ...state, lane: DIAL_LANES[next]! };
}

function moveChoice(
    state: DialStripState,
    delta: number,
): DialStripState {
    if (state.lane === "model" || state.lane === "effort") {
        return adjustDialEffort(state, delta);
    }
    if (state.lane === "agent") {
        const agentIndex = cycleIndex(
            state.agentIndex,
            delta,
            state.agents.length,
        );
        const agent = state.agents[agentIndex];
        const forbidden = agent === undefined
            ? []
            : state.agentForbiddenAccess[agent] ?? [];
        const current = state.permissionModes[state.permissionIndex];
        if (current === undefined || !forbidden.includes(current)) {
            return { ...state, agentIndex };
        }
        const posture = agent === undefined
            ? undefined
            : state.agentPostures[agent];
        const permissionIndex = posture === undefined
            || forbidden.includes(posture)
            ? state.permissionModes.findIndex((mode) => !forbidden.includes(mode))
            : state.permissionModes.indexOf(posture);
        return {
            ...state,
            agentIndex,
            permissionIndex: Math.max(0, permissionIndex),
            permissionEdited: true,
        };
    }
    const agent = state.agents[state.agentIndex];
    const forbidden = agent === undefined
        ? []
        : state.agentForbiddenAccess[agent] ?? [];
    const allowed = state.permissionModes
        .map((mode, index) => ({ mode, index }))
        .filter(({ mode }) => !forbidden.includes(mode));
    if (allowed.length === 0) return state;
    const at = Math.max(
        0,
        allowed.findIndex(({ index }) => index === state.permissionIndex),
    );
    return {
        ...state,
        permissionIndex: allowed[cycleIndex(at, delta, allowed.length)]!.index,
        permissionEdited: true,
    };
}

/** Move the model highlight as a cycle. */
export function moveDialStrip(
    state: DialStripState,
    delta: number,
): DialStripState {
    const next = cycleIndex(state.index, delta, state.slots.length);
    if (next === state.index) return state;
    const { editedEffort: _discarded, ...rest } = state;
    return { ...rest, index: next };
}

/** Jump to a position by number, 1-based. Out of range does nothing. */
export function jumpDialStrip(
    state: DialStripState,
    position: number,
): DialStripState {
    if (position < 1 || position > state.slots.length) return state;
    return moveDialStrip(state, position - 1 - state.index);
}

/**
 * Move the effort on the highlighted row, by ordinal, without wrapping.
 *
 * A row whose model publishes no levels is a no-op rather than an error: the
 * pair is the model, and there is no dial to turn.
 */
export function adjustDialEffort(
    state: DialStripState,
    delta: number,
): DialStripState {
    const slot = state.slots[state.index];
    if (slot?.pair === undefined || slot.efforts.length === 0) {
        return state;
    }
    const currentEffort = state.editedEffort === undefined
        ? slot.pair.effort
        : state.editedEffort ?? undefined;
    const choices: readonly (string | undefined)[] = [undefined, ...slot.efforts];
    const at = Math.max(0, choices.indexOf(currentEffort));
    const next = choices[cycleIndex(at, delta, choices.length)];
    return { ...state, editedEffort: next ?? null };
}

/** The pair Enter would commit, or nothing when the row cannot be taken. */
export function dialStripSelection(
    state: DialStripState,
): DialPair | undefined {
    const slot = state.slots[state.index];
    if (slot?.pair === undefined) return undefined;
    const effort = state.editedEffort === undefined
        ? slot.pair.effort
        : state.editedEffort ?? undefined;
    return {
        ...(slot.pair.provider === undefined
            ? {}
            : { provider: slot.pair.provider }),
        model: slot.pair.model,
        ...(effort === undefined ? {} : { effort }),
    };
}

/**
 * The strip as one line, plus the line under it that names the keys.
 *
 * The hints are text the caller passes in, not chords written here: a user who
 * moved `dials.effort.up` must see their own chord, and the merged keymap is
 * the only thing that knows what it is.
 */
export function renderDialStrip(
    state: DialStripState,
    hints: string,
    width = Number.POSITIVE_INFINITY,
    maxModelRows = 9,
): readonly string[] {
    const cells = state.slots.map((slot, index) => {
        const label = slot.label;
        // Filled for the pair in use, hollow for one merely shortlisted, and a
        // return arrow for one used earlier this session.
        const source = slot.source === "current"
            ? "●"
            : slot.source === "recent"
                    ? "↺"
                    : "○";
        // The marker stays outside the brackets: it says where the row came
        // from, which is true whether or not the row is the highlighted one.
        const choice = `${source} ${index + 1} ${label}`;
        const provider = slot.pair?.provider;
        return provider === undefined
            ? choice
            : `${choice}${DIAL_PROVIDER_SEPARATOR}${provider}`;
    });
    const modelLines = renderExpandedModelLane(
        cells,
        width,
        state.index,
        maxModelRows,
        state.overflow > 0,
        state.recent.map((slot) => slot.label),
        state.lane === "model",
    );
    const slot = state.slots[state.index];
    const note = slot === undefined
        ? "nothing to dial"
        : slot.pair === undefined
            ? `${slot.unavailable ?? "unavailable"}`
            : slot.efforts.length === 0
                ? "no effort dial"
                : hints;
    const agentCells = state.agents.map((agent, index) =>
        index === state.agentIndex ? `[${agent}]` : agent
    );
    const permissionCells = state.permissionModes.map((mode, index) =>
        index === state.permissionIndex ? `[${mode.replaceAll("_", " ")}]` : mode.replaceAll("_", " ")
    );
    const selectedSlot = state.slots[state.index];
    const selectedEffort = state.editedEffort === undefined
        ? selectedSlot?.pair?.effort
        : state.editedEffort ?? undefined;
    const effortCells = [
        selectedEffort === undefined ? "[default]" : "default",
        ...(selectedSlot?.efforts.map((effort) =>
        effort === selectedEffort ? `[${effort}]` : effort
        ) ?? []),
    ];
    const showEffortScale = Number.isFinite(width)
        && width >= 56
        && (selectedSlot?.efforts.length ?? 0) >= 2;
    const accessLine = renderDialLane(
        state.lane === "access",
        "ACCESS",
        permissionCells,
        state.permissionIndex,
        width,
    );
    const selectedAgent = state.agents[state.agentIndex];
    const forbidden = selectedAgent === undefined
        ? []
        : state.agentForbiddenAccess[selectedAgent] ?? [];
    const unavailable = state.permissionModes.find((mode) =>
        forbidden.includes(mode)
    );
    const accessNote = unavailable === undefined || selectedAgent === undefined
        ? undefined
        : `${unavailable.replaceAll("_", " ")} unavailable — ${selectedAgent} is ${
            state.agentPostures[selectedAgent] ?? "restricted"
        }`;
    return [
        ...(showEffortScale ? [] : [renderDialLane(
            state.lane === "effort",
            "EFFORT",
            selectedSlot?.efforts.length === 0
                ? ["not available"]
                : effortCells,
            selectedEffort === undefined
                ? 0
                : Math.max(
                    0,
                    (selectedSlot?.efforts.indexOf(selectedEffort) ?? -1) + 1,
                ),
            width,
        )]),
        ...renderEffortScale(
            selectedSlot?.efforts ?? [],
            selectedEffort,
            width,
            selectedEffort === undefined ? "[default]" : "default",
            selectedSlot?.defaultEffort,
            state.lane === "effort",
        ),
        accessNote === undefined
            ? accessLine
            : appendDialNote(accessLine, accessNote, width),
        ...modelLines,
        renderDialLane(
            state.lane === "agent",
            "AGENT",
            agentCells.length === 0 ? ["unavailable"] : agentCells,
            state.agentIndex,
            width,
        ),
        "",
        renderDialFooter(
            state.lane === "effort"
                ? Number.isFinite(width) && width < 42
                    ? "←/→"
                    : "←/→ effort · tab lane"
                : state.lane === "model"
                ? Number.isFinite(width) && width < 42
                    ? "↑/↓ · ←/→"
                    : `${note === "nothing to dial" || note === "no effort dial" ? `${note} · ` : ""}↑/↓ model · ←/→ effort · tab lane · ● current · ↺ recent · ○ pool`
                : hints,
            width,
        ),
    ];
}

/**
 * A small visual explanation of the effort axis. It is deliberately omitted
 * when the terminal is narrow: the ordinary effort row remains the compact
 * fallback, rather than letting decoration crowd out the agent and access
 * lanes.
 */
export function renderEffortScale(
    efforts: readonly string[],
    selected: string | undefined,
    width: number,
    defaultCell?: string,
    defaultEffort?: string,
    active = false,
): readonly string[] {
    const choices = [...efforts];
    if (choices.length < 2 || !Number.isFinite(width) || width < 56) {
        return [];
    }
    // Wide enough that the lane name and the default chip both sit to the left
    // of the track, with the axis labels above still aligned to its start.
    const indent = defaultCell === undefined ? DIAL_CHOICE_COLUMN : 30;
    // Keep the scale a compact HUD element; it should explain the axis without
    // stretching a short control panel across the whole terminal.
    const trackWidth = Math.min(36, Math.max(20, width - indent - 2));
    const labelGap = Math.max(1, trackWidth - "Faster".length - "Smarter".length);
    const labels = `${" ".repeat(indent)}Faster${" ".repeat(labelGap)}Smarter`;
    const trackLength = Math.max(1, trackWidth - 1);
    const selectedIndex = selected === undefined
        ? -1
        : choices.indexOf(selected);
    const marker = selectedIndex < 0
        ? -1
        : Math.round(selectedIndex * (trackLength - 1) / (choices.length - 1));
    const track = Array.from({ length: trackLength }, (_, index) =>
        index === marker
            ? "▲"
            : "─"
    ).join("");
    const optionLine = Array.from({ length: trackLength }, () => " ");
    let nextStart = 0;
    choices.forEach((choice, index) => {
        const position = Math.round(index * (trackLength - 1) / (choices.length - 1));
        // The marker above is the selection cue; leaving the labels unbracketed
        // keeps the short scale legible when default and low are adjacent.
        const label = choice;
        const start = Math.max(
            nextStart,
            0,
            Math.min(trackLength - label.length, position - Math.floor(label.length / 2)),
        );
        for (let offset = 0; offset < label.length; offset += 1) {
            optionLine[start + offset] = label[offset] ?? " ";
        }
        nextStart = start + label.length + 1;
    });
    // The chip sits in the gutter, joined to the track by a dotted lead-in. The
    // dots say it belongs to this control while the solid line does not reach
    // it: choosing default is not a point on the Faster/Smarter axis.
    // Padded to the same width every other rung uses, so the chip starts in
    // the column the access and agent choices start in.
    const laneLabel = `${active ? "›" : " "} EFFORT`.padEnd(DIAL_CHOICE_COLUMN);
    const chipStart = defaultCell === undefined
        ? indent
        : laneLabel.length + defaultCell.length;
    const dots = Math.max(0, indent - chipStart - 2);
    const gutter = defaultCell === undefined
        ? " ".repeat(indent)
        : `${laneLabel}${DIAL_DEFAULT_SEPARATOR}${defaultCell}${
            DIAL_DEFAULT_SEPARATOR
        } ${"·".repeat(dots)} `;
    // The chip says the model chooses; the note under it says what it chose.
    const note = defaultCell === undefined || defaultEffort === undefined
        ? ""
        : `(${defaultEffort})`;
    // Default sits off the track, so its selection marker sits under the chip
    // rather than on the line, in the same place the track labels sit under
    // their own marker.
    const chipMarker = defaultCell !== undefined && selected === undefined
        ? "\u25b2"
        : "";
    const noteLead = laneLabel.length;
    const gutterMarks = [chipMarker, note].filter((part) => part !== "");
    const gutterText = gutterMarks.join(" ");
    const optionGutter = gutterText === ""
        ? " ".repeat(indent)
        : `${" ".repeat(noteLead)}${
            gutterMarks
                .map((part) =>
                    `${DIAL_DEFAULT_SEPARATOR}${part}${DIAL_DEFAULT_SEPARATOR}`
                )
                .join(" ")
        }${" ".repeat(Math.max(1, indent - noteLead - gutterText.length))}`;
    return [
        fitDialText(labels, width),
        `${gutter}${track}`,
        `${optionGutter}${optionLine.join("")}`,
    ];
}

function appendDialNote(line: string, note: string, width: number): string {
    if (!Number.isFinite(width)) return `${line}  ${note}`;
    const gap = 2;
    if (line.length + gap + note.length <= width) {
        return `${line}${" ".repeat(width - line.length - note.length)}${note}`;
    }
    return fitDialText(line, width);
}

function renderDialFooter(hints: string, width: number): string {
    const exit = "esc close";
    if (!Number.isFinite(width)) {
        return `${hints}  ${DIAL_EXIT_SEPARATOR}${exit}`;
    }
    const gap = 2;
    const hintWidth = Math.max(0, width - exit.length - gap);
    const left = fitDialText(hints, hintWidth);
    return `${left}${" ".repeat(Math.max(gap, width - left.length - exit.length))}${DIAL_EXIT_SEPARATOR}${exit}`;
}

function renderExpandedModelLane(
    cells: readonly string[],
    width: number,
    selected: number,
    maxRows: number,
    hiddenAfter: boolean,
    recent: readonly string[],
    active: boolean,
): readonly string[] {
    const count = Math.max(1, Math.min(maxRows, cells.length));
    const start = clamp(
        selected - Math.floor(count / 2),
        0,
        Math.max(0, cells.length - count),
    );
    const end = Math.min(cells.length, start + count);
    const layoutWidth = Number.isFinite(width) ? width : 120;
    const showRecent = Number.isFinite(width) && width >= 72 && recent.length > 0;
    const recentWidth = showRecent ? Math.min(26, Math.floor(width * 0.34)) : 0;
    const leftWidth = showRecent ? layoutWidth - recentWidth - 2 : layoutWidth;
    const showProviders = leftWidth >= 60;
    const providerWidth = Math.max(
        0,
        ...cells.map((cell) =>
            cell.split(DIAL_PROVIDER_SEPARATOR)[1]?.length ?? 0
        ),
    );
    // Measured without the leading source marker, which sits outside the
    // brackets and so is not part of the name column.
    const widestChoice = Math.max(
        0,
        ...cells.map((cell) =>
            Math.max(
                0,
                (cell.split(DIAL_PROVIDER_SEPARATOR)[0] ?? "").trim().length - 2,
            )
        ),
    );
    const row = (left: string, right = "") => showRecent
        ? `${fitDialText(left, leftWidth).padEnd(leftWidth)}  ${fitDialText(right, recentWidth)}`
        : fitDialText(left, width);
    const modelRow = (cell: string, rowIndex: number, right = "") => {
        const [choice = "", provider] = cell.split(DIAL_PROVIDER_SEPARATOR);
        const compact = leftWidth < 42;
        // The marker sits in the two columns before the choice column, so the
        // brackets open where the access and agent brackets open.
        const indent = rowIndex === 0
            ? compact
                ? `${active ? "›" : " "} `
                : `${active ? "›" : " "} MODEL`.padEnd(12)
            : " ".repeat(compact ? 2 : 12);
        // The brackets enclose the name and its provider together, so the
        // highlight reads as one choice rather than as a name with an unclaimed
        // label trailing it. Unpicked rows spend the same columns on spaces.
        const picked = start + rowIndex === selected;
        const marker = choice.slice(0, 1);
        const name = choice.slice(2);
        const open = picked ? "[" : " ";
        const close = picked ? "]" : " ";
        const head = `${indent}${marker} ${open} `;
        const providerText = showProviders ? provider ?? "" : "";
        const nameWidth = providerText.length === 0
            ? Math.max(
                1,
                Math.min(leftWidth - head.length - 2, widestChoice),
            )
            : Math.max(
                1,
                Math.min(
                    leftWidth - head.length - providerWidth - 3,
                    widestChoice + 2,
                ),
            );
        const left = `${head}${fitDialText(name, nameWidth).padEnd(nameWidth)}`;
        const joined = providerText.length === 0
            ? `${left} ${close}`
            : `${left}${DIAL_PROVIDER_SEPARATOR}${
                providerText.padEnd(providerWidth)
            }${DIAL_PROVIDER_SEPARATOR} ${close}`;
        return showRecent
            ? `${joined.padEnd(leftWidth)}  ${fitDialText(right, recentWidth)}`
            : joined;
    };
    return [
        ...(start > 0
            ? [row(
                leftWidth < 42
                    ? `${active ? "›" : " "} …`
                    : `${active ? "›" : " "} MODEL       …`,
                "RECENTLY USED",
            )]
            : []),
        ...cells.slice(start, end).map((cell, index) =>
            modelRow(
                cell,
                index,
                index === 0 ? "RECENTLY USED" : recent[index - 1] ?? "",
            )
        ),
        ...(end < cells.length || hiddenAfter
            ? [leftWidth < 42 ? "  …" : "              …"]
            : []),
    ];
}

/**
 * The column every rung's first choice starts in. The model rung spends the
 * four columns before it on its source marker and opening bracket, so the
 * other rungs pad their labels out to the same place.
 */
const DIAL_CHOICE_COLUMN = 16;
/** The same column once the labels are dropped on a narrow terminal. */
const DIAL_CHOICE_COLUMN_COMPACT = 6;

function renderDialLane(
    active: boolean,
    label: string,
    cells: readonly string[],
    selected: number,
    width: number,
    hiddenAfter = false,
): string {
    // Keep the controls on a shared label gutter, then let choices remain
    // compact; fixed-width choices become excessively airy on wide terminals.
    const prefix = Number.isFinite(width) && width < 42
        ? `${active ? "›" : " "} `.padEnd(DIAL_CHOICE_COLUMN_COMPACT)
        : `${active ? "›" : " "} ${
            label.padEnd(DIAL_CHOICE_COLUMN - 2)
        }`;
    let start = 0;
    let end = cells.length;
    const line = () => {
        const before = start > 0 ? "… " : "";
        const after = end < cells.length || hiddenAfter ? " …" : "";
        return `${prefix}${before}${cells.slice(start, end).join(" ")}${after}`;
    };
    while (end - start > 1 && line().length > width) {
        const leftDistance = selected - start;
        const rightDistance = end - 1 - selected;
        if (rightDistance >= leftDistance && end - 1 > selected) {
            end -= 1;
        } else if (start < selected) {
            start += 1;
        } else {
            end -= 1;
        }
    }
    return fitDialText(line(), width);
}

function fitDialText(text: string, width: number): string {
    if (!Number.isFinite(width) || text.length <= width) return text;
    if (width <= 1) return text.slice(0, Math.max(0, width));
    return `${text.slice(0, width - 1)}…`;
}

function clamp(value: number, low: number, high: number): number {
    return Math.max(low, Math.min(high, value));
}

function cycleIndex(index: number, delta: number, length: number): number {
    if (length <= 0) return 0;
    if (index < 0) return delta < 0 ? length - 1 : 0;
    return (index + delta % length + length) % length;
}

/**
 * What a keypress means to the open strip.
 *
 * The HUD is modal: Enter applies and Escape cancels. Printable keys never
 * leak into the composer while it is open; h/j/k/l mirror the arrow keys.
 */
export type DialStripAction =
    | { readonly kind: "state"; readonly state: DialStripState }
    | {
        readonly kind: "commit";
        readonly pair: DialPair;
        readonly agent?: string;
        readonly permission?: string;
    }
    | { readonly kind: "cancel" }
    | { readonly kind: "ignore" };

export interface DialStripKey {
    readonly name: string;
    readonly ctrl?: boolean;
    readonly shift?: boolean;
    readonly sequence?: string;
}

export function handleDialStripKey(
    state: DialStripState,
    key: DialStripKey,
    /** What the merged keymap says this chord means in the `dials` scope. */
    bindingId: string | undefined,
): DialStripAction {
    if (key.name === "escape" || key.name === "esc") {
        return { kind: "cancel" };
    }
    if (key.name === "return" || key.name === "enter") {
        const pair = dialStripSelection(state);
        return pair === undefined ? { kind: "ignore" } : {
            kind: "commit",
            pair,
            ...(state.agents[state.agentIndex] === undefined
                ? {}
                : { agent: state.agents[state.agentIndex] }),
            ...(state.permissionEdited !== true
                || state.permissionModes[state.permissionIndex] === undefined
                ? {}
                : { permission: state.permissionModes[state.permissionIndex] }),
        };
    }
    if (isTuiDialTabKey(key)) {
        return {
            kind: "state",
            state: moveDialLane(state, key.shift === true ? -1 : 1),
        };
    }
    const vimBinding = key.name === "h"
        ? "dials.pair.prev"
        : key.name === "l"
            ? "dials.pair.next"
            : key.name === "k"
                ? "dials.effort.up"
                : key.name === "j"
                    ? "dials.effort.down"
                    : undefined;
    bindingId ??= vimBinding;
    switch (bindingId) {
        case "dials.pair.prev":
            return { kind: "state", state: moveChoice(state, -1) };
        case "dials.pair.next":
            return { kind: "state", state: moveChoice(state, 1) };
        case "dials.effort.up":
            return {
                kind: "state",
                state: state.lane === "model"
                    ? moveDialStrip(state, -1)
                    : state,
            };
        case "dials.effort.down":
            return {
                kind: "state",
                state: state.lane === "model"
                    ? moveDialStrip(state, 1)
                    : state,
            };
    }
    if (key.ctrl === true) {
        return { kind: "ignore" };
    }
    if (/^[1-9]$/.test(key.name)) {
        return { kind: "state", state: jumpDialStrip(state, Number(key.name)) };
    }
    return { kind: "ignore" };
}
