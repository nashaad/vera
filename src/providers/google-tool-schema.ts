const GOOGLE_SCHEMA_FIELDS = new Set([
    "$defs",
    "$ref",
    "anyOf",
    "description",
    "enum",
    "format",
    "items",
    "nullable",
    "properties",
    "required",
    "type",
]);

export function normalizeGoogleToolSchema(
    schema: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
    return normalizeSchema(schema);
}

function normalizeSchema(schema: Readonly<Record<string, unknown>>): Record<string, unknown> {
    const normalized: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(schema)) {
        if (!GOOGLE_SCHEMA_FIELDS.has(key)) {
            continue;
        }
        if (key === "properties" || key === "$defs") {
            if (isRecord(value)) {
                normalized[key] = Object.fromEntries(
                    Object.entries(value)
                        .filter((entry): entry is [string, Record<string, unknown>] =>
                            isRecord(entry[1]))
                        .map(([name, property]) => [name, normalizeSchema(property)]),
                );
            }
            continue;
        }
        if (key === "items") {
            if (isRecord(value)) {
                normalized.items = normalizeSchema(value);
            }
            continue;
        }
        if (key === "anyOf") {
            if (Array.isArray(value)) {
                const variants = value.filter(isRecord);
                const acceptsNull = variants.some((variant) => variant.type === "null");
                const nonNullVariants = variants
                    .filter((variant) => variant.type !== "null")
                    .map((variant) => normalizeSchema(variant));
                if (nonNullVariants.length === 1) {
                    Object.assign(normalized, nonNullVariants[0]);
                } else if (nonNullVariants.length > 1) {
                    normalized.anyOf = nonNullVariants;
                }
                if (acceptsNull) {
                    normalized.nullable = true;
                }
            }
            continue;
        }
        if (key === "type" && Array.isArray(value)) {
            const types = value.filter((entry): entry is string => typeof entry === "string");
            const acceptsNull = types.includes("null");
            const nonNullTypes = types.filter((entry) => entry !== "null");
            if (nonNullTypes.length === 1) {
                normalized.type = nonNullTypes[0];
            } else if (nonNullTypes.length > 1) {
                normalized.anyOf = nonNullTypes.map((type) => ({ type }));
            }
            if (acceptsNull) {
                normalized.nullable = true;
            }
            continue;
        }
        if (key === "enum") {
            if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
                normalized.enum = value;
            }
            continue;
        }
        normalized[key] = value;
    }

    const properties = normalized.properties;
    if (Array.isArray(normalized.required) && isRecord(properties)) {
        normalized.required = normalized.required.filter((name) =>
            typeof name === "string" && Object.hasOwn(properties, name));
    }

    return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
