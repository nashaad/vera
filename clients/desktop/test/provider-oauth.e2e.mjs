import { createServer as createHttpServer } from "node:http";
import { createServer as createSocketServer } from "node:net";
import { join } from "node:path";
import { startTrial } from "./trial.mjs";

const trial = startTrial();
const socketPath = join(trial.trialRoot, "oauth.sock");
const sockets = new Set();
let connected = false;
let signInSocket;
let signInRequest;
let opened = false;
let deepseekRefreshed = false;
const deepseek = { id: "deepseek", name: "DeepSeek", methods: ["key"], connected: true,
    catalog_connected: true, connected_by: "key", custom: false };
const provider = () => ({ id: "openai-codex", name: "OpenAI Codex", methods: ["browser"], connected,
    catalog_connected: connected, ...(connected ? { connected_by: "browser" } : {}), custom: false });
const settings = (providerId = "openai-codex") => ({ provider: providerId,
    model: providerId === "deepseek" ? "deepseek-chat" : "crow-0",
    availableModels: [{ provider: "deepseek", model: "deepseek-chat", label: "DeepSeek Chat", levels: [] },
        { provider: "openai-codex", model: "crow-0", label: "Crow", levels: [] }], pooled: [],
    providerCatalogs: [{ id: "deepseek", label: "DeepSeek" }, { id: "openai-codex", label: "OpenAI Codex" }] });
const reply = (socket, value) => socket.write(`${JSON.stringify(value)}\n`);
const authorization = createHttpServer((_request, response) => {
    connected = true;
    reply(signInSocket, { type: "provider_sign_in_result", request_id: signInRequest, provider: provider() });
    signInSocket.end();
    response.end("Signed in");
});
const host = createSocketServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    let data = "";
    socket.on("data", (chunk) => {
        data += chunk;
        if (!data.includes("\n")) return;
        const request = JSON.parse(data.slice(0, data.indexOf("\n")));
        if (request.type === "provider_sign_in") {
            signInSocket = socket;
            signInRequest = request.request_id;
            reply(socket, { type: "provider_sign_in_url", request_id: request.request_id,
                url: `http://127.0.0.1:${authorization.address().port}/authorize` });
            return;
        }
        if (request.type === "catalog_refresh" && request.provider === "deepseek") deepseekRefreshed = true;
        const answer = request.type === "host_identity" ? { type: "host_identity", pid: process.pid, protocol_version: 37 }
            : request.type === "list_agents" ? { type: "agent_list", agents: [], total: 0 }
                : request.type === "model_settings" ? { type: "model_settings", settings: settings() }
                    : request.type === "provider_list" ? { type: "provider_list_result", request_id: request.request_id, providers: [deepseek, provider()], needs_setup: true }
                        : request.type === "catalog_refresh" ? { type: "catalog_refresh", settings: settings(request.provider) }
                            : request.type === "provider_select_model" ? { type: "provider_select_model_result", request_id: request.request_id }
                                : { type: "protocol_error", reason: "unsupported_or_invalid_command" };
        reply(socket, answer);
        socket.end();
    });
});

try {
    await new Promise((resolve) => authorization.listen(0, "127.0.0.1", resolve));
    await new Promise((resolve) => host.listen(socketPath, resolve));
    const app = await trial.launch({ env: { PROVSIGN_FAUX_SOCKET: socketPath,
        VERA_DESKTOP_DEV_CLI: join(trial.root, "clients", "desktop", "test", "faux-provider-boot.mjs") } });
    await app.evaluate(({ shell }) => {
        shell.openExternal = async (url) => { await fetch(url); };
    });
    const page = await app.firstWindow();
    const wizard = page.locator(".provider-wizard-sheet");
    await wizard.waitFor({ timeout: 45_000 });
    const deepseekRow = wizard.getByRole("button", { name: /DeepSeek/ });
    await deepseekRow.getByText("Stored key", { exact: true }).waitFor();
    await deepseekRow.click();
    const continueButton = wizard.getByRole("button", { name: "Continue", exact: true });
    await continueButton.focus();
    await page.keyboard.press("Enter");
    await wizard.getByRole("radio", { name: /DeepSeek Chat/ }).waitFor({ timeout: 30_000 });
    if (deepseekRefreshed) throw new Error("DeepSeek's fixed catalog was refreshed.");
    await page.keyboard.press("Escape");
    await wizard.getByRole("button", { name: "Continue", exact: true }).waitFor();
    await page.keyboard.press("Escape");
    await wizard.getByRole("button", { name: /OpenAI Codex/ }).click();
    await wizard.getByRole("heading", { name: "Connect OpenAI Codex", exact: true }).waitFor();
    const signIn = wizard.getByRole("button", { name: "Sign in", exact: true });
    await signIn.focus();
    await page.keyboard.press("Enter");
    await wizard.getByRole("radio").first().waitFor({ timeout: 30_000 });
    await wizard.getByRole("button", { name: "Check and use" }).click();
    await wizard.waitFor({ state: "detached", timeout: 30_000 });
    opened = connected;
    if (!opened) throw new Error("The local authorization service was not reached.");
    console.log("Browser sign-in through the local authorization service passed.");
} finally {
    await trial.cleanup();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => host.close(resolve));
    await new Promise((resolve) => authorization.close(resolve));
}
