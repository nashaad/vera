


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
    readonly unavailable?: "not in your pool";
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
    if (state.lane === "model") return moveDialStrip(state, delta);
    if (state.lane === "effort") {
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
    const { editedEffort: _discarded, ...rest } = state;
    return { ...rest, index: next };
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
        const cells = values.map((value, index) =>
            index === selected && value !== "unavailable" ? `‹ ${value} ›` : value);
        const liveNote = live === undefined || values[selected] === live
            ? "" : `  live: ${live}`;
        return renderDialLane(state.lane === name, name.toUpperCase(), cells,
            selected, Math.max(12, width - liveNote.length)) + liveNote;
    };
    const permission = state.permissionModes.map((mode) =>
        `${mode.replaceAll("_", " ")}${forbidden.includes(mode) ? " (off)" : ""}`);
    return [
        lane("effort", efforts, Math.max(0, efforts.indexOf(effort ?? "default")),
            state.opened?.effort ?? "default"),
        lane("access", permission.length === 0 ? ["unavailable"] : permission,
            state.permissionIndex, state.openedPermission),
        lane("model", state.slots.length === 0 ? ["unavailable"] : state.slots.map(
            (entry) => `${entry.label}${entry.unavailable === undefined ? "" : " (off)"}`),
            state.index, state.slots.find((entry) => entry.source === "current")?.label),
        lane("agent", state.agents.length === 0 ? ["unavailable"] : state.agents,
            state.agentIndex, state.openedAgent),
        renderDialFooter("↑/↓ lane · ←/→ change · ⏎ apply · apply or cancel before Switch model", width),
    ];
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

function renderExpandedModelLane(
    cells: readonly string[],
    width: number,
    selected: number,
    maxRows: number,
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
        const indent = rowIndex === 0
            ? compact
                ? `${active ? "›" : " "} `
                : `${active ? "›" : " "} MODEL`.padEnd(12)
            : " ".repeat(compact ? 2 : 12);
        const picked = start + rowIndex === selected;
        const marker = choice.slice(0, 1);
        const name = choice.slice(2);
        const open = picked ? DIAL_PICK_MARKER : " ";
        const close = " ";
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
                leftWidth < 42 ? "  …" : "              …",
            )]
            : []),
        ...cells.slice(start, end).map((cell, index) =>
            modelRow(
                cell,
                index,
                index === 0 ? "RECENTLY USED" : recent[index - 1] ?? "",
            )
        ),
        ...(end < cells.length
            ? [leftWidth < 42 ? "  …" : "              …"]
            : []),
    ];
}

export const DIAL_PICK_MARKER = "\u203a";

function dialChoiceCell(label: string, picked: boolean): string {
    return `${picked ? DIAL_PICK_MARKER : " "}${label}`;
}

const DIAL_CHOICE_COLUMN = 10;
const DIAL_CHOICE_COLUMN_COMPACT = 6;

function renderDialLane(
    active: boolean,
    label: string,
    cells: readonly string[],
    selected: number,
    width: number,
    hiddenAfter = false,
): string {
    const prefix = `${active ? "›" : " "} ${label.padEnd(7)}`;
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
    if (key.ctrl === true) return { kind: "ignore" };
    switch (key.name) {
        case "left": return { kind: "state", state: moveChoice(state, -1) };
        case "right": return { kind: "state", state: moveChoice(state, 1) };
        case "up": return { kind: "state", state: moveDialLane(state, -1) };
        case "down": return { kind: "state", state: moveDialLane(state, 1) };
        default: return { kind: "ignore" };
    }
}
