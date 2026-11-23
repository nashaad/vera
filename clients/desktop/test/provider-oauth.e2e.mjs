import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createSocketServer } from "node:net";
import { join } from "node:path";
import { until } from "./faux-home.mjs";
import { MODIFIER, press, startTrial } from "./trial.mjs";

const trial = startTrial();
const socketPath = join(trial.trialRoot, "oauth.sock");
const sockets = new Set();
let connected = false;
let signInSocket;
let signInRequest;
let opened = false;
let deepseekRefreshed = false;
let holdProviderLists = false;
const heldProviderLists = [];
let deepseek = { id: "deepseek", name: "DeepSeek", methods: ["key"], connected: true,
    catalog_connected: true, enabled: true, connected_by: "key", custom: false };
const provider = () => ({ id: "openai-codex", name: "OpenAI Codex", methods: ["browser"], connected,
    catalog_connected: connected, enabled: true, ...(connected ? { connected_by: "browser" } : {}), custom: false });
const settings = (providerId = "openai-codex") => ({ provider: providerId,
    model: providerId === "deepseek" ? "deepseek-chat" : "crow-0",
    availableModels: [{ provider: "deepseek", model: "deepseek-chat", label: "DeepSeek Chat", levels: [] },
        { provider: "openai-codex", model: "crow-0", label: "Crow", levels: [] }], pooled: [],
    providerCatalogs: [{ id: "deepseek", label: "DeepSeek" }, { id: "openai-codex", label: "OpenAI Codex" }] });
const reply = (socket, value) => socket.write(`${JSON.stringify(value)}\n`);
let fixtureScript = "";
const authorization = createHttpServer((request, response) => {
    if (request.url === "/fixture") {
        response.writeHead(200, { "content-type": "text/html" });
        response.end('<div id="root"></div><script src="/fixture.js"></script>');
        return;
    }
    if (request.url === "/fixture.js") {
        response.writeHead(200, { "content-type": "text/javascript" });
        response.end(fixtureScript);
        return;
    }
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
        if (request.type === "provider_forget" && request.provider === "deepseek") {
            deepseek = { id: "deepseek", name: "DeepSeek", methods: ["key"], connected: false, catalog_connected: false, enabled: true, custom: false };
            reply(socket, { type: "model_operation_complete" });
            socket.end();
            return;
        }
        if (request.type === "provider_list" && holdProviderLists) {
            heldProviderLists.push(() => {
                if (socket.destroyed) return;
                reply(socket, { type: "provider_list_result", request_id: request.request_id, providers: [deepseek, provider()], needs_setup: true });
                socket.end();
            });
            return;
        }
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

    await press(app, ",", [MODIFIER]);
    const rail = page.locator(".settings-rail");
    await rail.getByRole("button", { name: "Providers", exact: true }).click();
    const cards = page.locator(".provider-cards");
    const connectedRow = cards.getByRole("group", { name: "DeepSeek" });
    await connectedRow.waitFor();
    await page.evaluate(() => {
        window.providerWizardTitles = [];
        new MutationObserver(() => {
            for (const title of document.querySelectorAll(".provider-wizard-head h2")) {
                window.providerWizardTitles.push(title.textContent);
            }
        }).observe(document.body, { childList: true, subtree: true, characterData: true });
    });
    holdProviderLists = true;
    await connectedRow.click();
    await until("the delayed wizard provider list", () => heldProviderLists.length === 1);
    await wizard.getByRole("heading", { name: "Connect DeepSeek", exact: true }).waitFor();
    await wizard.getByText("Stored in Vera").waitFor();
    const titles = await page.evaluate(() => window.providerWizardTitles);
    if (titles.includes("Connect a provider")) throw new Error(`Wizard showed the provider screen: ${JSON.stringify(titles)}`);
    await wizard.getByRole("button", { name: "Close", exact: true }).click();
    await until("the delayed Settings provider reread", () => heldProviderLists.length === 2);
    if (await cards.count() !== 1 || await connectedRow.count() !== 1 || await page.getByText("Reading providers…").count() !== 0) {
        throw new Error("Provider cards disappeared while rereading.");
    }
    holdProviderLists = false;
    for (const release of heldProviderLists) release();
    await connectedRow.waitFor();
    heldProviderLists.length = 0;
    holdProviderLists = true;
    await connectedRow.getByRole("button", { name: "Forget", exact: true }).click();
    await connectedRow.getByRole("button", { name: "Forget", exact: true }).last().click();
    await until("the delayed reread after Forget", () => heldProviderLists.length === 1);
    if (await cards.count() !== 1 || await connectedRow.count() !== 1 || await page.getByText("Reading providers…").count() !== 0) {
        throw new Error("Provider cards disappeared after Forget while rereading.");
    }
    holdProviderLists = false;
    heldProviderLists[0]();
    await cards.getByRole("button", { name: /DeepSeek/ }).waitFor();

    const fixture = join(trial.trialRoot, "provider-flicker-fixture.js");
    execFileSync(process.env.VERA_DESKTOP_BUN || "bun", ["build", join(trial.root, "clients/desktop/test/provider-flicker-fixture.tsx"), "--target=browser", `--outdir=${trial.trialRoot}`]);
    fixtureScript = readFileSync(fixture, "utf8");
    await app.evaluate(({ BrowserWindow }, url) => {
        const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
        void window.loadURL(url);
    }, `http://127.0.0.1:${authorization.address().port}/fixture`);
    await until("the provider fixture window", () => app.windows().some((candidate) => candidate.url().endsWith("/fixture")));
    const frame = app.windows().find((candidate) => candidate.url().endsWith("/fixture"));
    if (frame === undefined) throw new Error("Provider fixture window did not open.");
    await frame.waitForFunction(() => typeof window.openIdOnly === "function");
    await frame.evaluate(() => window.openIdOnly());
    if (await frame.locator("#root").innerHTML() !== "") throw new Error("Id-only setup rendered before the provider list resolved.");
    await frame.evaluate(() => window.resolveProviders());
    await frame.getByRole("heading", { name: "Connect DeepSeek", exact: true }).waitFor();
    await frame.getByLabel("DeepSeek API key").waitFor();
    if (await frame.getByText("Connect a provider", { exact: true }).count() !== 0) throw new Error("Id-only setup opened on the provider screen.");
    await frame.evaluate(() => window.openSeeded("refresh"));
    await frame.getByRole("heading", { name: "Connect DeepSeek", exact: true }).waitFor();
    await frame.evaluate(() => window.resolveProviders(true));
    await frame.getByText("Stored in Vera").waitFor();
    await frame.evaluate(() => window.openSeeded("back"));
    await frame.getByRole("button", { name: "Back", exact: true }).click();
    await frame.getByRole("heading", { name: "Connect a provider", exact: true }).waitFor();
    await frame.evaluate(() => window.resolveProviders());
    await frame.getByRole("button", { name: /DeepSeek/ }).waitFor();
    if (await frame.getByRole("heading", { name: "Connect DeepSeek", exact: true }).count() !== 0) throw new Error("A provider refresh changed the current step.");
    await frame.evaluate(() => window.openWithoutProvider());
    if (await frame.locator("#root").innerHTML() !== "") throw new Error("Setup rendered before the provider list resolved.");
    await frame.evaluate(() => window.failProviders());
    await frame.getByRole("heading", { name: "Connect a provider", exact: true }).waitFor();
    await frame.getByRole("alert").getByText("unavailable").waitFor();
    console.log("Browser sign-in, id-only setup, and provider refresh rendering passed.");
} finally {
    await trial.cleanup();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => host.close(resolve));
    await new Promise((resolve) => authorization.close(resolve));
}
