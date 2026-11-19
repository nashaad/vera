// Help chat test for the desktop shell. Run with: node clients/desktop/test/help.e2e.mjs
// The Help button opens a new Help chat in a Chat tab of the right pane. The provider asks to show the theme
// chooser and the window opens it. Another chat is never offered the Help tools.

import { createServer } from "node:http";

import { configureFauxHome, streamChunk, until } from "./faux-home.mjs";
import { MODIFIER, press, startTrial } from "./trial.mjs";

const HELP_TOOLS = ["help_extension_failures", "help_guide", "help_providers", "help_show"];
const OPENED = "The theme chooser is open.";
const PLAIN = "The crow settles on the branch.";
const requests = [];
let calls = 0;

function lastUserText(messages) {
    const last = [...messages].reverse().find((message) => message.role === "user");
    return JSON.stringify(last?.content ?? "");
}

const provider = createServer((request, response) => {
    if (request.method === "GET" && request.url.endsWith("/models")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "crow-0" }] }));
        return;
    }
    let raw = "";
    request.on("data", (part) => { raw += part; });
    request.on("end", () => {
        const body = JSON.parse(raw);
        if (body.stream === false) {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({
                id: "reply",
                model: body.model,
                choices: [{ index: 0, message: { role: "assistant", content: "Crow notes" }, finish_reason: "stop" }],
                usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
            }));
            return;
        }
        const messages = body.messages ?? [];
        const user = lastUserText(messages);
        // A title request quotes the conversation; it is not a turn.
        if (String(messages.at(-1)?.content ?? "").startsWith("User:\n")) {
            response.writeHead(200, { "content-type": "text/event-stream" });
            response.write(streamChunk(body.model, { content: "Crow notes" }, "stop"));
            response.end("data: [DONE]\n\n");
            return;
        }
        const tools = (body.tools ?? []).map((tool) => tool.function?.name).filter((name) => typeof name === "string");
        requests.push({ user, tools, help: raw.includes("You answer questions about using Vera.") });
        const afterTool = messages.at(-1)?.role === "tool";
        response.writeHead(200, { "content-type": "text/event-stream" });
        if (tools.includes("help_show") && !afterTool) {
            calls += 1;
            const call = { index: 0, id: `call-${calls}`, type: "function", function: { name: "help_show", arguments: JSON.stringify({ target: "dialog.themes" }) } };
            response.write(streamChunk(body.model, { role: "assistant", tool_calls: [call] }, "tool_calls"));
        } else {
            const text = tools.includes("help_show") ? OPENED : PLAIN;
            response.write(streamChunk(body.model, { role: "assistant", content: text }, "stop"));
        }
        response.end("data: [DONE]\n\n");
    });
});

const trial = startTrial();
let failed = false;
let page;

try {
    await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
    configureFauxHome(trial.home, provider.address().port, "auto");

    const app = await trial.launch();
    page = await app.firstWindow();
    await page.waitForSelector(".app[data-sessions=\"0\"]", { timeout: 45_000 });
    await trial.waitForHost();

    // The page counts the host's agent switches.
    await page.evaluate(() => {
        window.__agentSwitches = 0;
        window.veraDesktop.onEvent((event) => {
            if (event.type === "session_frame" && typeof event.text === "string" && event.text.includes("\"agent_selected\"")) window.__agentSwitches += 1;
        });
    });
    const switches = () => page.evaluate(() => window.__agentSwitches);
    const help = page.locator(".help-button");
    const pane = "[data-location=\"rightPane\"]";
    const active = `${pane} [data-tab-body]:not([hidden])`;
    const chatTabs = page.locator(`${pane} [data-switcher="rightPane"] [data-tab][data-container="core.chat"]`);
    await until("the Help button to enable", async () => !(await help.isDisabled()), 45_000);
    if ((await help.innerText()).trim() !== "Help") throw new Error("The Help button has no label.");

    // A question typed as soon as the Chat tab is up still reaches the Help agent, not the default one.
    await help.click();
    await chatTabs.first().waitFor({ timeout: 10_000 });
    await page.locator(`${active} [data-session][data-phase="attached"]`).waitFor({ timeout: 45_000 });
    if (await page.locator(".home-composer").count() !== 1) throw new Error("Help took over the main pane.");
    const input = page.locator(`${active} .composer-input`);
    const send = page.locator(`${active} .send-button`);
    await input.fill("Where do I change the theme?");
    await input.press("Enter");
    await until("the chat to switch to the Help agent", async () => (await switches()) === 1);
    const firstId = await page.locator(`${active} [data-session]`).first().getAttribute("data-session");
    await page.locator("[data-overlay=\"themes\"]").waitFor({ timeout: 45_000 });
    await page.waitForSelector(`text=${OPENED}`, { timeout: 45_000 });
    await until("the turn to end", async () => (await send.getAttribute("data-mode")) === "send");

    const helpRequest = requests.find((entry) => entry.help);
    if (helpRequest === undefined) throw new Error("No request carried the Help agent's instructions.");
    if (!helpRequest.user.includes("Where do I change the theme?")) throw new Error("The first message did not reach the Help agent.");
    if (helpRequest.tools.slice().sort().join() !== HELP_TOOLS.join()) throw new Error(`The Help chat was offered ${helpRequest.tools.join(", ")}.`);
    if (calls !== 1) throw new Error(`The provider was asked for ${calls} show calls.`);
    await page.locator("[data-overlay=\"themes\"] .sheet-x").click();
    await page.locator("[data-overlay=\"themes\"]").waitFor({ state: "detached", timeout: 5_000 });

    // Each press opens a new Chat tab on a new chat.
    await help.click();
    await until("a second Chat tab", async () => (await chatTabs.count()) === 2);
    await page.locator(`${active} [data-session][data-phase="attached"]`).waitFor({ timeout: 45_000 });
    const secondId = await page.locator(`${active} [data-session]`).first().getAttribute("data-session");
    if (secondId === firstId) throw new Error("The second press showed the first chat.");
    await until("the second chat to switch to the Help agent", async () => (await switches()) === 2);

    // Another chat is not offered the Help tools.
    await press(app, "N", [MODIFIER]);
    const home = page.locator(".home-composer .composer-input");
    await home.waitFor({ timeout: 10_000 });
    await home.fill("Tell me about crows");
    await home.press("Enter");
    await page.waitForSelector(`text=${PLAIN}`, { timeout: 45_000 });
    const plain = requests.find((entry) => entry.user.includes("Tell me about crows"));
    if (plain === undefined) throw new Error("The other chat never reached the provider.");
    if (plain.tools.length === 0) throw new Error("The other chat was offered no tools, so the check proves nothing.");
    if (plain.tools.some((name) => name.startsWith("help_"))) throw new Error(`The other chat was offered ${plain.tools.join(", ")}.`);
    if (plain.help) throw new Error("The other chat carried the Help agent's instructions.");
    console.log("help e2e passed");
} catch (error) {
    failed = true;
    console.error(error);
    console.error("Requests:", JSON.stringify(requests.map((entry) => ({ ...entry, tools: entry.tools.length })), null, 1));
    if (page !== undefined) console.error("Page text:", await page.locator(".app").first().innerText().catch(() => "unreadable"));
} finally {
    await trial.cleanup();
    provider.closeAllConnections();
    await new Promise((resolve) => provider.close(resolve));
}
process.exit(failed ? 1 : 0);
