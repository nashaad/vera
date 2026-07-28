import { createHash, randomBytes } from "node:crypto";

import {
    createAuthStorage,
    oauthToken,
    type AuthStorage,
} from "./auth-storage.ts";
import { UserFacingError } from "../user-facing-error.ts";

export const OPENAI_CODEX_PROVIDER_ID = "openai-codex";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTH_HOST = "https://auth.openai.com";
const CALLBACK_PATH = "/auth/callback";
const CALLBACK_PORTS = [1455, 1457] as const;
const REFRESH_SKEW_MS = 30_000;
const CREDENTIALS_SCHEMA_VERSION = 1;
const OAUTH_SCOPE = [
    "openid",
    "profile",
    "email",
    "offline_access",
].join(" ");
const refreshes = new WeakMap<
    AuthStorage,
    Promise<OpenAICodexCredentials>
>();

export interface OpenAICodexCredentials {
    readonly schema_version: typeof CREDENTIALS_SCHEMA_VERSION;
    readonly access_token: string;
    readonly refresh_token: string;
    readonly expires_at: number;
    readonly account_id?: string;
}

export interface OpenAICodexAuthorization {
    readonly accessToken: string;
    readonly accountId?: string;
}

export interface OpenAICodexCallback {
    readonly redirectUri: string;
    readonly code: Promise<string>;
    close(): void;
}

export interface OpenAICodexLoginOptions {
    readonly authStorage?: AuthStorage;
    readonly fetch?: typeof globalThis.fetch;
    readonly now?: () => number;
    readonly signal?: AbortSignal;
    readonly onAuthorizationUrl?: (url: string) => void;
    readonly openAuthorizationUrl?: (url: string) => Promise<void>;
    readonly startCallback?: (
        state: string,
        signal?: AbortSignal,
    ) => OpenAICodexCallback;
}

export interface OpenAICodexAuthorizationOptions {
    readonly authStorage?: AuthStorage;
    readonly fetch?: typeof globalThis.fetch;
    readonly now?: () => number;
}

interface OpenAICodexTokenResponse {
    readonly access_token: string;
    readonly refresh_token?: string;
    readonly id_token?: string;
    readonly expires_in?: number;
}

interface PkceCodes {
    readonly verifier: string;
    readonly challenge: string;
}

export async function loginOpenAICodex(
    options: OpenAICodexLoginOptions = {},
): Promise<OpenAICodexCredentials> {
    const authStorage = options.authStorage ?? createAuthStorage();
    const fetchRequest = options.fetch ?? globalThis.fetch;
    const now = options.now ?? Date.now;
    const state = base64Url(randomBytes(32));
    const pkce = generatePkce();
    const callback = (options.startCallback ?? startOpenAICodexCallback)(
        state,
        options.signal,
    );
    const authorizationUrl = buildAuthorizationUrl(
        callback.redirectUri,
        state,
        pkce.challenge,
    );

    options.onAuthorizationUrl?.(authorizationUrl);

    try {
        await (options.openAuthorizationUrl ?? openBrowser)(authorizationUrl);
        const code = await callback.code;
        const tokens = await exchangeAuthorizationCode(
            fetchRequest,
            callback.redirectUri,
            code,
            pkce.verifier,
        );
        const credentials = credentialsFromTokens(tokens, undefined, now());
        authStorage.setCredential(OPENAI_CODEX_PROVIDER_ID, {
            type: "oauth",
            token: JSON.stringify(credentials),
        });
        return credentials;
    } finally {
        callback.close();
    }
}

export async function resolveOpenAICodexAuthorization(
    options: OpenAICodexAuthorizationOptions = {},
): Promise<OpenAICodexAuthorization> {
    const authStorage = options.authStorage ?? createAuthStorage();
    const fetchRequest = options.fetch ?? globalThis.fetch;
    const now = options.now ?? Date.now;
    let credentials = readCredentials(authStorage);

    if (credentials === undefined) {
        throw new UserFacingError(
            "OpenAI Codex is not authenticated. Connect it from the model pane (ctrl+e).",
        );
    }

    if (credentials.expires_at <= now() + REFRESH_SKEW_MS) {
        credentials = await refreshExpiredCredentials(
            authStorage,
            fetchRequest,
            now,
        );
    }

    return {
        accessToken: credentials.access_token,
        ...(credentials.account_id === undefined
            ? {}
            : { accountId: credentials.account_id }),
    };
}

async function refreshExpiredCredentials(
    authStorage: AuthStorage,
    fetchRequest: typeof globalThis.fetch,
    now: () => number,
): Promise<OpenAICodexCredentials> {
    const activeRefresh = refreshes.get(authStorage);
    if (activeRefresh !== undefined) {
        return activeRefresh;
    }

    const refresh = (async () => {
        const latest = readCredentials(authStorage);
        if (latest === undefined) {
            throw new UserFacingError(
                "OpenAI Codex is not authenticated. Connect it from the model pane (ctrl+e).",
            );
        }
        const currentTime = now();
        if (latest.expires_at > currentTime + REFRESH_SKEW_MS) {
            return latest;
        }

        const refreshed = await refreshCredentials(
            fetchRequest,
            latest,
            currentTime,
        );
        authStorage.setCredential(OPENAI_CODEX_PROVIDER_ID, {
            type: "oauth",
            token: JSON.stringify(refreshed),
        });
        return refreshed;
    })();
    refreshes.set(authStorage, refresh);

    try {
        return await refresh;
    } finally {
        if (refreshes.get(authStorage) === refresh) {
            refreshes.delete(authStorage);
        }
    }
}

export function readOpenAICodexCredentials(
    authStorage: AuthStorage,
): OpenAICodexCredentials | undefined {
    return readCredentials(authStorage);
}

function generatePkce(): PkceCodes {
    const verifier = base64Url(randomBytes(64));
    const challenge = base64Url(
        createHash("sha256").update(verifier).digest(),
    );
    return { verifier, challenge };
}

function buildAuthorizationUrl(
    redirectUri: string,
    state: string,
    challenge: string,
): string {
    const query = new URLSearchParams({
        response_type: "code",
        client_id: CLIENT_ID,
        redirect_uri: redirectUri,
        scope: OAUTH_SCOPE,
        code_challenge: challenge,
        code_challenge_method: "S256",
        id_token_add_organizations: "true",
        codex_cli_simplified_flow: "true",
        state,
        originator: "vera",
    });
    return `${AUTH_HOST}/oauth/authorize?${query}`;
}

async function exchangeAuthorizationCode(
    fetchRequest: typeof globalThis.fetch,
    redirectUri: string,
    code: string,
    verifier: string,
): Promise<OpenAICodexTokenResponse> {
    return requestTokens(fetchRequest, {
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
            grant_type: "authorization_code",
            code,
            redirect_uri: redirectUri,
            client_id: CLIENT_ID,
            code_verifier: verifier,
        }).toString(),
    });
}

async function refreshCredentials(
    fetchRequest: typeof globalThis.fetch,
    current: OpenAICodexCredentials,
    now: number,
): Promise<OpenAICodexCredentials> {
    const tokens = await requestTokens(fetchRequest, {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            client_id: CLIENT_ID,
            grant_type: "refresh_token",
            refresh_token: current.refresh_token,
        }),
    });
    return credentialsFromTokens(tokens, current, now);
}

async function requestTokens(
    fetchRequest: typeof globalThis.fetch,
    init: Pick<RequestInit, "headers" | "body">,
): Promise<OpenAICodexTokenResponse> {
    const response = await fetchRequest(`${AUTH_HOST}/oauth/token`, {
        method: "POST",
        ...init,
    });
    if (!response.ok) {
        const detail = await response.text();
        throw new Error(
            `OpenAI Codex token request failed (${response.status}): ${detail}`,
        );
    }

    const value: unknown = await response.json();
    if (!isTokenResponse(value)) {
        throw new Error("OpenAI Codex returned an invalid token response");
    }
    return value;
}

function credentialsFromTokens(
    tokens: OpenAICodexTokenResponse,
    current: OpenAICodexCredentials | undefined,
    now: number,
): OpenAICodexCredentials {
    const refreshToken = tokens.refresh_token ?? current?.refresh_token;
    if (refreshToken === undefined) {
        throw new Error("OpenAI Codex token response omitted the refresh token");
    }

    const accountId = extractAccountId(tokens.id_token, tokens.access_token)
        ?? current?.account_id;
    return {
        schema_version: CREDENTIALS_SCHEMA_VERSION,
        access_token: tokens.access_token,
        refresh_token: refreshToken,
        expires_at: tokenExpiration(tokens.access_token)
            ?? now + (tokens.expires_in ?? 3600) * 1000,
        ...(accountId === undefined ? {} : { account_id: accountId }),
    };
}

function readCredentials(
    authStorage: AuthStorage,
): OpenAICodexCredentials | undefined {
    const stored = oauthToken(authStorage, OPENAI_CODEX_PROVIDER_ID);
    if (stored === undefined) {
        return undefined;
    }

    let value: unknown;
    try {
        value = JSON.parse(stored);
    } catch {
        throw new Error("Stored OpenAI Codex credentials are invalid JSON");
    }
    if (isLegacyCredentials(value)) {
        return {
            schema_version: CREDENTIALS_SCHEMA_VERSION,
            access_token: value.access,
            refresh_token: value.refresh,
            expires_at: value.expires,
            ...(value.accountId === undefined
                ? {}
                : { account_id: value.accountId }),
        };
    }
    if (!isCredentials(value)) {
        throw new Error("Stored OpenAI Codex credentials are invalid");
    }
    return value;
}

interface LegacyOpenAICodexCredentials {
    readonly type: "oauth";
    readonly access: string;
    readonly refresh: string;
    readonly expires: number;
    readonly accountId?: string;
}

function isLegacyCredentials(
    value: unknown,
): value is LegacyOpenAICodexCredentials {
    if (typeof value !== "object" || value === null) {
        return false;
    }
    const credentials = value as Record<string, unknown>;
    return credentials.type === "oauth"
        && typeof credentials.access === "string"
        && typeof credentials.refresh === "string"
        && typeof credentials.expires === "number"
        && (credentials.accountId === undefined
            || typeof credentials.accountId === "string");
}

function isCredentials(value: unknown): value is OpenAICodexCredentials {
    if (typeof value !== "object" || value === null) {
        return false;
    }
    const credentials = value as Record<string, unknown>;
    return credentials.schema_version === CREDENTIALS_SCHEMA_VERSION
        && typeof credentials.access_token === "string"
        && credentials.access_token.length > 0
        && typeof credentials.refresh_token === "string"
        && credentials.refresh_token.length > 0
        && typeof credentials.expires_at === "number"
        && Number.isFinite(credentials.expires_at)
        && (credentials.account_id === undefined
            || typeof credentials.account_id === "string");
}

function isTokenResponse(value: unknown): value is OpenAICodexTokenResponse {
    if (typeof value !== "object" || value === null) {
        return false;
    }
    const tokens = value as Record<string, unknown>;
    return typeof tokens.access_token === "string"
        && tokens.access_token.length > 0
        && (tokens.refresh_token === undefined
            || typeof tokens.refresh_token === "string")
        && (tokens.id_token === undefined || typeof tokens.id_token === "string")
        && (tokens.expires_in === undefined
            || typeof tokens.expires_in === "number");
}

function tokenExpiration(token: string): number | undefined {
    const payload = decodeJwtPayload(token);
    return typeof payload?.exp === "number" ? payload.exp * 1000 : undefined;
}

function extractAccountId(
    idToken: string | undefined,
    accessToken: string,
): string | undefined {
    for (const token of [idToken, accessToken]) {
        if (token === undefined) {
            continue;
        }
        const auth = decodeJwtPayload(token)?.["https://api.openai.com/auth"];
        if (typeof auth !== "object" || auth === null) {
            continue;
        }
        const accountId = (auth as Record<string, unknown>).chatgpt_account_id;
        if (typeof accountId === "string") {
            return accountId;
        }
    }
    return undefined;
}

function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
    const payload = token.split(".")[1];
    if (payload === undefined || payload.length === 0) {
        return undefined;
    }
    try {
        return JSON.parse(
            Buffer.from(payload, "base64url").toString("utf8"),
        ) as Record<string, unknown>;
    } catch {
        return undefined;
    }
}

function startOpenAICodexCallback(
    expectedState: string,
    signal?: AbortSignal,
): OpenAICodexCallback {
    let resolveCode!: (code: string) => void;
    let rejectCode!: (error: Error) => void;
    let settled = false;
    const code = new Promise<string>((resolve, reject) => {
        resolveCode = resolve;
        rejectCode = reject;
    });
    const settle = (value: string | Error): void => {
        if (settled) {
            return;
        }
        settled = true;
        if (value instanceof Error) {
            rejectCode(value);
        } else {
            resolveCode(value);
        }
    };

    let server: ReturnType<typeof Bun.serve> | undefined;
    for (const port of CALLBACK_PORTS) {
        try {
            server = Bun.serve({
                hostname: "127.0.0.1",
                port,
                fetch(request) {
                    const url = new URL(request.url);
                    if (url.pathname !== CALLBACK_PATH) {
                        return new Response("Not found", { status: 404 });
                    }
                    if (url.searchParams.get("state") !== expectedState) {
                        return new Response("State mismatch", { status: 400 });
                    }
                    const error = url.searchParams.get("error");
                    if (error !== null) {
                        settle(new Error(`OpenAI Codex login failed: ${error}`));
                        return new Response("Authentication failed", { status: 400 });
                    }
                    const authorizationCode = url.searchParams.get("code");
                    if (!authorizationCode) {
                        settle(new Error("OpenAI Codex callback omitted its code"));
                        return new Response("Missing authorization code", { status: 400 });
                    }

                    settle(authorizationCode);
                    return new Response(
                        "<!doctype html><title>Vera login complete</title>"
                            + "<h1>Vera login complete</h1>"
                            + "<p>You can close this tab.</p>",
                        { headers: { "Content-Type": "text/html; charset=utf-8" } },
                    );
                },
            });
            break;
        } catch {
            // Try the other callback port registered for the Codex client.
        }
    }
    if (server === undefined) {
        throw new Error("OpenAI Codex login callback ports 1455 and 1457 are busy");
    }

    const onAbort = (): void => {
        settle(toError(signal?.reason, "OpenAI Codex login canceled"));
    };
    if (signal?.aborted) {
        onAbort();
    } else {
        signal?.addEventListener("abort", onAbort, { once: true });
    }

    return {
        redirectUri: `http://localhost:${server.port}${CALLBACK_PATH}`,
        code,
        close(): void {
            signal?.removeEventListener("abort", onAbort);
            server.stop(true);
        },
    };
}

async function openBrowser(url: string): Promise<void> {
    const command = process.platform === "darwin"
        ? ["open", url]
        : process.platform === "win32"
            ? ["cmd", "/c", "start", "", url]
            : ["xdg-open", url];
    try {
        Bun.spawn(command, { stdout: "ignore", stderr: "ignore" });
    } catch {
        // The CLI prints the URL, so login can continue without a browser helper.
    }
}

function base64Url(value: Uint8Array): string {
    return Buffer.from(value).toString("base64url");
}

function toError(value: unknown, fallback: string): Error {
    if (value instanceof Error) {
        return value;
    }
    return new Error(value === undefined ? fallback : String(value));
}
