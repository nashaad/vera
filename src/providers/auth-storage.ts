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

/**
 * How a provider is connected, not just that it is.
 *
 * The distinction is user-facing, not bookkeeping: the same provider can often
 * be reached either through a subscription the user already pays for or through
 * an API key billed per token. A connect pane that only knows "connected" cannot
 * say which of the two is about to be spent, cannot offer a disconnect that
 * means the right thing, and cannot tell the user a subscription has expired
 * rather than simply failing the next turn.
 *
 * An OAuth token stays an opaque string because its shape belongs to the
 * provider that minted it: Codex keeps its own versioned record in there. The
 * tag is what this file owns.
 */
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
    /** Forgets a provider's credential. A provider with none stored is a no-op. */
    deleteCredential(provider: string): void;
}

/** The OAuth token for a provider, absent when it is connected another way. */
export function oauthToken(
    storage: Pick<AuthStorage, "getCredential">,
    provider: string,
): string | undefined {
    const credential = storage.getCredential(provider);
    return credential?.type === "oauth" ? credential.token : undefined;
}

/**
 * A short stand-in for a provider's stored credential, safe to hold and compare.
 *
 * Hashed rather than kept whole so that a cache keyed on it never has the secret
 * itself sitting in a map key. It changes whenever the credential does, which is
 * the only property anything asks of it.
 */
export function credentialFingerprint(
    storage: Pick<AuthStorage, "getCredential">,
    provider: string,
): string | undefined {
    // Every provider lookup passes through here, including ones that need no
    // credential at all, so an unreadable store must not take them down with it.
    // The read that actually spends the credential still throws and says why.
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

/** The API key for a provider, absent when it is connected another way. */
export function apiKey(
    storage: Pick<AuthStorage, "getCredential">,
    provider: string,
): string | undefined {
    const credential = storage.getCredential(provider);
    return credential?.type === "api_key" ? credential.key : undefined;
}

export interface AuthStorageOptions {
    readonly path?: string;
    /**
     * Called with the new path when an unreadable store was moved aside.
     *
     * A callback rather than a log line, because the only place worth saying it
     * is wherever the user is looking when it happens.
     */
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
            // Rebuilt without the key rather than set to undefined: the read
            // side asks `Object.hasOwn`, which a present-but-undefined key
            // still answers yes to.
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

/**
 * The path of the store when it cannot be read, absent when it can.
 *
 * A missing file is readable: it means nothing is connected yet, which is where
 * everyone starts.
 */
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

/**
 * The credentials to merge into, with an unreadable file moved aside first.
 *
 * Reads already fail soft, so a broken store shows every provider as
 * unconnected. Letting the write fail too would leave the user staring at a pane
 * that says nothing is connected and refuses to connect anything, with no way
 * out but editing JSON by hand. Connecting a provider is the fix instead.
 *
 * Renamed rather than deleted: the file may hold a recoverable credential, and
 * it is not ours to throw away.
 */
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
        // The oldest shape was already tagged. Version 1 dropped the tag and
        // flattened everything to a string, so this reads as a restoration
        // rather than a new idea.
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

/**
 * Recover the tag version 1 threw away.
 *
 * Every writer of that shape stored a JSON record of OAuth tokens, so anything
 * that parses as an object is one. A bare string was never written by anything,
 * but reading it as an API key is the safe reading: keys are opaque strings and
 * OAuth records are not.
 */
function retagToken(token: string): StoredCredential {
    try {
        const value: unknown = JSON.parse(token);
        if (typeof value === "object" && value !== null) {
            return { type: "oauth", token };
        }
    } catch {
        // Not JSON, so not one of the OAuth records described above.
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

/** The version 1 shape: a provider to opaque string map, with the tag dropped. */
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
            // The write may have failed before the temporary file existed.
        }
        throw error;
    }
}

function isMissingFileError(error: unknown): boolean {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
}
