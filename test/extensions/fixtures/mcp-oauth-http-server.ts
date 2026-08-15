// In-process fixture combining a streamable-HTTP MCP server and a minimal
// OAuth 2.1 authorization server: protected resource metadata, authorization
// server metadata, dynamic registration, code issuance with auto-redirect,
// PKCE-checked token exchange, refresh grant, and a bearer-guarded MCP
// endpoint with one echo tool.

import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";

export interface OAuthFixture {
    readonly url: string;
    readonly close: () => void;
    readonly issued: { accessTokens: string[]; refreshGrants: number };
}

export function startOAuthFixture(options?: {
    expiresIn?: number;
}): Promise<OAuthFixture> {
    const issued = { accessTokens: [] as string[], refreshGrants: 0 };
    const codes = new Map<string, { challenge: string; redirectUri: string }>();
    const refreshTokens = new Set<string>();
    let counter = 0;

    const server: Server = createServer((request, response) => {
        const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        const url = new URL(request.url ?? "/", origin);
        const json = (status: number, body: unknown) => {
            response
                .writeHead(status, { "content-type": "application/json" })
                .end(JSON.stringify(body));
        };
        const readBody = (): Promise<string> =>
            new Promise((resolve) => {
                let data = "";
                request.on("data", (chunk: string | Buffer) => {
                    data += chunk.toString();
                });
                request.on("end", () => resolve(data));
            });

        switch (url.pathname) {
            case "/.well-known/oauth-protected-resource/mcp":
                json(200, {
                    resource: `${origin}/mcp`,
                    authorization_servers: [origin],
                });
                return;
            case "/.well-known/oauth-authorization-server":
                json(200, {
                    issuer: origin,
                    authorization_endpoint: `${origin}/authorize`,
                    token_endpoint: `${origin}/token`,
                    registration_endpoint: `${origin}/register`,
                });
                return;
            case "/register":
                void readBody().then(() =>
                    json(201, { client_id: `client-${counter++}` }));
                return;
            case "/authorize": {
                const code = `code-${counter++}`;
                codes.set(code, {
                    challenge: url.searchParams.get("code_challenge") ?? "",
                    redirectUri: url.searchParams.get("redirect_uri") ?? "",
                });
                const redirect = new URL(url.searchParams.get("redirect_uri")!);
                redirect.searchParams.set("code", code);
                redirect.searchParams.set(
                    "state",
                    url.searchParams.get("state") ?? "",
                );
                response
                    .writeHead(302, { location: redirect.toString() })
                    .end();
                return;
            }
            case "/token":
                void readBody().then((body) => {
                    const form = new URLSearchParams(body);
                    if (form.get("grant_type") === "refresh_token") {
                        if (!refreshTokens.has(form.get("refresh_token") ?? "")) {
                            json(400, { error: "invalid_grant" });
                            return;
                        }
                        issued.refreshGrants += 1;
                    } else {
                        const grant = codes.get(form.get("code") ?? "");
                        const verifier = form.get("code_verifier") ?? "";
                        const challenge = createHash("sha256")
                            .update(verifier)
                            .digest("base64url");
                        if (grant === undefined || grant.challenge !== challenge) {
                            json(400, { error: "invalid_grant" });
                            return;
                        }
                    }
                    const accessToken = `access-${counter++}`;
                    const refreshToken = `refresh-${counter++}`;
                    issued.accessTokens.push(accessToken);
                    refreshTokens.add(refreshToken);
                    json(200, {
                        access_token: accessToken,
                        refresh_token: refreshToken,
                        token_type: "Bearer",
                        expires_in: options?.expiresIn ?? 3600,
                    });
                });
                return;
            case "/mcp": {
                const bearer = (request.headers.authorization ?? "")
                    .replace(/^Bearer /, "");
                if (!issued.accessTokens.includes(bearer)) {
                    response
                        .writeHead(401, {
                            "www-authenticate":
                                `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
                        })
                        .end();
                    return;
                }
                void readBody().then((body) => {
                    const message = JSON.parse(body) as {
                        id?: unknown;
                        method: string;
                        params?: { name?: string; arguments?: { text?: string } };
                    };
                    const reply = (result: unknown) =>
                        json(200, { jsonrpc: "2.0", id: message.id, result });
                    switch (message.method) {
                        case "initialize":
                            reply({
                                protocolVersion: "2025-06-18",
                                capabilities: { tools: {} },
                                serverInfo: { name: "oauth-fixture", version: "0" },
                            });
                            return;
                        case "notifications/initialized":
                            response.writeHead(202).end();
                            return;
                        case "tools/list":
                            reply({
                                tools: [{
                                    name: "echo",
                                    description: "Echo text.",
                                    inputSchema: {
                                        type: "object",
                                        properties: { text: { type: "string" } },
                                    },
                                    annotations: { readOnlyHint: true },
                                }],
                            });
                            return;
                        case "tools/call":
                            reply({
                                content: [{
                                    type: "text",
                                    text: `echo: ${message.params?.arguments?.text}`,
                                }],
                            });
                            return;
                        default:
                            json(200, {
                                jsonrpc: "2.0",
                                id: message.id,
                                error: { code: -32601, message: "Method not found" },
                            });
                    }
                });
                return;
            }
            default:
                json(404, { error: "not_found" });
        }
    });

    return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            const port = (server.address() as { port: number }).port;
            resolve({
                url: `http://127.0.0.1:${port}/mcp`,
                close: () => server.close(),
                issued,
            });
        });
    });
}
