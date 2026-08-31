export interface TuiSingleLineEditorState {
    readonly value: string;
    /** JavaScript string index, always parked on a grapheme boundary. */
    readonly cursor: number;
}

export interface TuiSingleLineEditorKey {
    readonly name: string;
    readonly sequence?: string;
    readonly ctrl?: boolean;
    readonly meta?: boolean;
    readonly shift?: boolean;
    readonly super?: boolean;
    readonly hyper?: boolean;
}

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function startTuiSingleLineEditor(
    value = "",
): TuiSingleLineEditorState {
    return { value, cursor: value.length };
}

/** Insert plain single-line text at the caret. */
export function insertTuiSingleLineText(
    state: TuiSingleLineEditorState,
    text: string,
): TuiSingleLineEditorState {
    const inserted = text.replaceAll(new RegExp(CONTROL_CHARACTERS, "g"), "");
    if (inserted.length === 0) return state;
    return {
        value: state.value.slice(0, state.cursor)
            + inserted
            + state.value.slice(state.cursor),
        cursor: state.cursor + inserted.length,
    };
}

/**
 * Ordinary single-line editing. Submit, cancel, and vertical/list movement stay
 * with the surface that owns the field.
 */
export function handleTuiSingleLineEditorKey(
    state: TuiSingleLineEditorState,
    key: TuiSingleLineEditorKey,
): TuiSingleLineEditorState | undefined {
    if (key.ctrl || key.meta || key.super || key.hyper) return undefined;
    if (key.name === "left") {
        return { ...state, cursor: previousGraphemeStart(state.value, state.cursor) };
    }
    if (key.name === "right") {
        return { ...state, cursor: nextGraphemeEnd(state.value, state.cursor) };
    }
    if (key.name === "home") return { ...state, cursor: 0 };
    if (key.name === "end") return { ...state, cursor: state.value.length };
    if (key.name === "backspace") {
        const start = previousGraphemeStart(state.value, state.cursor);
        return start === state.cursor
            ? state
            : {
                value: state.value.slice(0, start)
                    + state.value.slice(state.cursor),
                cursor: start,
            };
    }
    if (key.name === "delete") {
        const end = nextGraphemeEnd(state.value, state.cursor);
        return end === state.cursor
            ? state
            : {
                value: state.value.slice(0, state.cursor)
                    + state.value.slice(end),
                cursor: state.cursor,
            };
    }
    const typed = key.sequence !== undefined && key.sequence.length > 0
        ? key.sequence
        : key.name === "space"
        ? " "
        : key.name.length === 1
        ? key.name
        : undefined;
    if (typed === undefined || CONTROL_CHARACTERS.test(typed)) return undefined;
    return insertTuiSingleLineText(state, typed);
}

/** Plain-text caret used by fields that do not park the terminal cursor. */
export function tuiSingleLineText(
    state: TuiSingleLineEditorState,
    caret: string,
): string {
    return state.value.slice(0, state.cursor)
        + caret
        + state.value.slice(state.cursor);
}

export function tuiSingleLineCaretColumn(
    state: TuiSingleLineEditorState,
): number {
    return Bun.stringWidth(state.value.slice(0, state.cursor));
}

function previousGraphemeStart(value: string, cursor: number): number {
    let previous = 0;
    for (const part of GRAPHEMES.segment(value)) {
        if (part.index >= cursor) break;
        previous = part.index;
    }
    return previous;
}

function nextGraphemeEnd(value: string, cursor: number): number {
    for (const part of GRAPHEMES.segment(value)) {
        if (part.index >= cursor) return part.index + part.segment.length;
    }
    return value.length;
}
