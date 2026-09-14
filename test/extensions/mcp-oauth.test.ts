import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
    discoverAuthorization,
    freshAccessToken,
    loginServer,
    TokenStore,
} from "../../extensions/mcp/oauth.ts";
import { startOAuthFixture } from "./fixtures/mcp-oauth-http-server.ts";
import { startExtensionRegistry } from "../../src/extensions/registry.ts";
import { executeToolHandler } from "../../src/tools/execute.ts";
import { ToolRuntime } from "../../src/tools/runtime.ts";

const EXTENSION_DIRECTORY = fileURLToPath(
    new URL("../../extensions/mcp", import.meta.url),
);

const cleanups: (() => void)[] = [];
afterEach(() => {
    while (cleanups.length > 0) {
        cleanups.pop()!();
    }
});

function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "mcp-oauth-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
}

/** Stands in for the browser: follows the authorize redirect to the loopback. */
const headlessBrowser = async (url: string) => {
    await fetch(url);
};

test("discoverAuthorization walks the 401 metadata chain", async () => {
    const fixture = await startOAuthFixture();
    cleanups.push(fixture.close);
    const endpoints = await discoverAuthorization(fixture.url);
    const origin = new URL(fixture.url).origin;
    expect(endpoints).toEqual({
        authorizationEndpoint: `${origin}/authorize`,
        tokenEndpoint: `${origin}/token`,
        registrationEndpoint: `${origin}/register`,
        resource: fixture.url,
    });
});

test("loginServer registers, authorizes with PKCE, and stores the token", async () => {
    const fixture = await startOAuthFixture();
    cleanups.push(fixture.close);
    const store = new TokenStore(tempDir());
    const token = await loginServer({
        serverName: "fx",
        serverUrl: fixture.url,
        store,
        openUrl: headlessBrowser,
        timeoutMs: 5_000,
    });
    expect(fixture.issued.accessTokens).toEqual([token.accessToken]);
    expect(store.read("fx")?.accessToken).toBe(token.accessToken);
    expect(token.refreshToken).toBeDefined();
});

test("freshAccessToken refreshes an expired token silently", async () => {
    const fixture = await startOAuthFixture();
    cleanups.push(fixture.close);
    const store = new TokenStore(tempDir());
    const token = await loginServer({
        serverName: "fx",
        serverUrl: fixture.url,
        store,
        openUrl: headlessBrowser,
        timeoutMs: 5_000,
    });
    store.write("fx", { ...token, expiresAt: Date.now() - 1_000 });
    const refreshed = await freshAccessToken(store, "fx");
    expect(refreshed).toBeDefined();
    expect(refreshed).not.toBe(token.accessToken);
    expect(fixture.issued.refreshGrants).toBe(1);
    expect(store.read("fx")?.accessToken).toBe(refreshed!);

    expect(await freshAccessToken(store, "absent")).toBeUndefined();
});

test("registry skips a logged-out oauth server but offers /mcp-login, then loads it after login", async () => {
    const fixture = await startOAuthFixture();
    cleanups.push(fixture.close);
    const veraHome = tempDir();
    const previous = process.env.VERA_HOME;
    process.env.VERA_HOME = veraHome;
    cleanups.push(() => {
        if (previous === undefined) delete process.env.VERA_HOME;
        else process.env.VERA_HOME = previous;
    });
    const extensions = [{
        path: EXTENSION_DIRECTORY,
        enabled: true,
        config: { servers: { fx: { url: fixture.url, auth: "oauth" } } },
    }];

    const loggedOut = await startExtensionRegistry({
        extensions,
        onFailure: (failure) => {
            throw new Error(failure.message);
        },
    });
    try {
        expect(loggedOut.tools()).toEqual([]);
        expect(loggedOut.commands().map((command) => command.name))
            .toEqual(["mcp-login"]);
        const usage = await loggedOut.invokeCommand(
            "mcp-login",
            "nope",
            process.cwd(),
        );
        expect((usage.body as { text: string }).text).toContain("fx");
    } finally {
        await loggedOut.close();
    }

    const store = new TokenStore(join(veraHome, "machine", "extension-data", "vera.mcp"));
    await loginServer({
        serverName: "fx",
        serverUrl: fixture.url,
        store,
        openUrl: headlessBrowser,
        timeoutMs: 5_000,
    });
    const tokensFile = join(veraHome, "machine", "extension-data", "vera.mcp", "tokens.json");
    expect(readFileSync(tokensFile, "utf8")).toContain("accessToken");

    const loggedIn = await startExtensionRegistry({
        extensions,
        onFailure: (failure) => {
            throw new Error(failure.message);
        },
    });
    try {
        const tools = loggedIn.tools();
        expect(tools.map((tool) => tool.definition.name))
            .toEqual(["mcp_fx_echo", "mcp_resource"]);
        await expect(executeToolHandler(
            {
                type: "tool_call",
                id: "call-1",
                name: "mcp_fx_echo",
                input: { text: "bearer works" },
            },
            new ToolRuntime(process.cwd()),
            new AbortController().signal,
            tools,
        )).resolves.toMatchObject({
            kind: "output",
            output: "echo: bearer works",
        });
    } finally {
        await loggedIn.close();
    }
});
