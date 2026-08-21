import type { JsonValue } from "./contributions.ts";

/** A whole string value of exactly this shape resolves from the environment. */
const ENV_REFERENCE = /^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/;

export class EnvReferenceError extends Error {
    readonly extensionId: string;
    readonly variable: string;

    constructor(extensionId: string, variable: string, path: string) {
        super(
            `Extension ${extensionId} references ${variable} at config.${path}, `
            + `which is not set in the environment`,
        );
        this.name = "EnvReferenceError";
        this.extensionId = extensionId;
        this.variable = variable;
    }
}

/**
 * Replaces `{env:NAME}` values with what the environment holds. Only a string
 * that is entirely one reference resolves; a reference inside a longer string
 * is left alone, so a resolved value is never concatenated with anything.
 */
export function resolveEnvReferences(
    value: JsonValue,
    extensionId: string,
    env: Record<string, string | undefined> = process.env,
): JsonValue {
    return resolve(value, extensionId, env, "");
}

function resolve(
    value: JsonValue,
    extensionId: string,
    env: Record<string, string | undefined>,
    path: string,
): JsonValue {
    if (typeof value === "string") {
        const match = ENV_REFERENCE.exec(value);
        if (match === null) {
            return value;
        }
        const variable = match[1] as string;
        const resolved = env[variable];
        if (resolved === undefined || resolved.length === 0) {
            throw new EnvReferenceError(extensionId, variable, path);
        }
        return resolved;
    }
    if (Array.isArray(value)) {
        return value.map((entry, index) =>
            resolve(entry, extensionId, env, `${path}[${index}]`)
        );
    }
    if (typeof value === "object" && value !== null) {
        const resolved: Record<string, JsonValue> = {};
        for (const [key, entry] of Object.entries(value)) {
            resolved[key] = resolve(
                entry,
                extensionId,
                env,
                path === "" ? key : `${path}.${key}`,
            );
        }
        return resolved;
    }
    return value;
}
