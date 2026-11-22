// Subagent model setup test for the desktop window. Run with: node clients/desktop/test/subagent-model-defaults.e2e.mjs

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

import { configureFauxHome, streamChunk, until } from "./faux-home.mjs";
import { startTrial } from "./trial.mjs";

const DESCRIPTION = "Count the doubloons in the hold";
const CHILD_REPLY = "Forty doubloons lie in the hold.";
const MAIN_REPLY = "The crow is waiting on the count.";

let childStarted = false;
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
        const child = !JSON.stringify(messages).includes("Hello crow");
        const last = messages.at(-1);
        response.writeHead(200, { "content-type": "text/event-stream" });
        if (!child && last?.role === "user") {
            const call = { index: 0, id: "call-1", type: "function", function: { name: "async_subagent", arguments: JSON.stringify({ description: DESCRIPTION }) } };
            response.write(streamChunk(body.model, { role: "assistant", tool_calls: [call] }, "tool_calls"));
        } else {
            if (child) childStarted = true;
            response.write(streamChunk(body.model, { role: "assistant", content: child ? CHILD_REPLY : MAIN_REPLY }, "stop"));
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
    const configPath = join(trial.home, "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.model_assignments.subagents = { models: [], allow_self: false };
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    const folder = join(trial.home, "..", "work");
    mkdirSync(folder, { recursive: true });

    const app = await trial.launch();
    await app.evaluate(({ dialog }, path) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, folder);
    page = await app.firstWindow();
    await page.waitForSelector(".app[data-sessions]", { timeout: 45_000 });
    await trial.waitForHost();

    const input = page.locator(".home-composer .composer-input");
    await input.fill("Hello crow");
    await page.getByRole("button", { name: /No folder/ }).click();
    await page.getByRole("menuitem", { name: /Open folder/ }).click();
    await page.waitForSelector(`.context-chips .chip-label:text-is("${folder.split("/").pop()}")`);
    await input.press("Enter");
    await page.waitForSelector("[data-session][data-phase=\"attached\"]", { timeout: 45_000 });

    const setup = page.locator('.request-card[data-kind="setup"]');
    await setup.waitFor({ timeout: 45_000 });
    if (!(await setup.innerText()).includes("subagent")) throw new Error(`Unexpected setup card: ${await setup.innerText()}`);
    if (await setup.getByText("This setup is available in the terminal.").count()) throw new Error("The subagent setup card still sends users to the terminal.");
    await setup.getByRole("button", { name: "Open model defaults" }).click();
    await page.getByRole("dialog", { name: "Models" }).waitFor();
    const defaults = page.getByRole("tab", { name: "Defaults" });
    await until("Defaults selected", async () => await defaults.getAttribute("aria-selected") === "true");
    const allowSelf = page.getByRole("switch", { name: "Then the spawning session's model" });
    await allowSelf.waitFor();
    if (await allowSelf.getAttribute("aria-checked") !== "false") throw new Error("The explicitly disabled spawning model switch was not shown as off.");
    const compaction = page.locator(".slot-row", { has: page.locator(".slot-row-name", { hasText: /^Compaction$/ }) });
    await compaction.locator(".slot-btn").click();
    const picker = page.locator(".slot-picker");
    await until("the compaction picker focused", () => picker.locator("input").evaluate((field) => field === document.activeElement));
    await page.keyboard.press("Enter");
    await until("unrelated compaction change saved", () => JSON.parse(readFileSync(configPath, "utf8")).model_assignments.compaction === undefined);
    if (await setup.getAttribute("data-answered") !== "false" || childStarted) throw new Error("An unrelated default change resumed the launch.");
    await page.getByRole("dialog", { name: "Models" }).getByRole("button", { name: "Close", exact: true }).click();
    if (await setup.getAttribute("data-answered") !== "false" || childStarted) throw new Error("Opening Defaults without a change resumed the launch.");
    await setup.getByRole("button", { name: "Open model defaults" }).click();
    await allowSelf.waitFor();
    await allowSelf.click();
    await until("the spawning model switch enabled", async () => await allowSelf.getAttribute("aria-checked") === "true");
    await page.getByRole("dialog", { name: "Models" }).getByRole("button", { name: "Close", exact: true }).click();
    const confirmation = page.locator('.request-card[data-kind="question"]');
    await confirmation.getByText(/Continue 1 waiting subagent launch/).waitFor({ timeout: 15_000 });
    await confirmation.locator('button[data-choice="continue"]').click();
    await until("the subagent launch continues", async () => childStarted, 45_000);
    await page.getByText(CHILD_REPLY).first().waitFor({ timeout: 45_000 });
    await page.getByText(MAIN_REPLY).first().waitFor({ timeout: 45_000 });
    if (await setup.count()) throw new Error("The setup card remained after the configured launch continued.");

    console.log("subagent model defaults e2e passed");
} catch (error) {
    failed = true;
    console.error(error);
    if (page !== undefined) console.error("Page text:", await page.locator(".app").first().innerText().catch(() => "unreadable"));
} finally {
    await trial.cleanup();
    provider.closeAllConnections();
    await new Promise((resolve) => provider.close(resolve));
}
process.exit(failed ? 1 : 0);
