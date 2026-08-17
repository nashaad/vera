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

/** A model with the effort it runs at, when the model has an effort dial. */
export interface DialPair {
    readonly provider?: string;
    readonly model: string;
    /** Absent when the model publishes no levels at all. Its own value. */
    readonly effort?: string;
}

/**
 * A favourite as written in `tui.json`.
 *
 * Legal iff it carries a `name` or a `(provider, model_id)`. Both is
 * preferred and is what starring writes: the name is the identity a rename
 * follows, and the id is what finds the entry again after a rename happened
 * while Vera was not running.
 */
export interface FavoritePair {
    readonly name?: string;
    readonly provider?: string;
    readonly modelId?: string;
    readonly effort?: string;
}

/** What the strip needs to know about one model the user has admitted. */
export interface DialPoolEntry {
    readonly provider: string;
    readonly model: string;
    readonly poolName?: string;
    readonly levels: readonly string[];
}

export type DialSlotSource = "current" | "favorite" | "recent";

export interface DialSlot {
    /** The name to show. A stale favourite still has one, which is the point. */
    readonly label: string;
    /** Absent when nothing in the pool answers to this favourite any more. */
    readonly pair?: DialPair;
    readonly source: DialSlotSource;
    /** The levels this model publishes, empty when it has no effort dial. */
    readonly efforts: readonly string[];
    /** Why it cannot be selected, when it cannot. */
    readonly unavailable?: "not in your pool";
}

export interface DialStripComposition {
    readonly slots: readonly DialSlot[];
    /** Slots beyond the cap, shown as a trailing ellipsis rather than dropped. */
    readonly overflow: number;
    /** Favourites whose name moved and can be rewritten in place. */
    readonly healed: readonly { readonly from: FavoritePair; readonly name: string }[];
}

/** How many slots fit on one line before the rest become an ellipsis. */
export const DIAL_STRIP_CAP = 6;

/**
 * The favourite as the pool answers it now, plus the name it should be
 * re-saved under when the name moved.
 *
 * Resolution order is name, then id, then stale. A pool reference resolves by
 * exact current-name equality and a rename replaces the stored name, so a
 * favourite that only had a name would go stale on every rename. Falling
 * through to the id and rewriting the name is what keeps that from happening
 * silently.
 */
export function resolveFavoritePair(
    favorite: FavoritePair,
    pool: readonly DialPoolEntry[],
): {
    readonly pair?: DialPair;
    readonly entry?: DialPoolEntry;
    readonly healedName?: string;
} {
    const byName = favorite.name === undefined
        ? undefined
        : pool.find((entry) => entry.poolName === favorite.name);
    if (byName !== undefined) {
        return { pair: pairOf(byName, favorite.effort), entry: byName };
    }
    const byId = favorite.provider === undefined || favorite.modelId === undefined
        ? undefined
        : pool.find((entry) =>
            entry.provider === favorite.provider
            && entry.model === favorite.modelId
        );
    if (byId !== undefined) {
        return {
            pair: pairOf(byId, favorite.effort),
            entry: byId,
            ...(byId.poolName === undefined || byId.poolName === favorite.name
                ? {}
                : { healedName: byId.poolName }),
        };
    }
    // An id-form favourite for a model that is not in the pool is still a
    // model: the pool is a shortlist, not a permission list.
    if (favorite.provider !== undefined && favorite.modelId !== undefined) {
        return {
            pair: {
                provider: favorite.provider,
                model: favorite.modelId,
                ...(favorite.effort === undefined
                    ? {}
                    : { effort: favorite.effort }),
            },
        };
    }
    return {};
}

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
    readonly favorites: readonly FavoritePair[];
    /** The session's model settings over time, oldest first. */
    readonly recents: readonly DialPair[];
    readonly pool: readonly DialPoolEntry[];
    readonly cap?: number;
}): DialStripComposition {
    const cap = options.cap ?? DIAL_STRIP_CAP;
    const slots: DialSlot[] = [];
    const healed: { from: FavoritePair; name: string }[] = [];
    const seen = new Set<string>();

    if (options.current !== undefined) {
        slots.push(slotFor(options.current, "current", options.pool));
        seen.add(pairKey(options.current));
    }
    for (const favorite of options.favorites) {
        const resolved = resolveFavoritePair(favorite, options.pool);
        if (resolved.healedName !== undefined) {
            healed.push({ from: favorite, name: resolved.healedName });
        }
        if (resolved.pair === undefined) {
            // Never deleted, never silently skipped: dimmed and unselectable,
            // so the user can see which favourite to fix.
            slots.push({
                label: favorite.name ?? favorite.modelId ?? "unknown",
                source: "favorite",
                efforts: [],
                unavailable: "not in your pool",
            });
            continue;
        }
        const key = pairKey(resolved.pair);
        if (seen.has(key)) continue;
        seen.add(key);
        slots.push({
            ...slotFor(resolved.pair, "favorite", options.pool),
            ...(resolved.healedName ?? favorite.name ?? resolved.entry?.poolName
                ? {
                    label: resolved.healedName
                        ?? resolved.entry?.poolName
                        ?? favorite.name
                        ?? shortModel(resolved.pair.model),
                }
                : {}),
        });
    }
    for (const pair of [...options.recents].reverse()) {
        const key = pairKey(pair);
        if (seen.has(key)) continue;
        seen.add(key);
        slots.push(slotFor(pair, "recent", options.pool));
    }
    const visible = slots.slice(0, cap);
    return {
        slots: visible,
        overflow: slots.length - visible.length,
        healed,
    };
}

/** Absent effort is its own value: a model with no dial has exactly one pair. */
export function pairKey(pair: DialPair): string {
    return `${pair.provider ?? ""}/${pair.model}/${pair.effort ?? ""}`;
}

function slotFor(
    pair: DialPair,
    source: DialSlotSource,
    pool: readonly DialPoolEntry[],
): DialSlot {
    const entry = pool.find((candidate) =>
        candidate.model === pair.model
        && (pair.provider === undefined || candidate.provider === pair.provider)
    );
    return {
        label: entry?.poolName ?? shortModel(pair.model),
        pair,
        source,
        efforts: entry?.levels ?? [],
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
     * dial. A favourite is never rewritten by this.
     */
    readonly editedEffort?: string;
    /** The pair the strip opened with, which is what escape puts back. */
    readonly opened?: DialPair;
}

export function openDialStrip(
    composition: DialStripComposition,
    current: DialPair | undefined,
): DialStripState {
    return {
        slots: composition.slots,
        overflow: composition.overflow,
        index: 0,
        ...(current === undefined ? {} : { opened: current }),
    };
}

/** Move the highlight. No wrap: the ends of the strip are ends. */
export function moveDialStrip(
    state: DialStripState,
    delta: number,
): DialStripState {
    const next = clamp(state.index + delta, 0, state.slots.length - 1);
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
    const currentEffort = state.editedEffort ?? slot.pair.effort;
    const at = currentEffort === undefined
        ? -1
        : slot.efforts.indexOf(currentEffort);
    const next = clamp(
        at < 0 ? (delta > 0 ? 0 : slot.efforts.length - 1) : at + delta,
        0,
        slot.efforts.length - 1,
    );
    return { ...state, editedEffort: slot.efforts[next]! };
}

/** The pair Enter would commit, or nothing when the row cannot be taken. */
export function dialStripSelection(
    state: DialStripState,
): DialPair | undefined {
    const slot = state.slots[state.index];
    if (slot?.pair === undefined) return undefined;
    const effort = state.editedEffort ?? slot.pair.effort;
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
): readonly string[] {
    const cells = state.slots.map((slot, index) => {
        const effort = index === state.index
            ? state.editedEffort ?? slot.pair?.effort
            : slot.pair?.effort;
        const label = effort === undefined
            ? slot.label
            : `${slot.label}·${effort}`;
        const numbered = `${index + 1} ${label}`;
        return index === state.index ? `[${numbered}]` : ` ${numbered} `;
    });
    const strip = `  dials  ${cells.join(" ")}${
        state.overflow > 0 ? "  …" : ""
    }`;
    const slot = state.slots[state.index];
    const note = slot === undefined
        ? "nothing to dial"
        : slot.pair === undefined
            ? `${slot.unavailable ?? "unavailable"}`
            : slot.efforts.length === 0
                ? "no effort dial"
                : hints;
    return [strip, `          ${note}`];
}

function clamp(value: number, low: number, high: number): number {
    return Math.max(low, Math.min(high, value));
}

/**
 * What a keypress means to the open strip.
 *
 * `type` is the primary exit and the reason the strip has no letter
 * navigation: whatever you type goes to the composer, with the pair you had
 * left alone. A vim user who rebinds letters onto movement knowingly gives up
 * type-to-commit for those letters.
 */
export type DialStripAction =
    | { readonly kind: "state"; readonly state: DialStripState }
    | { readonly kind: "commit"; readonly pair: DialPair }
    | { readonly kind: "cancel" }
    | { readonly kind: "type"; readonly text: string }
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
        return pair === undefined ? { kind: "ignore" } : { kind: "commit", pair };
    }
    switch (bindingId) {
        case "dials.pair.prev":
            return { kind: "state", state: moveDialStrip(state, -1) };
        case "dials.pair.next":
            return { kind: "state", state: moveDialStrip(state, 1) };
        case "dials.effort.up":
            return { kind: "state", state: adjustDialEffort(state, 1) };
        case "dials.effort.down":
            return { kind: "state", state: adjustDialEffort(state, -1) };
    }
    if (key.ctrl === true) {
        return { kind: "ignore" };
    }
    if (/^[1-9]$/.test(key.name)) {
        return { kind: "state", state: jumpDialStrip(state, Number(key.name)) };
    }
    const text = key.sequence ?? key.name;
    return [...text].length === 1 && text >= " "
        ? { kind: "type", text }
        : { kind: "ignore" };
}
