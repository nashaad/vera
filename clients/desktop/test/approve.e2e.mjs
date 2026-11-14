// Approval test for the desktop shell. Run with: node clients/desktop/test/approve.e2e.mjs
// The provider asks to run one shell command per prompt; the session runs in ask mode.
// Ask mode allows writes inside the workspace, so each command writes outside it.
// An allowed card leaves nothing, a denied one leaves a muted line until the next turn, and
// Settings > Appearance > Past approvals keeps the answered card. A typed answer denies with its text.

import { existsSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

import { configureFauxHome, streamChunk, until } from "./faux-home.mjs";
import { startTrial } from "./trial.mjs";

const AFTER_TOOL = "The crow is home.";
const requests = [];
let calls = 0;
let outside = "";

function commandFor(text) {
    if (text.includes("FIRST")) return `touch ${join(outside, "first-crow.txt")}`;
    if (text.includes("SECOND")) return `touch ${join(outside, "second-crow.txt")}`;
    if (text.includes("THIRD")) return `touch ${join(outside, "third-crow.txt")}`;
    if (text.includes("FOURTH")) return `touch ${join(outside, "fourth-crow.txt")}`;
    return undefined;
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
        const messages = body.messages ?? [];
        const last = messages.at(-1);
        const user = [...messages].reverse().find((message) => message.role === "user");
        const text = JSON.stringify(user?.content ?? "");
        requests.push({ role: last?.role, text, last: JSON.stringify(last?.content ?? "") });
        if (body.stream === false) {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({
                id: "reply",
                model: body.model,
                choices: [{ index: 0, message: { role: "assistant", content: "Crow" }, finish_reason: "stop" }],
                usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
            }));
            return;
        }
        response.writeHead(200, { "content-type": "text/event-stream" });
        const command = last?.role === "user" ? commandFor(text) : undefined;
        if (command === undefined) {
            response.write(streamChunk(body.model, { role: "assistant", content: AFTER_TOOL }, "stop"));
        } else {
            calls += 1;
            const call = { index: 0, id: `call-${calls}`, type: "function", function: { name: "bash", arguments: JSON.stringify({ command }) } };
            response.write(streamChunk(body.model, { role: "assistant", tool_calls: [call] }, "tool_calls"));
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
    const folder = join(trial.home, "..", "work");
    mkdirSync(folder, { recursive: true });
    outside = join(trial.home, "..", "outside");
    mkdirSync(outside, { recursive: true });

    const app = await trial.launch();
    await app.evaluate(({ dialog }, path) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, folder);

    page = await app.firstWindow();
    await page.waitForSelector(".app[data-sessions=\"0\"]", { timeout: 45_000 });
    await trial.waitForHost();

    // New Chat starts the session in ask mode even though the home default is auto.
    await page.getByRole("button", { name: /No folder/ }).click();
    await page.getByRole("menuitem", { name: /Open folder/ }).click();
    await page.waitForSelector(".context-chips .chip-label:text-is(\"work\")");
    await page.getByRole("button", { name: /Default approvals/ }).click();
    await page.getByRole("menuitemradio", { name: /Ask for approval/ }).click();
    const input = page.locator(".composer-input");
    await input.fill("Run the FIRST command");
    await input.press("Enter");
    await page.waitForSelector("[data-session][data-phase=\"attached\"]", { timeout: 45_000 });
    await page.waitForSelector(".pill-button[data-mode=\"ask\"]", { timeout: 15_000 });

    // Key 1 allows once from an empty composer.
    const card = page.locator(".request-card[data-kind=\"approval\"]");
    await card.waitFor({ timeout: 30_000 });
    await page.waitForSelector(".request-card:has-text(\"first-crow.txt\")");
    // The headline says what is written; where it lands and the command stay folded until asked for.
    if ((await card.locator(".request-title").innerText()) !== "Write first-crow.txt outside the work folder?") throw new Error("The approval headline does not name the file and the folder.");
    const fold = card.locator(".request-fold-toggle");
    if ((await fold.getAttribute("aria-expanded")) !== "false") throw new Error("The command is not folded.");
    if (await card.locator(".request-fold-body").count() !== 0) throw new Error("A folded command is on screen.");
    await fold.click();
    if (!(await card.locator(".request-fold-body").innerText()).includes("touch")) throw new Error("The folded command does not show.");
    if (!(await card.locator(".request-folder").innerText()).endsWith("outside")) throw new Error("The fold does not say where the file goes.");
    await fold.click();
    await input.focus();
    await page.keyboard.press("1");
    await card.waitFor({ state: "detached", timeout: 15_000 });
    if (await page.locator(".request-denied").count() !== 0) throw new Error("An allowed approval left a line behind.");
    await page.waitForSelector(`text=${AFTER_TOOL}`, { timeout: 30_000 });
    await until("the first file", async () => existsSync(join(outside, "first-crow.txt")));
    if ((await input.inputValue()) !== "") throw new Error("The approval key reached the composer.");

    // Deny from the card's button: the command does not run and the turn still ends.
    const send = page.locator(".send-button");
    await until("the first turn to end", async () => (await send.getAttribute("data-mode")) === "send");
    await input.fill("Run the SECOND command");
    await input.press("Enter");
    await card.waitFor({ timeout: 30_000 });
    await card.getByRole("button", { name: "Deny", exact: true }).click();
    await card.waitFor({ state: "detached", timeout: 15_000 });
    await until("the second turn to end", async () => (await send.getAttribute("data-mode")) === "send");
    if (existsSync(join(outside, "second-crow.txt"))) throw new Error("A denied command ran.");
    const denied = page.locator(".request-denied");
    await denied.waitFor({ timeout: 10_000 });
    if (!(await denied.innerText()).includes("second-crow.txt")) throw new Error("The denied line does not name the command.");
    if (await page.locator(".request-card").count() !== 0) throw new Error("A denied approval left its card.");

    // The next turn clears the line.
    await input.fill("Say hello");
    await input.press("Enter");
    await denied.waitFor({ state: "detached", timeout: 15_000 });
    await until("the next turn to end", async () => (await send.getAttribute("data-mode")) === "send");

    // A typed answer denies with its text. Digits typed in the box do not answer the card.
    await input.fill("Run the FOURTH command");
    await input.press("Enter");
    await card.waitFor({ timeout: 30_000 });
    const box = card.getByPlaceholder("Or tell Vera what to do instead");
    await box.focus();
    await page.keyboard.type("1 2 3 4");
    if ((await box.inputValue()) !== "1 2 3 4") throw new Error("Digits did not reach the answer box.");
    if ((await card.count()) !== 1) throw new Error("A digit typed in the answer box answered the card.");
    await box.fill("Use the notes folder instead");
    await box.press("Enter");
    await card.waitFor({ state: "detached", timeout: 15_000 });
    await until("the fourth turn to end", async () => (await send.getAttribute("data-mode")) === "send");
    if (existsSync(join(outside, "fourth-crow.txt"))) throw new Error("A command ran after a typed answer.");
    if (!requests.some((entry) => entry.role === "tool" && entry.last.includes("Use the notes folder instead"))) {
        throw new Error("The typed answer did not reach the model.");
    }
    await page.locator(".request-denied").waitFor({ timeout: 10_000 });

    // Past approvals keeps the answered card, and the setting survives leaving the session.
    const agentId = await page.locator("[data-session]").first().getAttribute("data-session");
    const modifier = process.platform === "darwin" ? "meta" : "control";
    await app.evaluate(({ BrowserWindow }, modifiers) => {
        const contents = BrowserWindow.getAllWindows()[0].webContents;
        contents.sendInputEvent({ type: "keyDown", keyCode: "K", modifiers });
        contents.sendInputEvent({ type: "keyUp", keyCode: "K", modifiers });
    }, [modifier]);
    const palette = page.locator("input[aria-label=\"Command palette\"]");
    await palette.waitFor({ timeout: 10_000 });
    await palette.fill("settings");
    await page.locator(".palette-row[data-command=\"go.settings\"]").waitFor({ timeout: 10_000 });
    await palette.press("Enter");
    await page.waitForSelector("main[data-page=\"settings\"]", { timeout: 10_000 });
    await page.locator(".rail-row", { hasText: "Appearance" }).click();
    const past = page.getByRole("switch", { name: "Past approvals" });
    if ((await past.getAttribute("aria-checked")) !== "false") throw new Error("Past approvals is not off by default.");
    await past.click();
    await page.click(`.session-row[data-session="${agentId}"]`);
    await page.waitForSelector(`[data-session="${agentId}"][data-phase="attached"]`, { timeout: 30_000 });
    await until("the composer to be idle", async () => (await send.getAttribute("data-mode")) === "send");
    await input.fill("Run the THIRD command");
    await input.press("Enter");
    await card.waitFor({ timeout: 30_000 });
    await card.locator(".request-choice[data-choice=\"allow_once\"]").click();
    await page.waitForSelector(".request-card[data-answered=\"true\"] .request-outcome:text-is(\"Allowed\")", { timeout: 15_000 });
    await until("the third turn to end", async () => (await send.getAttribute("data-mode")) === "send");
    await until("the third file", async () => existsSync(join(outside, "third-crow.txt")));

    // The session pill changes this session's mode.
    await page.locator(".pill-button[data-mode=\"ask\"]").click();
    await page.getByRole("menuitemradio", { name: /Read only/ }).click();
    await page.waitForSelector(".pill-button[data-mode=\"readonly\"]", { timeout: 15_000 });
    console.log("approve e2e passed");
} catch (error) {
    failed = true;
    console.error(error);
    console.error("Provider saw:", requests);
    if (page !== undefined) console.error("Page text:", await page.locator(".transcript-scroll, .app").first().innerText().catch(() => "unreadable"));
} finally {
    await trial.cleanup();
    provider.closeAllConnections();
    await new Promise((resolve) => provider.close(resolve));
}
process.exit(failed ? 1 : 0);
