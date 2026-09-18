import { tuiBindingId } from "./keymap.ts";
import { arrowMovesForward, sectionArrow } from "./section-keys.ts";

export const DIAL_EXIT_SEPARATOR = "";

export type DialLane = "agent" | "access";

export interface DialStripState {
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
}

export function openDialStrip(
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
        lane: "agent",
        agents,
        agentIndex: Math.max(0, agents.indexOf(options.currentAgent ?? "")),
        agentPostures: options.agentPostures ?? {},
        agentForbiddenAccess: options.agentForbiddenAccess ?? {},
        permissionModes,
        disabledPermissionModes: options.disabledPermissionModes,
        permissionIndex: permissionModes.indexOf(options.currentPermission ?? ""),
        ...(options.currentAgent === undefined
            ? {}
            : { openedAgent: options.currentAgent }),
        ...(options.currentPermission === undefined
            ? {}
            : { openedPermission: options.currentPermission }),
    };
}

const DIAL_LANES = ["agent", "access"] as const;

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

export function renderDialStrip(
    state: DialStripState,
    hints: string,
    width = Number.POSITIVE_INFINITY,
): readonly string[] {
    const agent = state.agents[state.agentIndex];
    const forbidden = agent === undefined ? [] : state.agentForbiddenAccess[agent] ?? [];
    const lane = (name: DialLane, values: readonly string[], selected: number, live?: string) => {
        const cells = values.map((value, index) => dialChoiceCell(value, index === selected && value !== "unavailable"));
        const line = renderDialLane(state.lane === name, name.toUpperCase(), cells, selected, width);
        return live === undefined || values[selected] === live ? line : appendDialNote(line, `live: ${live}`, width);
    };
    const permissionLabel = (mode: string) => mode === "full_access" ? "full" : mode.replaceAll("_", " ");
    const permission = state.permissionModes.map((mode) =>
        `${permissionLabel(mode)}${forbidden.includes(mode) || state.disabledPermissionModes?.includes(mode) ? " (off)" : ""}`);
    return [
        lane("agent", state.agents.length === 0 ? ["unavailable"] : state.agents,
            state.agentIndex, state.openedAgent),
        "",
        lane("access", permission.length === 0 ? ["unavailable"] : permission,
            state.permissionIndex, state.openedPermission === undefined ? undefined : permissionLabel(state.openedPermission)),
        "",
        renderDialFooter(hints, width),
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

export const DIAL_PICK_MARKER = "›";

function dialChoiceCell(label: string, picked: boolean): string {
    // Each cell carries its own padding on both sides so the marked one reads
    // as an evenly padded block.
    return `${picked ? DIAL_PICK_MARKER : " "}${label} `;
}

const DIAL_CHOICE_COLUMN = 16;

function renderDialLane(
    active: boolean,
    label: string,
    cells: readonly string[],
    selected: number,
    width: number,
): string {
    const prefix = `${active ? "›" : " "} ${label.padEnd(DIAL_CHOICE_COLUMN - 3)}`;
    let start = 0;
    let end = cells.length;
    const line = () => {
        const hidden = start + cells.length - end;
        const after = hidden > 0 ? `+${hidden}` : "";
        return `${prefix}${cells.slice(start, end).join("")}${after}`;
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

function cycleIndex(index: number, delta: number, length: number): number {
    if (length <= 0) return 0;
    if (index < 0) return delta < 0 ? length - 1 : 0;
    return (index + delta % length + length) % length;
}

export type DialStripAction =
    | { readonly kind: "state"; readonly state: DialStripState }
    | {
        readonly kind: "commit";
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
        return {
            kind: "commit",
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
    const arrow = sectionArrow(key.name);
    if (arrow === undefined) return { kind: "ignore" };
    const delta = arrowMovesForward(arrow) ? 1 : -1;
    const vertical = arrow === "up" || arrow === "down";
    return vertical
        ? { kind: "state", state: moveDialLane(state, delta) }
        : { kind: "state", state: moveChoice(state, delta) };
}
