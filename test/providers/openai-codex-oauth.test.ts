import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { createAuthStorage } from "../../src/providers/auth-storage.ts";
import {
    loginOpenAICodex,
    readOpenAICodexCredentials,
    resolveOpenAICodexAuthorization,
} from "../../src/providers/openai-codex-oauth.ts";

describe("OpenAI Codex OAuth", () => {
    test("uses PKCE and persists the exchanged credentials", async () => {
        const path = temporaryAuthPath();
        const authStorage = createAuthStorage({ path });
        const accessToken = fakeJwt({ exp: 2_000 });
        const idToken = fakeJwt({
            "https://api.openai.com/auth": {
                chatgpt_account_id: "account-1",
            },
        });
        let expectedState = "";
        let authorizationUrl = "";
        let tokenRequest: RequestInit | undefined;

        const credentials = await loginOpenAICodex({
            authStorage,
            now: () => 1_000_000,
            startCallback: (state) => {
                expectedState = state;
                return {
                    redirectUri: "http://localhost:1455/auth/callback",
                    code: Promise.resolve("authorization-code"),
                    close() {},
                };
            },
            onAuthorizationUrl: (url) => authorizationUrl = url,
            openAuthorizationUrl: async () => {},
            fetch: (async (_input, init) => {
                tokenRequest = init;
                return Response.json({
                    access_token: accessToken,
                    refresh_token: "refresh-1",
                    id_token: idToken,
                    expires_in: 3600,
                });
            }) as typeof fetch,
        });

        const url = new URL(authorizationUrl);
        const body = new URLSearchParams(String(tokenRequest?.body));
        const verifier = body.get("code_verifier") ?? "";
        const expectedChallenge = createHash("sha256")
            .update(verifier)
            .digest("base64url");

        expect(url.origin + url.pathname).toBe(
            "https://auth.openai.com/oauth/authorize",
        );
        expect(url.searchParams.get("state")).toBe(expectedState);
        expect(url.searchParams.get("code_challenge")).toBe(expectedChallenge);
        expect(url.searchParams.get("code_challenge_method")).toBe("S256");
        expect(url.searchParams.get("redirect_uri")).toBe(
            "http://localhost:1455/auth/callback",
        );
        expect(body.get("code")).toBe("authorization-code");
        expect(credentials.account_id).toBe("account-1");
        expect(credentials.expires_at).toBe(2_000_000);

        const reloaded = readOpenAICodexCredentials(createAuthStorage({ path }));
        expect(reloaded).toEqual(credentials);
    });

    test("refreshes an expired token and preserves an omitted refresh token", async () => {
        const path = temporaryAuthPath();
        writeFileSync(path, JSON.stringify({
            "openai-codex": {
                type: "oauth",
                access: "expired",
                refresh: "refresh-1",
                expires: 1,
                accountId: "account-1",
            },
        }));
        const authStorage = createAuthStorage({ path });
        const refreshedAccess = fakeJwt({ exp: 3_000 });

        const authorization = await resolveOpenAICodexAuthorization({
            authStorage,
            now: () => 2_000_000,
            fetch: (async (_input, init) => {
                expect(JSON.parse(String(init?.body))).toEqual({
                    client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
                    grant_type: "refresh_token",
                    refresh_token: "refresh-1",
                });
                return Response.json({ access_token: refreshedAccess });
            }) as typeof fetch,
        });

        expect(authorization).toEqual({
            accessToken: refreshedAccess,
            accountId: "account-1",
        });
        expect(readOpenAICodexCredentials(authStorage)?.refresh_token).toBe(
            "refresh-1",
        );
    });

    test("shares one rotating-token refresh between concurrent requests", async () => {
        const authStorage = createAuthStorage({ path: temporaryAuthPath() });
        authStorage.setToken("openai-codex", JSON.stringify({
            schema_version: 1,
            access_token: "expired",
            refresh_token: "refresh-1",
            expires_at: 1,
        }));
        const refreshedAccess = fakeJwt({ exp: 3_000 });
        let refreshCount = 0;
        const fetchRequest = (async (
            _input: Parameters<typeof fetch>[0],
            _init?: Parameters<typeof fetch>[1],
        ) => {
            refreshCount += 1;
            await Bun.sleep(10);
            return Response.json({
                access_token: refreshedAccess,
                refresh_token: "refresh-2",
            });
        }) as unknown as typeof fetch;

        const results = await Promise.all([
            resolveOpenAICodexAuthorization({
                authStorage,
                fetch: fetchRequest,
                now: () => 2_000_000,
            }),
            resolveOpenAICodexAuthorization({
                authStorage,
                fetch: fetchRequest,
                now: () => 2_000_000,
            }),
        ]);

        expect(refreshCount).toBe(1);
        expect(results[0]?.accessToken).toBe(refreshedAccess);
        expect(results[1]?.accessToken).toBe(refreshedAccess);
        expect(readOpenAICodexCredentials(authStorage)?.refresh_token).toBe(
            "refresh-2",
        );
    });
});

function temporaryAuthPath(): string {
    return join(mkdtempSync(join(tmpdir(), "vera-codex-oauth-")), "auth.json");
}

function fakeJwt(payload: Record<string, unknown>): string {
    return [
        Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
        Buffer.from(JSON.stringify(payload)).toString("base64url"),
        "signature",
    ].join(".");
}
