/**
 * The status line's extension surface speaks in semantic segments, never in
 * finished strings. An extension says which fact a segment carries; each
 * client decides the wording, order on screen, truncation, and colour. A
 * client that renders a kind it does not know skips it rather than inventing
 * text for it.
 */

export const STATUS_LINE_SNAPSHOT_VERSION = 1;

export type StatusLineTurnState = "idle" | "working" | "waiting";

export interface StatusLineModelFacts {
    readonly provider?: string;
    readonly model: string;
    readonly reasoningEffort?: string;
}

export interface StatusLineContextFacts {
    readonly tokens: number;
    /** Absent while the model's window is unknown, so no share can be shown. */
    readonly capacity?: number;
    /** True while Vera is counting characters instead of provider totals. */
    readonly estimated: boolean;
}

/**
 * Everything the client knows when the status line repaints. The renderer is
 * called with this and returns segments; there is no push channel and no
 * subscription, so a renderer never holds state the client has already moved
 * past.
 */
export interface StatusLineSnapshot {
    readonly version: typeof STATUS_LINE_SNAPSHOT_VERSION;
    readonly turn: StatusLineTurnState;
    readonly workspace: string;
    readonly runningBackgroundAgents: number;
    readonly model?: StatusLineModelFacts;
    readonly approvalMode?: string;
    readonly context?: StatusLineContextFacts;
}

export interface ModelStatusSegment {
    readonly kind: "model";
    readonly provider?: string;
    readonly model: string;
    readonly reasoningEffort?: string;
}

export interface ContextStatusSegment {
    readonly kind: "context";
    readonly tokens: number;
    readonly capacity?: number;
    readonly estimated?: boolean;
}

export interface PermissionsStatusSegment {
    readonly kind: "permissions";
    readonly mode: string;
}

export interface WorkspaceStatusSegment {
    readonly kind: "workspace";
    readonly path: string;
}

export interface BackgroundAgentsStatusSegment {
    readonly kind: "background_agents";
    readonly running: number;
}

export interface TurnStatusSegment {
    readonly kind: "turn";
    readonly state: StatusLineTurnState;
}

/**
 * The escape hatch for a fact Vera has no vocabulary for. The text is the
 * extension's own words, so a client may shorten or drop it, but it must not
 * be used to hand-format facts that already have a kind.
 */
export interface NoteStatusSegment {
    readonly kind: "note";
    readonly text: string;
    readonly tone?: "info" | "warning" | "error";
}

export type StatusLineSegment =
    | ModelStatusSegment
    | ContextStatusSegment
    | PermissionsStatusSegment
    | WorkspaceStatusSegment
    | BackgroundAgentsStatusSegment
    | TurnStatusSegment
    | NoteStatusSegment;

export const MAX_STATUS_LINE_SEGMENTS = 16;

/**
 * Strict on purpose. A renderer runs inside the repaint, so garbage cannot be
 * repaired later: anything that does not parse makes the whole return value
 * invalid and the client falls back to its own rendering.
 */
export function parseStatusLineSegments(
    value: unknown,
): readonly StatusLineSegment[] | undefined {
    if (!Array.isArray(value) || value.length > MAX_STATUS_LINE_SEGMENTS) {
        return undefined;
    }
    const segments: StatusLineSegment[] = [];
    for (const candidate of value) {
        const segment = parseStatusLineSegment(candidate);
        if (segment === undefined) {
            return undefined;
        }
        segments.push(segment);
    }
    return segments;
}

export function parseStatusLineSegment(
    value: unknown,
): StatusLineSegment | undefined {
    if (!isPlainObject(value)) {
        return undefined;
    }
    switch (value.kind) {
        case "model":
            return parseModelSegment(value);
        case "context":
            return parseContextSegment(value);
        case "permissions":
            return hasKeys(value, ["kind", "mode"])
                    && isText(value.mode)
                ? { kind: "permissions", mode: value.mode }
                : undefined;
        case "workspace":
            return hasKeys(value, ["kind", "path"])
                    && isText(value.path)
                ? { kind: "workspace", path: value.path }
                : undefined;
        case "background_agents":
            return hasKeys(value, ["kind", "running"])
                    && isCount(value.running)
                ? { kind: "background_agents", running: value.running }
                : undefined;
        case "turn":
            return hasKeys(value, ["kind", "state"])
                    && isTurnState(value.state)
                ? { kind: "turn", state: value.state }
                : undefined;
        case "note":
            return parseNoteSegment(value);
        default:
            return undefined;
    }
}

function parseModelSegment(
    value: Record<string, unknown>,
): ModelStatusSegment | undefined {
    if (
        !hasKeys(value, ["kind", "model"], ["provider", "reasoningEffort"])
        || !isText(value.model)
        || !isOptionalText(value.provider)
        || !isOptionalText(value.reasoningEffort)
    ) {
        return undefined;
    }
    return {
        kind: "model",
        model: value.model,
        ...(value.provider === undefined ? {} : { provider: value.provider }),
        ...(value.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: value.reasoningEffort }),
    };
}

function parseContextSegment(
    value: Record<string, unknown>,
): ContextStatusSegment | undefined {
    if (
        !hasKeys(value, ["kind", "tokens"], ["capacity", "estimated"])
        || !isCount(value.tokens)
        || (value.capacity !== undefined
            && !(isCount(value.capacity) && value.capacity > 0))
        || (value.estimated !== undefined && typeof value.estimated !== "boolean")
    ) {
        return undefined;
    }
    return {
        kind: "context",
        tokens: value.tokens,
        ...(value.capacity === undefined ? {} : { capacity: value.capacity }),
        ...(value.estimated === undefined
            ? {}
            : { estimated: value.estimated }),
    };
}

function parseNoteSegment(
    value: Record<string, unknown>,
): NoteStatusSegment | undefined {
    if (
        !hasKeys(value, ["kind", "text"], ["tone"])
        || !isText(value.text)
        || (value.tone !== undefined && !isTone(value.tone))
    ) {
        return undefined;
    }
    return {
        kind: "note",
        text: value.text,
        ...(value.tone === undefined ? {} : { tone: value.tone }),
    };
}

function isTurnState(value: unknown): value is StatusLineTurnState {
    return value === "idle" || value === "working" || value === "waiting";
}

function isTone(value: unknown): value is NoteStatusSegment["tone"] {
    return value === "info" || value === "warning" || value === "error";
}

function isText(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0;
}

function isOptionalText(value: unknown): value is string | undefined {
    return value === undefined || isText(value);
}

function isCount(value: unknown): value is number {
    return typeof value === "number"
        && Number.isFinite(value)
        && Number.isInteger(value)
        && value >= 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object"
        && value !== null
        && !Array.isArray(value);
}

function hasKeys(
    value: Record<string, unknown>,
    required: readonly string[],
    optional: readonly string[] = [],
): boolean {
    if (!required.every((key) => Object.hasOwn(value, key))) {
        return false;
    }
    const allowed = new Set([...required, ...optional]);
    return Object.keys(value).every((key) => allowed.has(key));
}
