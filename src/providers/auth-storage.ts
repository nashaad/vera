import {
    mkdirSync,
    renameSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { veraMachineDirectory } from "../profile-paths.ts";
import { readRegularFileTextSync } from "../store/regular-file.ts";

export const AUTH_STORAGE_SCHEMA_VERSION = 2;

export type StoredCredential =
    | { readonly type: "oauth"; readonly token: string }
    | { readonly type: "api_key"; readonly key: string };

interface StoredAuth {
    readonly schema_version: typeof AUTH_STORAGE_SCHEMA_VERSION;
    readonly credentials: Readonly<Record<string, StoredCredential>>;
}

export interface AuthStorage {
    getCredential(provider: string): StoredCredential | undefined;
    setCredential(provider: string, credential: StoredCredential): void;
    deleteCredential(provider: string): void;
}

export function oauthToken(
    storage: Pick<AuthStorage, "getCredential">,
    provider: string,
): string | undefined {
    const credential = storage.getCredential(provider);
    return credential?.type === "oauth" ? credential.token : undefined;
}

export function credentialFingerprint(
    storage: Pick<AuthStorage, "getCredential">,
    provider: string,
): string | undefined {
    // Every provider lookup passes through here, including ones that need no credential at all, so an unreadable store must not take them down with it.
    let credential;
    try {
        credential = storage.getCredential(provider);
    } catch {
        return undefined;
    }
    if (credential === undefined) {
        return undefined;
    }
    const secret = credential.type === "oauth"
        ? credential.token
        : credential.key;
    return createHash("sha256")
        .update(`${credential.type}:${secret}`)
        .digest("hex")
        .slice(0, 16);
}

export function apiKey(
    storage: Pick<AuthStorage, "getCredential">,
    provider: string,
): string | undefined {
    const credential = storage.getCredential(provider);
    return credential?.type === "api_key" ? credential.key : undefined;
}

export interface AuthStorageOptions {
    readonly path?: string;
    readonly onQuarantine?: (quarantinePath: string) => void;
}

export function defaultAuthStoragePath(): string {
    return join(veraMachineDirectory(), "auth.json");
}

export function createAuthStorage(
    options: AuthStorageOptions = {},
): AuthStorage {
    const path = options.path ?? defaultAuthStoragePath();

    return {
        getCredential(provider: string): StoredCredential | undefined {
            const credentials = readStoredAuth(path).credentials;
            return Object.hasOwn(credentials, provider)
                ? credentials[provider]
                : undefined;
        },

        setCredential(provider: string, credential: StoredCredential): void {
            const auth = readForWrite(path, options.onQuarantine);
            writeStoredAuth(path, {
                schema_version: AUTH_STORAGE_SCHEMA_VERSION,
                credentials: {
                    ...auth.credentials,
                    [provider]: credential,
                },
            });
        },

        deleteCredential(provider: string): void {
            const auth = readForWrite(path, options.onQuarantine);
            const credentials: Record<string, StoredCredential> = {};
            for (const [id, credential] of Object.entries(auth.credentials)) {
                if (id !== provider) {
                    credentials[id] = credential;
                }
            }
            writeStoredAuth(path, {
                schema_version: AUTH_STORAGE_SCHEMA_VERSION,
                credentials,
            });
        },
    };
}

export function unreadableAuthStoragePath(
    options: AuthStorageOptions = {},
): string | undefined {
    const path = options.path ?? defaultAuthStoragePath();
    try {
        readStoredAuth(path);
        return undefined;
    } catch {
        return path;
    }
}

function readForWrite(
    path: string,
    onQuarantine?: (quarantinePath: string) => void,
): StoredAuth {
    try {
        return readStoredAuth(path);
    } catch {
        const quarantinePath = `${path}.corrupt-${
            new Date().toISOString().replaceAll(":", "-")
        }`;
        renameSync(path, quarantinePath);
        onQuarantine?.(quarantinePath);
        return emptyStoredAuth();
    }
}

function readStoredAuth(path: string): StoredAuth {
    let contents: string;
    try {
        contents = readRegularFileTextSync(path);
    } catch (error) {
        if (isMissingFileError(error)) {
            return emptyStoredAuth();
        }
        throw error;
    }

    const value: unknown = JSON.parse(contents);
    if (isStoredAuth(value)) {
        return value;
    }
    if (isUntaggedAuth(value)) {
        return {
            schema_version: AUTH_STORAGE_SCHEMA_VERSION,
            credentials: Object.fromEntries(
                Object.entries(value.tokens).map(([provider, token]) => [
                    provider,
                    retagToken(token),
                ]),
            ),
        };
    }
    if (isLegacyAuth(value)) {
        return {
            schema_version: AUTH_STORAGE_SCHEMA_VERSION,
            credentials: Object.fromEntries(
                Object.entries(value).map(([provider, credentials]) => [
                    provider,
                    credentials.type === "api_key"
                        ? { type: "api_key" as const, key: credentials.key }
                        : {
                            type: "oauth" as const,
                            token: JSON.stringify(credentials),
                        },
                ]),
            ),
        };
    }
    throw new Error(`Invalid Vera auth storage at ${path}`);
}

function retagToken(token: string): StoredCredential {
    try {
        const value: unknown = JSON.parse(token);
        if (typeof value === "object" && value !== null) {
            return { type: "oauth", token };
        }
    } catch {
    }
    return { type: "api_key", key: token };
}

function emptyStoredAuth(): StoredAuth {
    return {
        schema_version: AUTH_STORAGE_SCHEMA_VERSION,
        credentials: {},
    };
}

function isStoredAuth(value: unknown): value is StoredAuth {
    if (typeof value !== "object" || value === null) {
        return false;
    }

    const auth = value as Record<string, unknown>;
    if (
        auth.schema_version !== AUTH_STORAGE_SCHEMA_VERSION
        || typeof auth.credentials !== "object"
        || auth.credentials === null
        || Array.isArray(auth.credentials)
    ) {
        return false;
    }

    return Object.values(auth.credentials).every(isStoredCredential);
}

function isStoredCredential(value: unknown): value is StoredCredential {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
    }
    const credential = value as Record<string, unknown>;
    return credential.type === "oauth"
        ? typeof credential.token === "string"
        : credential.type === "api_key" && typeof credential.key === "string";
}

function isUntaggedAuth(
    value: unknown,
): value is { readonly tokens: Readonly<Record<string, string>> } {
    if (typeof value !== "object" || value === null) {
        return false;
    }
    const auth = value as Record<string, unknown>;
    if (
        auth.schema_version !== 1
        || typeof auth.tokens !== "object"
        || auth.tokens === null
        || Array.isArray(auth.tokens)
    ) {
        return false;
    }
    return Object.values(auth.tokens).every((token) => typeof token === "string");
}

function isLegacyAuth(
    value: unknown,
): value is Readonly<Record<string, LegacyCredentials>> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
    }
    return Object.values(value).every(isLegacyCredentials);
}

interface LegacyApiKeyCredentials {
    readonly type: "api_key";
    readonly key: string;
}

interface LegacyOAuthCredentials {
    readonly type: "oauth";
    readonly access: string;
    readonly refresh: string;
    readonly expires: number;
    readonly accountId?: string;
}

type LegacyCredentials = LegacyApiKeyCredentials | LegacyOAuthCredentials;

function isLegacyCredentials(value: unknown): value is LegacyCredentials {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
    }
    const credentials = value as Record<string, unknown>;
    if (credentials.type === "api_key") {
        return typeof credentials.key === "string";
    }
    return credentials.type === "oauth"
        && typeof credentials.access === "string"
        && typeof credentials.refresh === "string"
        && typeof credentials.expires === "number"
        && (credentials.accountId === undefined
            || typeof credentials.accountId === "string");
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
        }
        throw error;
    }
}

function isMissingFileError(error: unknown): boolean {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
}
