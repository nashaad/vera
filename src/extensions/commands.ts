export const EXTENSION_COMMAND_RESULT_VERSION = 1;
/**
 * Names an extension cannot take, because a client surface answers to them
 * first: `/help` is the bundled help extension, `/palette` and `/settings` are
 * client built-ins. Taking one would be silently shadowed rather than
 * overriding, so the registry refuses the extension at load instead.
 */
export const RESERVED_EXTENSION_COMMAND_NAMES = [
    "help",
    "palette",
    "settings",
] as const;

export interface ExtensionCommandNoticeBody {
    readonly kind: "notice";
    readonly level: "info" | "warning" | "error";
    readonly text: string;
}

export interface ExtensionCommandTextBody {
    readonly kind: "text";
    readonly text: string;
}

/** The command already rendered its result into a client-owned surface. */
export interface ExtensionCommandHandledBody {
    readonly kind: "handled";
}

export type ExtensionCommandBody =
    | ExtensionCommandNoticeBody
    | ExtensionCommandTextBody
    | ExtensionCommandHandledBody;

export interface ExtensionCommandResult {
    readonly version: typeof EXTENSION_COMMAND_RESULT_VERSION;
    readonly source: string;
    readonly body: ExtensionCommandBody;
}

/**
 * What a command's first argument names, so a client can complete it. Only
 * `model` today: the client owns the pool, the extension only says it wants a
 * model there.
 */
export type ExtensionCommandArgumentKind = "model" | "mention";

export interface ExtensionCommandDescriptor {
    readonly name: string;
    readonly description: string;
    readonly usage: string;
    readonly source: string;
    readonly arguments?: ExtensionCommandArgumentKind;
}

export function isExtensionCommandArgumentKind(
    value: unknown,
): value is ExtensionCommandArgumentKind {
    return value === "model" || value === "mention";
}

export class ExtensionCommandUnavailableError extends Error {}

export class InvalidExtensionCommandResultError extends Error {}

export function parseExtensionCommandBody(
    value: unknown,
): ExtensionCommandBody | undefined {
    if (!isPlainObject(value)) {
        return undefined;
    }
    if (
        value.kind === "handled"
        && hasExactKeys(value, ["kind"])
    ) {
        return { kind: "handled" };
    }
    if (
        value.kind === "text"
        && hasExactKeys(value, ["kind", "text"])
        && isNonEmptyText(value.text)
    ) {
        return {
            kind: "text",
            text: value.text,
        };
    }
    if (
        value.kind === "notice"
        && hasExactKeys(value, ["kind", "level", "text"])
        && isNoticeLevel(value.level)
        && isNonEmptyText(value.text)
    ) {
        return {
            kind: "notice",
            level: value.level,
            text: value.text,
        };
    }
    return undefined;
}

export function parseExtensionCommandResult(
    value: unknown,
): ExtensionCommandResult | undefined {
    if (
        !isPlainObject(value)
        || !hasExactKeys(value, ["version", "source", "body"])
        || value.version !== EXTENSION_COMMAND_RESULT_VERSION
        || typeof value.source !== "string"
        || value.source.length === 0
    ) {
        return undefined;
    }
    const body = parseExtensionCommandBody(value.body);
    if (body === undefined) {
        return undefined;
    }
    return {
        version: EXTENSION_COMMAND_RESULT_VERSION,
        source: value.source,
        body,
    };
}

export function isExtensionCommandName(value: string): boolean {
    return /^[a-z][a-z0-9-]*$/.test(value);
}

function isNoticeLevel(
    value: unknown,
): value is ExtensionCommandNoticeBody["level"] {
    return value === "info" || value === "warning" || value === "error";
}

function isNonEmptyText(
    value: unknown,
): value is string {
    return typeof value === "string" && value.trim().length > 0;
}

function isPlainObject(
    value: unknown,
): value is Record<string, unknown> {
    return typeof value === "object"
        && value !== null
        && !Array.isArray(value);
}

function hasExactKeys(
    value: Record<string, unknown>,
    keys: readonly string[],
): boolean {
    const actual = Object.keys(value);
    return actual.length === keys.length
        && keys.every((key) => Object.hasOwn(value, key));
}
