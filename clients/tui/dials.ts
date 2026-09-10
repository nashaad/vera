import { tuiBindingId } from "./keymap.ts";

export interface DialPair {
    readonly provider?: string;
    readonly model: string;
    readonly effort?: string;
}

export interface DialPoolEntry {
    readonly provider: string;
    readonly model: string;
    readonly poolName?: string;
    readonly levels: readonly string[];
    readonly defaultLevel?: string;
    /** False on an entry that cannot run right now. Such an entry states no levels, so it must not stand in for the catalog's. */
    readonly available?: boolean;
}

export const DIAL_PROVIDER_SEPARATOR = "\u001f";

export const DIAL_DEFAULT_SEPARATOR = "\u001d";
export const DIAL_EXIT_SEPARATOR = "\u001e";

export type DialSlotSource = "current" | "recent" | "pool";

export interface DialSlot {
    readonly label: string;
    readonly pair?: DialPair;
    readonly source: DialSlotSource;
    readonly efforts: readonly string[];
    readonly defaultEffort?: string;
    readonly unavailable?: "not in your pool" | "not available";
}

export interface DialStripComposition {
    readonly slots: readonly DialSlot[];
    readonly recent: readonly DialSlot[];
    readonly overflow: number;
}

export const DIAL_STRIP_CAP = 6;

export const DIAL_HUD_CAP = 10;
export const DIAL_HUD_RECENT_CAP = 5;

function pairOf(entry: DialPoolEntry, effort: string | undefined): DialPair {
    return {
        provider: entry.provider,
        model: entry.model,
        ...(effort === undefined ? {} : { effort }),
    };
}

export function composeDialStrip(options: {
    readonly current: DialPair | undefined;
    readonly recents: readonly DialPair[];
    readonly pool: readonly DialPoolEntry[];
    readonly catalog?: readonly DialPoolEntry[];
    readonly cap?: number;
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

export function modelKey(pair: DialPair): string {
    return `${pair.provider ?? ""}/${pair.model}`;
}

export function pairKey(pair: DialPair): string {
    return `${pair.provider ?? ""}/${pair.model}/${pair.effort ?? ""}`;
}

export function refreshDialStrip(state: DialStripState, composition: DialStripComposition): DialStripState {
    const slots = [...composition.slots];
    const selected = state.slots[state.index];
    let index = selected?.pair === undefined ? 0
        : slots.findIndex((slot) => slot.pair !== undefined && modelKey(slot.pair) === modelKey(selected.pair!));
    // A history reply must not displace a model or effort the user has staged.
    if (index < 0 && selected !== undefined) {
        const sameGroup = slots.findLastIndex((slot) => slot.source === selected.source);
        index = sameGroup < 0 ? Math.max(0, slots.length - 1) : sameGroup;
        slots[index] = selected;
    } else if (selected?.pair !== undefined && slots[index] !== undefined) {
        slots[index] = { ...slots[index]!, pair: selected.pair };
    }
    return { ...state, slots, index: Math.max(0, index), recent: composition.recent, overflow: composition.overflow };
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
    const ready = entry !== undefined && entry.available !== false;
    const facts = ready ? entry : findEntry(pair, catalog);
    return {
        label: entry?.poolName ?? shortModel(pair.model),
        pair,
        source,
        ...(entry?.available === false ? { unavailable: "not available" as const } : {}),
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
    readonly editedEffort?: string | null;
    readonly opened?: DialPair;
    readonly lane: DialLane;
    readonly agents: readonly string[];
    readonly agentIndex: number;
    readonly openedAgent?: string;
    readonly agentPostures: Readonly<Record<string, string>>;
    readonly agentForbiddenAccess: Readonly<Record<string, readonly string[]>>;
    readonly disabledPermissionModes?: readonly string[];
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
        readonly disabledPermissionModes?: readonly string[];
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
        lane: "effort",
        agents,
        agentIndex: Math.max(0, agents.indexOf(options.currentAgent ?? "")),
        agentPostures: options.agentPostures ?? {},
        agentForbiddenAccess: options.agentForbiddenAccess ?? {},
        permissionModes,
        disabledPermissionModes: options.disabledPermissionModes,
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

export function dialAccessAllowed(
    state: DialStripState,
    mode: string | undefined,
    agent = state.agents[state.agentIndex],
): boolean {
    return mode !== undefined && state.permissionModes.includes(mode)
        && !state.disabledPermissionModes?.includes(mode)
        && !(agent === undefined ? [] : state.agentForbiddenAccess[agent] ?? []).includes(mode);
}

function moveChoice(
    state: DialStripState,
    delta: number,
): DialStripState {
    if (state.lane === "model") return moveDialStrip(state, delta);
    if (state.lane === "effort") {
        return adjustDialEffort(state, delta);
    }
    if (state.lane === "agent") {
        let agentIndex = state.agentIndex;
        for (let step = 0; step < state.agents.length; step += 1) {
            agentIndex = cycleIndex(agentIndex, delta, state.agents.length);
            const agent = state.agents[agentIndex];
            const current = state.permissionModes[state.permissionIndex];
            if (dialAccessAllowed(state, current, agent)) return { ...state, agentIndex };
            const posture = agent === undefined ? undefined : state.agentPostures[agent];
            const permissionIndex = dialAccessAllowed(state, posture, agent)
                ? state.permissionModes.indexOf(posture!)
                : state.permissionModes.findIndex((mode) => dialAccessAllowed(state, mode, agent));
            if (permissionIndex >= 0) return { ...state, agentIndex, permissionIndex, permissionEdited: true };
        }
        return state;
    }
    const allowed = state.permissionModes
        .map((mode, index) => ({ mode, index }))
        .filter(({ mode }) => dialAccessAllowed(state, mode));
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

export function moveDialStrip(
    state: DialStripState,
    delta: number,
): DialStripState {
    let next = state.index;
    for (let step = 0; step < state.slots.length; step += 1) {
        next = cycleIndex(next, delta, state.slots.length);
        if (state.slots[next]?.unavailable === undefined) break;
    }
    if (next === state.index || state.slots[next]?.unavailable !== undefined) return state;
    return { ...state, index: next };
}

export function jumpDialStrip(
    state: DialStripState,
    position: number,
): DialStripState {
    if (position < 1 || position > state.slots.length) return state;
    return moveDialStrip(state, position - 1 - state.index);
}

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

export function dialStripSelection(
    state: DialStripState,
): DialPair | undefined {
    const slot = state.slots[state.index];
    if (slot?.pair === undefined || slot.unavailable !== undefined) return undefined;
    const effort = state.editedEffort === undefined
        ? slot.pair.effort
        : state.editedEffort ?? undefined;
    return {
        ...(slot.pair.provider === undefined
            ? {}
            : { provider: slot.pair.provider }),
        model: slot.pair.model,
        ...(effort === undefined || !slot.efforts.includes(effort) ? {} : { effort }),
    };
}

export function dialEffortPending(state: DialStripState): boolean {
    if (state.editedEffort === undefined) return false;
    const applied = state.slots[state.index]?.pair?.effort;
    return (state.editedEffort ?? undefined) !== applied;
}

export function renderDialStrip(
    state: DialStripState,
    hints: string,
    width = Number.POSITIVE_INFINITY,
    maxModelRows = DIAL_HUD_CAP,
): readonly string[] {
    const slot = state.slots[state.index];
    const effort = state.editedEffort === undefined
        ? slot?.pair?.effort : state.editedEffort ?? undefined;
    const efforts = ["default", ...(slot?.efforts ?? [])];
    const agent = state.agents[state.agentIndex];
    const forbidden = agent === undefined ? [] : state.agentForbiddenAccess[agent] ?? [];
    const lane = (name: DialLane, values: readonly string[], selected: number, live?: string) => {
        const cells = values.map((value, index) => dialChoiceCell(value, index === selected && value !== "unavailable"));
        const line = renderDialLane(state.lane === name, name.toUpperCase(), cells, selected, width);
        return live === undefined || values[selected] === live ? line : appendDialNote(line, `live: ${live}`, width);
    };
    const scale = renderEffortScale(slot?.efforts ?? [], effort, width,
        " default", slot?.defaultEffort, state.lane === "effort");
    const reserveScale = Number.isFinite(width) && width >= 56 && state.slots.some((entry) => entry.efforts.length >= 2);
    const effortRows = scale.length > 0 ? [...scale] : [
        ...(reserveScale ? [""] : []),
        lane("effort", efforts, Math.max(0, efforts.indexOf(effort ?? "default"))),
        ...(reserveScale ? [""] : []),
    ];
    if (effort !== state.opened?.effort) {
        const live = `live: ${state.opened?.effort ?? "default"}`;
        effortRows[0] = scale.length > 0
            ? fitDialText(" ".repeat(DIAL_CHOICE_COLUMN) + live, 30).padEnd(30) + effortRows[0]!.slice(30)
            : appendDialNote(effortRows[0]!, live, width);
    }
    const permissionLabel = (mode: string) => mode === "full_access" ? "full" : mode.replaceAll("_", " ");
    const permission = state.permissionModes.map((mode) =>
        `${permissionLabel(mode)}${forbidden.includes(mode) || state.disabledPermissionModes?.includes(mode) ? " (off)" : ""}`);
    return [
        ...effortRows,
        "",
        lane("access", permission.length === 0 ? ["unavailable"] : permission,
            state.permissionIndex, state.openedPermission === undefined ? undefined : permissionLabel(state.openedPermission)),
        "",
        ...renderModelChoices(state, width, maxModelRows),
        "",
        lane("agent", state.agents.length === 0 ? ["unavailable"] : state.agents,
            state.agentIndex, state.openedAgent),
        "",
        renderDialFooter(`Tab/Shift+Tab sections · ${state.lane === "model" ? "↑↓ model" : "←→ change"} · ⏎ apply`, width),
    ];
}

function renderModelChoices(state: DialStripState, width: number, maxRows: number): readonly string[] {
    const labels = state.slots.map((entry) => `${entry.label}${entry.unavailable === undefined ? "" : " (off)"}`);
    if (labels.length === 0) return [fitDialText(`${state.lane === "model" ? "›" : " "} MODEL`.padEnd(DIAL_CHOICE_COLUMN) + "unavailable", width)];
    const count = Math.min(labels.length, Math.max(1, maxRows));
    const start = Math.max(0, Math.min(state.index - Math.floor(count / 2), labels.length - count));
    const available = Number.isFinite(width) ? width : 120;
    const providerWidth = available < 60 ? 0 : Math.min(24, Math.max(0, ...state.slots.map((entry) => entry.pair?.provider?.length ?? 0)));
    const nameWidth = Math.max(1, Math.min(Math.max(...labels.map((label) => label.length)), available - DIAL_CHOICE_COLUMN - providerWidth - (providerWidth ? 2 : 0)));
    const lines: string[] = [];
    let previousSource: DialSlotSource | undefined;
    for (const [row, label] of labels.slice(start, start + count).entries()) {
        const index = start + row;
        const slot = state.slots[index]!;
        if (slot.source !== previousSource && slot.source !== "current") {
            if (row > 0) lines.push("");
            lines.push(fitDialText(" ".repeat(DIAL_CHOICE_COLUMN) + (slot.source === "recent" ? "Recent" : "From Model Library"), width));
        }
        previousSource = slot.source;
        const prefix = " ".repeat(DIAL_CHOICE_COLUMN - 4);
        const current = slot.source === "current" ? "●" : "○";
        const picked = index === state.index ? DIAL_PICK_MARKER : " ";
        const name = fitDialText(label, nameWidth).padEnd(nameWidth);
        const provider = providerWidth === 0 ? "" : `  ${fitDialText(slot.pair?.provider ?? "", providerWidth).padEnd(providerWidth)}`;
        lines.push(fitDialText(`${prefix}${current} ${picked} ${name}${provider}`, width));
    }
    const laneLabel = `${state.lane === "model" ? "›" : " "} MODEL`;
    lines[0] = laneLabel + lines[0]!.slice(laneLabel.length);
    const groups = new Set(state.slots.map((slot) => slot.source));
    const groupRows = (groups.has("recent") ? 2 : 0) + (groups.has("pool") ? 2 : 0) - (groups.has("current") ? 0 : 1);
    while (lines.length < count + Math.max(0, groupRows)) lines.push("");
    const below = labels.length - start - count;
    const windowHint = [start > 0 ? `↑ ${start} above` : "", below > 0 ? `↓ ${below} below` : ""].filter(Boolean).join(" · ");
    if (windowHint || state.overflow > 0) {
        lines.push(fitDialText(" ".repeat(DIAL_CHOICE_COLUMN) + (windowHint || "More models: /model"), width));
    }
    return lines;
}

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
    const indent = defaultCell === undefined ? DIAL_CHOICE_COLUMN : 30;
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
    const laneLabel = `${active ? "›" : " "} EFFORT`.padEnd(
        DIAL_CHOICE_COLUMN - 1,
    );
    const chipStart = defaultCell === undefined
        ? indent
        : laneLabel.length + defaultCell.length;
    const dots = Math.max(0, indent - chipStart - 2);
    const gutter = defaultCell === undefined
        ? " ".repeat(indent)
        : `${laneLabel}${DIAL_DEFAULT_SEPARATOR}${defaultCell}${
            DIAL_DEFAULT_SEPARATOR
        } ${"·".repeat(dots)} `;
    const note = defaultCell === undefined || defaultEffort === undefined
        ? ""
        : `(${defaultEffort})`;
    const chipMarker = defaultCell !== undefined && selected === undefined
        ? "\u25b2"
        : "";
    const noteLead = laneLabel.length + 1;
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
    const exit = "esc cancel";
    if (!Number.isFinite(width)) {
        return `${hints}  ${DIAL_EXIT_SEPARATOR}${exit}`;
    }
    const gap = 2;
    const hintWidth = Math.max(0, width - exit.length - gap);
    const left = fitDialText(hints, hintWidth);
    return `${left}${" ".repeat(Math.max(gap, width - left.length - exit.length))}${DIAL_EXIT_SEPARATOR}${exit}`;
}

export const DIAL_PICK_MARKER = "\u203a";

function dialChoiceCell(label: string, picked: boolean): string {
    return `${picked ? DIAL_PICK_MARKER : " "}${label}`;
}

const DIAL_CHOICE_COLUMN = 16;

function renderDialLane(
    active: boolean,
    label: string,
    cells: readonly string[],
    selected: number,
    width: number,
    hiddenAfter = false,
): string {
    const prefix = `${active ? "›" : " "} ${label.padEnd(DIAL_CHOICE_COLUMN - 3)}`;
    let start = 0;
    let end = cells.length;
    const line = () => {
        const before = "";
        const hidden = start + cells.length - end;
        const after = hidden > 0 ? ` +${hidden}` : "";
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

export type DialStripAction =
    | { readonly kind: "state"; readonly state: DialStripState }
    | {
        readonly kind: "commit";
        readonly pair: DialPair | undefined;
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
    bindingId: string | undefined,
): DialStripAction {
    if (key.name === "escape" || key.name === "esc") {
        return { kind: "cancel" };
    }
    if (key.name === "return" || key.name === "enter") {
        if ((state.permissionEdited === true || state.agents[state.agentIndex] !== state.openedAgent)
            && !dialAccessAllowed(state, state.permissionModes[state.permissionIndex])) return { kind: "ignore" };
        const pair = dialStripSelection(state);
        return {
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
    if (key.ctrl === true) return { kind: "ignore" };
    if ((bindingId ?? tuiBindingId("dials", key)) === "dials.section") {
        return { kind: "state", state: moveDialLane(state, key.shift || key.name === "backtab" ? -1 : 1) };
    }
    switch (key.name) {
        case "left": return state.lane === "model" ? { kind: "ignore" } : { kind: "state", state: moveChoice(state, -1) };
        case "right": return state.lane === "model" ? { kind: "ignore" } : { kind: "state", state: moveChoice(state, 1) };
        case "up": return state.lane === "model" ? { kind: "state", state: moveDialStrip(state, -1) } : { kind: "ignore" };
        case "down": return state.lane === "model" ? { kind: "state", state: moveDialStrip(state, 1) } : { kind: "ignore" };
        default: return { kind: "ignore" };
    }
}
