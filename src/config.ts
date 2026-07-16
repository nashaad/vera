import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const VERA_CONFIG_SCHEMA_VERSION = 1;

export interface VeraConfig {
    readonly schema_version: typeof VERA_CONFIG_SCHEMA_VERSION;
    readonly model: string;
}

export interface LoadVeraConfigOptions {
    readonly path?: string;
}

export function defaultVeraConfigPath(): string {
    return join(homedir(), ".vera", "config.json");
}

export function loadVeraConfig(
    options: LoadVeraConfigOptions = {},
): VeraConfig {
    const path = options.path ?? defaultVeraConfigPath();
    let source: string;

    try {
        source = readFileSync(path, "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            throw new Error(
                `Vera config not found at ${path}. Create it with schema_version 1 and a model string.`,
            );
        }
        throw error;
    }

    let value: unknown;
    try {
        value = JSON.parse(source);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Invalid JSON in Vera config at ${path}: ${message}`);
    }

    const config = parseVeraConfig(value);
    if (config === undefined) {
        throw new Error(
            `Invalid Vera config at ${path}: expected schema_version 1 and a non-empty model string.`,
        );
    }
    return config;
}

function parseVeraConfig(value: unknown): VeraConfig | undefined {
    if (typeof value !== "object" || value === null) {
        return undefined;
    }

    const config = value as Record<string, unknown>;
    if (
        config.schema_version !== VERA_CONFIG_SCHEMA_VERSION
        || typeof config.model !== "string"
        || config.model.trim().length === 0
    ) {
        return undefined;
    }

    return {
        schema_version: VERA_CONFIG_SCHEMA_VERSION,
        model: config.model.trim(),
    };
}
