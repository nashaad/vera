import {
    mkdirSync,
    readFileSync,
    renameSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export const AUTH_STORAGE_SCHEMA_VERSION = 1;

interface StoredAuth {
    readonly schema_version: typeof AUTH_STORAGE_SCHEMA_VERSION;
    readonly tokens: Readonly<Record<string, string>>;
}

export interface AuthStorage {
    getToken(provider: string): string | undefined;
    setToken(provider: string, token: string): void;
}

export interface AuthStorageOptions {
    readonly path?: string;
}

export function defaultAuthStoragePath(): string {
    return join(homedir(), ".vera", "auth.json");
}

export function createAuthStorage(
    options: AuthStorageOptions = {},
): AuthStorage {
    const path = options.path ?? defaultAuthStoragePath();

    return {
        getToken(provider: string): string | undefined {
            const tokens = readStoredAuth(path).tokens;
            return Object.hasOwn(tokens, provider)
                ? tokens[provider]
                : undefined;
        },

        setToken(provider: string, token: string): void {
            const auth = readStoredAuth(path);
            writeStoredAuth(path, {
                schema_version: AUTH_STORAGE_SCHEMA_VERSION,
                tokens: {
                    ...auth.tokens,
                    [provider]: token,
                },
            });
        },
    };
}

function readStoredAuth(path: string): StoredAuth {
    let contents: string;
    try {
        contents = readFileSync(path, "utf8");
    } catch (error) {
        if (isMissingFileError(error)) {
            return emptyStoredAuth();
        }
        throw error;
    }

    const value: unknown = JSON.parse(contents);
    if (!isStoredAuth(value)) {
        throw new Error(`Invalid Vera auth storage at ${path}`);
    }
    return value;
}

function emptyStoredAuth(): StoredAuth {
    return {
        schema_version: AUTH_STORAGE_SCHEMA_VERSION,
        tokens: {},
    };
}

function isStoredAuth(value: unknown): value is StoredAuth {
    if (typeof value !== "object" || value === null) {
        return false;
    }

    const auth = value as Record<string, unknown>;
    if (
        auth.schema_version !== AUTH_STORAGE_SCHEMA_VERSION
        || typeof auth.tokens !== "object"
        || auth.tokens === null
        || Array.isArray(auth.tokens)
    ) {
        return false;
    }

    return Object.values(auth.tokens).every((token) =>
        typeof token === "string"
    );
}

function writeStoredAuth(path: string, auth: StoredAuth): void {
    const directoryPath = dirname(path);
    const temporaryPath = join(
        directoryPath,
        `.${basename(path)}.${randomUUID()}.tmp`,
    );

    mkdirSync(directoryPath, { recursive: true, mode: 0o700 });
    try {
        writeFileSync(temporaryPath, `${JSON.stringify(auth, null, 2)}\n`, {
            encoding: "utf8",
            flag: "wx",
            mode: 0o600,
        });
        renameSync(temporaryPath, path);
    } catch (error) {
        try {
            unlinkSync(temporaryPath);
        } catch {
            // The write may have failed before the temporary file existed.
        }
        throw error;
    }
}

function isMissingFileError(error: unknown): boolean {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
}
