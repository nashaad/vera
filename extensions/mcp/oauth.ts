import { spawn } from "node:child_process";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";

export interface AuthorizationEndpoints {
    readonly authorizationEndpoint: string;
    readonly tokenEndpoint: string;
    readonly registrationEndpoint?: string;
    readonly resource: string;
}

export interface StoredToken {
    readonly accessToken: string;
    readonly refreshToken?: string;
    readonly expiresAt?: number;
    readonly tokenEndpoint: string;
    readonly clientId: string;
    readonly resource: string;
}

export class McpOAuthError extends Error {}

const TOKENS_FILE = "tokens.json";

export class TokenStore {
    private readonly path: string;

    constructor(storageDirectory: string) {
        this.path = join(storageDirectory, TOKENS_FILE);
    }

    read(server: string): StoredToken | undefined {
        return this.readAll()[server];
    }

    write(server: string, token: StoredToken): void {
        const all = this.readAll();
        all[server] = token;
        writeFileSync(this.path, `${JSON.stringify(all, null, 2)}\n`);
        chmodSync(this.path, 0o600);
    }

    private readAll(): Record<string, StoredToken> {
        try {
            return JSON.parse(readFileSync(this.path, "utf8")) as Record<
                string,
                StoredToken
            >;
        } catch {
            return {};
        }
    }
}

export async function discoverAuthorization(
    url: string,
    signal?: AbortSignal,
): Promise<AuthorizationEndpoints> {
    const probe = await fetch(url, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize" }),
        signal: signal ?? null,
    });
    const metadataUrls: string[] = [];
    const challenge = probe.headers.get("www-authenticate") ?? "";
    const named = /resource_metadata="([^"]+)"/.exec(challenge);
    if (named !== null) {
        metadataUrls.push(named[1]!);
    }
    const parsed = new URL(url);
    metadataUrls.push(
        `${parsed.origin}/.well-known/oauth-protected-resource${parsed.pathname.replace(/\/$/, "")}`,
        `${parsed.origin}/.well-known/oauth-protected-resource`,
    );
    const resourceMetadata = await firstJson(metadataUrls, signal) as {
        resource?: unknown;
        authorization_servers?: readonly unknown[];
    } | undefined;
    const authorizationServer = resourceMetadata?.authorization_servers?.[0];
    if (typeof authorizationServer !== "string") {
        throw new McpOAuthError(
            `no authorization server discovered for ${url}`,
        );
    }
    const asUrl = new URL(authorizationServer);
    const serverMetadata = await firstJson([
        `${asUrl.origin}/.well-known/oauth-authorization-server${asUrl.pathname.replace(/\/$/, "")}`,
        `${asUrl.origin}/.well-known/oauth-authorization-server`,
    ], signal) as {
        authorization_endpoint?: unknown;
        token_endpoint?: unknown;
        registration_endpoint?: unknown;
    } | undefined;
    if (
        typeof serverMetadata?.authorization_endpoint !== "string"
        || typeof serverMetadata.token_endpoint !== "string"
    ) {
        throw new McpOAuthError(
            `authorization server ${authorizationServer} has no usable metadata`,
        );
    }
    return {
        authorizationEndpoint: serverMetadata.authorization_endpoint,
        tokenEndpoint: serverMetadata.token_endpoint,
        ...(typeof serverMetadata.registration_endpoint === "string"
            ? { registrationEndpoint: serverMetadata.registration_endpoint }
            : {}),
        resource: typeof resourceMetadata?.resource === "string"
            ? resourceMetadata.resource
            : url,
    };
}

export interface LoginOptions {
    readonly serverName: string;
    readonly serverUrl: string;
    readonly store: TokenStore;
    readonly clientId?: string;
    readonly openUrl?: (url: string) => void | Promise<void>;
    readonly timeoutMs?: number;
    readonly signal?: AbortSignal;
}

export async function loginServer(options: LoginOptions): Promise<StoredToken> {
    const endpoints = await discoverAuthorization(
        options.serverUrl,
        options.signal,
    );
    const { server, redirectUri, code } = await waitForCallback(
        options.timeoutMs ?? 300_000,
    );
    try {
        const clientId = options.clientId
            ?? await registerClient(endpoints, redirectUri, options.signal);
        const verifier = randomToken();
        const state = randomToken();
        const authorizeUrl = new URL(endpoints.authorizationEndpoint);
        authorizeUrl.search = new URLSearchParams({
            response_type: "code",
            client_id: clientId,
            redirect_uri: redirectUri,
            state,
            code_challenge: await pkceChallenge(verifier),
            code_challenge_method: "S256",
            resource: endpoints.resource,
        }).toString();
        await (options.openUrl ?? openInBrowser)(authorizeUrl.toString());
        const callback = await code;
        if (callback.state !== state) {
            throw new McpOAuthError("authorization state mismatch");
        }
        const token = await exchangeToken(endpoints.tokenEndpoint, {
            grant_type: "authorization_code",
            code: callback.code,
            redirect_uri: redirectUri,
            client_id: clientId,
            code_verifier: verifier,
            resource: endpoints.resource,
        }, clientId, endpoints.resource, options.signal);
        options.store.write(options.serverName, token);
        return token;
    } finally {
        server.close();
    }
}

export async function freshAccessToken(
    store: TokenStore,
    serverName: string,
    signal?: AbortSignal,
): Promise<string | undefined> {
    const token = store.read(serverName);
    if (token === undefined) {
        return undefined;
    }
    const expired = token.expiresAt !== undefined
        && token.expiresAt <= Date.now() + 30_000;
    if (!expired) {
        return token.accessToken;
    }
    if (token.refreshToken === undefined) {
        return undefined;
    }
    try {
        const refreshed = await exchangeToken(token.tokenEndpoint, {
            grant_type: "refresh_token",
            refresh_token: token.refreshToken,
            client_id: token.clientId,
            resource: token.resource,
        }, token.clientId, token.resource, signal);
        store.write(serverName, {
            ...refreshed,
            refreshToken: refreshed.refreshToken ?? token.refreshToken,
        });
        return refreshed.accessToken;
    } catch {
        return undefined;
    }
}

async function registerClient(
    endpoints: AuthorizationEndpoints,
    redirectUri: string,
    signal?: AbortSignal,
): Promise<string> {
    if (endpoints.registrationEndpoint === undefined) {
        throw new McpOAuthError(
            "server does not offer dynamic client registration; configure clientId",
        );
    }
    const response = await fetch(endpoints.registrationEndpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            client_name: "vera-mcp",
            redirect_uris: [redirectUri],
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
            token_endpoint_auth_method: "none",
        }),
        signal: signal ?? null,
    });
    if (!response.ok) {
        throw new McpOAuthError(
            `client registration failed with HTTP ${response.status}`,
        );
    }
    const body = await response.json() as { client_id?: unknown };
    if (typeof body.client_id !== "string") {
        throw new McpOAuthError("client registration returned no client_id");
    }
    return body.client_id;
}

async function exchangeToken(
    tokenEndpoint: string,
    form: Record<string, string>,
    clientId: string,
    resource: string,
    signal?: AbortSignal,
): Promise<StoredToken> {
    const response = await fetch(tokenEndpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(form).toString(),
        signal: signal ?? null,
    });
    if (!response.ok) {
        throw new McpOAuthError(
            `token request failed with HTTP ${response.status}`,
        );
    }
    const body = await response.json() as {
        access_token?: unknown;
        refresh_token?: unknown;
        expires_in?: unknown;
    };
    if (typeof body.access_token !== "string") {
        throw new McpOAuthError("token response carried no access_token");
    }
    return {
        accessToken: body.access_token,
        ...(typeof body.refresh_token === "string"
            ? { refreshToken: body.refresh_token }
            : {}),
        ...(typeof body.expires_in === "number"
            ? { expiresAt: Date.now() + body.expires_in * 1000 }
            : {}),
        tokenEndpoint,
        clientId,
        resource,
    };
}

async function firstJson(
    urls: readonly string[],
    signal?: AbortSignal,
): Promise<unknown> {
    for (const url of urls) {
        try {
            const response = await fetch(url, { signal: signal ?? null });
            if (response.ok) {
                return await response.json();
            }
        } catch {
            continue;
        }
    }
    return undefined;
}

interface CallbackWaiter {
    readonly server: Server;
    readonly redirectUri: string;
    readonly code: Promise<{ code: string; state: string }>;
}

function waitForCallback(timeoutMs: number): Promise<CallbackWaiter> {
    return new Promise((resolveWaiter, rejectWaiter) => {
        let settle: (result: { code: string; state: string }) => void;
        let fail: (error: Error) => void;
        const code = new Promise<{ code: string; state: string }>(
            (resolve, reject) => {
                settle = resolve;
                fail = reject;
            },
        );
        const server = createServer((request, response) => {
            const url = new URL(request.url ?? "/", "http://127.0.0.1");
            if (url.pathname !== "/callback") {
                response.writeHead(404).end();
                return;
            }
            const authCode = url.searchParams.get("code");
            const state = url.searchParams.get("state");
            if (authCode === null || state === null) {
                response.writeHead(400).end("Missing code or state.");
                fail(new McpOAuthError(
                    url.searchParams.get("error_description")
                        ?? url.searchParams.get("error")
                        ?? "authorization was denied",
                ));
                return;
            }
            response
                .writeHead(200, { "content-type": "text/plain" })
                .end("Login complete. You can close this tab.");
            settle({ code: authCode, state });
        });
        const timer = setTimeout(() => {
            fail(new McpOAuthError("login timed out"));
            server.close();
        }, timeoutMs);
        code.finally(() => clearTimeout(timer)).catch(() => {});
        server.on("error", rejectWaiter);
        server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            if (address === null || typeof address === "string") {
                rejectWaiter(new McpOAuthError("loopback listener failed"));
                return;
            }
            resolveWaiter({
                server,
                redirectUri: `http://127.0.0.1:${address.port}/callback`,
                code,
            });
        });
    });
}

function openInBrowser(url: string): void {
    const command = process.platform === "darwin" ? "open" : "xdg-open";
    spawn(command, [url], { stdio: "ignore", detached: true }).unref();
}

function randomToken(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    return base64Url(bytes);
}

async function pkceChallenge(verifier: string): Promise<string> {
    const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(verifier),
    );
    return base64Url(new Uint8Array(digest));
}

function base64Url(bytes: Uint8Array): string {
    return Buffer.from(bytes)
        .toString("base64")
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replaceAll("=", "");
}
