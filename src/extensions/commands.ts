export const EXTENSION_COMMAND_RESULT_VERSION = 1;

export interface ExtensionCommandNoticeBody {
    readonly kind: "notice";
    readonly level: "info" | "warning" | "error";
    readonly text: string;
}

export interface ExtensionCommandTextBody {
    readonly kind: "text";
    readonly text: string;
}

export type ExtensionCommandBody =
    | ExtensionCommandNoticeBody
    | ExtensionCommandTextBody;

export interface ExtensionCommandResult {
    readonly version: typeof EXTENSION_COMMAND_RESULT_VERSION;
    readonly source: string;
    readonly body: ExtensionCommandBody;
}

export interface ExtensionCommandDescriptor {
    readonly name: string;
    readonly description: string;
    readonly usage: string;
    readonly source: string;
}

export interface ExtensionCommandDeclaration {
    readonly handlerId: string;
    readonly kind: "command";
    readonly name: string;
    readonly spec: {
        readonly description: string;
        readonly usage: string;
    };
}

export function parseExtensionCommandBody(
    value: unknown,
): ExtensionCommandBody | undefined {
    if (!isPlainObject(value)) {
        return undefined;
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

export function parseExtensionCommandDeclarations(
    value: unknown,
): readonly ExtensionCommandDeclaration[] | undefined {
    if (!Array.isArray(value)) {
        return undefined;
    }
    const declarations: ExtensionCommandDeclaration[] = [];
    const names = new Set<string>();
    const handlerIds = new Set<string>();
    for (const item of value) {
        const declaration = parseDeclaration(item);
        if (
            declaration === undefined
            || names.has(declaration.name)
            || handlerIds.has(declaration.handlerId)
        ) {
            return undefined;
        }
        names.add(declaration.name);
        handlerIds.add(declaration.handlerId);
        declarations.push(declaration);
    }
    return declarations;
}

export function isExtensionCommandName(value: string): boolean {
    return /^[a-z][a-z0-9-]*$/.test(value);
}

function parseDeclaration(
    value: unknown,
): ExtensionCommandDeclaration | undefined {
    if (
        !isPlainObject(value)
        || !hasExactKeys(
            value,
            ["handlerId", "kind", "name", "spec"],
        )
        || typeof value.handlerId !== "string"
        || value.handlerId.length === 0
        || value.kind !== "command"
        || typeof value.name !== "string"
        || !isExtensionCommandName(value.name)
        || !isPlainObject(value.spec)
        || !hasExactKeys(value.spec, ["description", "usage"])
        || !isNonEmptyText(value.spec.description)
        || !isNonEmptyText(value.spec.usage)
    ) {
        return undefined;
    }
    return {
        handlerId: value.handlerId,
        kind: "command",
        name: value.name,
        spec: {
            description: value.spec.description,
            usage: value.spec.usage,
        },
    };
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
