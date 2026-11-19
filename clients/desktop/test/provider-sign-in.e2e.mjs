import { createServer } from "node:http";
import sharp from "sharp";
import { streamChunk, until } from "./faux-home.mjs";
import { MODIFIER, press, startTrial } from "./trial.mjs";

const trial = startTrial();
const reply = "The crow is ready.";
const requests = [];
const screenshots = new Map();
const fontSizes = {};
async function assertFocusBorder(input, wrapped) {
    await input.focus();
    const result = await input.evaluate((element, wrapped) => {
        const field = getComputedStyle(element);
        const border = getComputedStyle(wrapped ? element.parentElement : element);
        const probe = document.createElement("span");
        probe.style.color = "var(--vera-accent)";
        document.body.append(probe);
        const accent = getComputedStyle(probe).color;
        probe.remove();
        return field.outlineStyle === "none" && border.outlineStyle === "none"
            && border.borderTopColor === accent && border.borderTopWidth !== "0px";
    }, wrapped);
    if (!result) throw new Error("Focused field does not have one accent border.");
}
let modelRequests = 0;
let firstModelRequestSeen = false;
let releaseFirstModelRequest;
let firstModelReplySent = false;
const firstModelGate = new Promise((resolve) => { releaseFirstModelRequest = resolve; });
let holdFirstModelRequest = true;
const screenshotPath = process.env.VERA_PROVIDER_SCREENSHOT;
const capture = async (name, element) => {
    if (screenshotPath !== undefined) screenshots.set(name, await element.screenshot());
};
async function writeScreenshots() {
    if (screenshotPath === undefined) return;
    const names = ["appearance", "data", "providers", "models", "approvals", "provider-list", "provider-key", "provider-model"];
    const images = await Promise.all(names.map(async (name) => {
        const source = screenshots.get(name);
        if (source === undefined) throw new Error(`Missing screenshot: ${name}`);
        const image = await sharp(source).resize({ width: 800 }).png().toBuffer();
        return { image, metadata: await sharp(image).metadata() };
    }));
    const rowHeights = Array.from({ length: 4 }, (_, row) => Math.max(images[row * 2].metadata.height, images[row * 2 + 1].metadata.height));
    const rowTops = rowHeights.map((_, row) => rowHeights.slice(0, row).reduce((sum, height) => sum + height, 0));
    await sharp({ create: { width: 1600, height: rowHeights.reduce((sum, height) => sum + height, 0), channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 } } })
        .composite(images.map(({ image }, index) => ({ input: image, left: (index % 2) * 800,
            top: rowTops[Math.floor(index / 2)] }))).png().toFile(screenshotPath);
}
const provider = createServer(async (request, response) => {
    if (request.method === "GET" && request.url.endsWith("/models")) {
        modelRequests += 1;
        if (request.headers.authorization !== "Bearer fake-key") { response.writeHead(401); response.end(); return; }
        const held = holdFirstModelRequest;
        if (held) {
            holdFirstModelRequest = false;
            firstModelRequestSeen = true;
            await firstModelGate;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [
            { id: "crow-0" },
            ...Array.from({ length: 64 }, (_, index) => ({ id: `crow-${index + 1}` })),
        ] }));
        if (held) firstModelReplySent = true;
        return;
    }
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
        const body = JSON.parse(raw);
        const user = [...(body.messages ?? [])].reverse().find((message) => message.role === "user");
        const text = JSON.stringify(user?.content ?? "");
        requests.push(text);
        const answer = text.match(/Reply with exactly: ([\w-]+)/)?.[1] ?? reply;
        const tool = text.match(/Call (\w+) with value (\w+)/);
        const call = tool === null ? undefined : { id: "call-probe", type: "function", function: { name: tool[1], arguments: JSON.stringify({ value: tool[2] }) } };
        const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
        if (body.stream === false) {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({ id: "reply", model: body.model, choices: [{ index: 0,
                message: call === undefined ? { role: "assistant", content: answer } : { role: "assistant", content: null, tool_calls: [call] },
                finish_reason: call === undefined ? "stop" : "tool_calls" }], usage })); return;
        }
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(streamChunk(body.model, call === undefined ? { content: answer } : { tool_calls: [{ index: 0, ...call }] }));
        response.write(`data: ${JSON.stringify({ id: "reply", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: {}, finish_reason: call === undefined ? "stop" : "tool_calls" }], usage })}\n\n`);
        response.end("data: [DONE]\n\n");
    });
});

try {
    await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
    // A provider key in the caller's environment counts as connected and skips first run.
    const withoutProviderKeys = Object.fromEntries(Object.keys(process.env)
        .filter((name) => name.endsWith("_API_KEY") || name === "OLLAMA_HOST").map((name) => [name, ""]));
    const app = await trial.launch({ env: withoutProviderKeys });
    const page = await app.firstWindow();
    await trial.waitForHost();
    const wizard = page.locator(".provider-wizard-sheet");
    await wizard.waitFor({ timeout: 45_000 });
    const sheetBounds = await wizard.boundingBox();
    if (sheetBounds === null || sheetBounds.width < 550) throw new Error("Provider setup sheet is too narrow.");
    const providerSearch = wizard.getByLabel("Search providers");
    await assertFocusBorder(providerSearch, true);
    await providerSearch.fill("deep");
    const deepseek = wizard.getByRole("button", { name: /DeepSeek/ });
    await deepseek.waitFor();
    fontSizes.windowRow = await deepseek.locator(".provider-card-name").evaluate((element) => getComputedStyle(element).fontSize);
    await deepseek.click();
    const deepseekKey = wizard.getByLabel("DeepSeek API key");
    await assertFocusBorder(deepseekKey, false);
    fontSizes.windowTitle = await wizard.locator(".provider-wizard-head h2").evaluate((element) => getComputedStyle(element).fontSize);
    fontSizes.windowField = await deepseekKey.evaluate((element) => getComputedStyle(element).fontSize);
    fontSizes.windowLabel = await deepseekKey.locator("..").evaluate((element) => getComputedStyle(element).fontSize);
    await deepseekKey.fill("fake-key");
    await wizard.getByText("8 characters, starting fake-k…").waitFor();
    fontSizes.windowEcho = await wizard.locator(".provider-wizard-key-echo").evaluate((element) => getComputedStyle(element).fontSize);
    await capture("provider-key", wizard);
    await wizard.locator("summary").click();
    if (await wizard.locator(".provider-wizard-key-echo").count() !== 0) throw new Error("Key preview remains visible after blur.");
    await page.keyboard.press("Escape");
    await providerSearch.fill("");
    await wizard.getByRole("button", { name: /Custom provider/ }).click();
    await wizard.getByLabel("Provider name").fill("faux-0");
    await wizard.getByLabel("Endpoint").fill(`http://127.0.0.1:${provider.address().port}/v1`);
    const firstApiKey = wizard.getByLabel("API key");
    await firstApiKey.fill("fake-key");
    await firstApiKey.press("Enter");
    await until("the model lookup", () => firstModelRequestSeen);
    await page.keyboard.press("Escape");
    await providerSearch.waitFor();
    releaseFirstModelRequest();
    await until("the cancelled model lookup reply", () => firstModelReplySent);
    await page.waitForTimeout(250);
    if (await wizard.getByRole("radio").count() !== 0) throw new Error("Cancelled setup returned to the model screen.");
    await wizard.getByRole("button", { name: /Custom provider/ }).click();
    await wizard.getByLabel("Provider name").fill("faux-1");
    await wizard.getByLabel("Endpoint").fill(`http://127.0.0.1:${provider.address().port}/v1`);
    await wizard.getByLabel("API key").fill("fake-key");
    await wizard.getByLabel("API key").press("Enter");
    await wizard.getByRole("radio").first().waitFor({ timeout: 45_000 });
    fontSizes.modelRow = await wizard.locator(".provider-wizard-model-row span").first().evaluate((element) => getComputedStyle(element).fontSize);
    const modelSearch = wizard.getByLabel("Search models");
    await modelSearch.focus();
    await assertFocusBorder(modelSearch, true);
    const selectedStyle = await wizard.locator(".provider-wizard-model-row:has(input:checked)").evaluate((element) => {
        const row = getComputedStyle(element);
        const other = element.parentElement.querySelector(".provider-wizard-model-row:not(:has(input:checked))");
        return other !== null && row.outlineStyle === "none" && row.borderBottomColor === getComputedStyle(other).borderBottomColor;
    });
    if (!selectedStyle) throw new Error("Selected model row has an accent outline or underline.");
    await capture("provider-model", wizard);
    await wizard.getByRole("button", { name: "Check and use" }).click();
    await wizard.waitFor({ state: "detached", timeout: 60_000 });
    const input = page.locator(".composer-input");
    await input.fill("Hello crow");
    await input.press("Enter");
    await page.getByText(reply, { exact: true }).waitFor({ timeout: 45_000 });
    await until("the first message", () => requests.some((text) => text.includes("Hello crow")));

    await press(app, ",", [MODIFIER]);
    const settingsPage = page.locator('main[data-page="settings"]');
    await settingsPage.waitFor();
    const settings = page.locator(".settings-col");
    const rail = page.locator(".settings-rail");
    const railSearch = rail.getByLabel("Search settings");
    await until("Settings search focus", async () => await railSearch.evaluate((element) => element === document.activeElement));
    await assertFocusBorder(railSearch, true);
    await railSearch.fill("Providers");
    await railSearch.press("ArrowDown");
    await railSearch.press("Enter");
    const connected = settings.getByRole("group", { name: "faux-1" });
    await connected.waitFor({ timeout: 30_000 });
    await railSearch.fill("");
    await settings.getByRole("group", { name: "faux-0" }).waitFor();
    fontSizes.settingsRow = await connected.locator(".provider-card-name").evaluate((element) => getComputedStyle(element).fontSize);
    fontSizes.settingsLabel = await connected.locator(".provider-card-label").first().evaluate((element) => getComputedStyle(element).fontSize);
    const badgeStyle = await connected.getByText("Custom", { exact: true }).evaluate((element) => {
        const style = getComputedStyle(element);
        return [style.display, style.borderTopStyle, style.borderTopWidth, style.borderTopColor,
            style.borderRadius, style.padding, style.fontSize, style.lineHeight, style.color];
    });
    for (const label of ["Custom", "In use"]) {
        const hasBorder = await connected.getByText(label, { exact: true }).evaluate((element) => {
            const style = getComputedStyle(element);
            return style.borderTopStyle === "solid" && style.borderTopWidth !== "0px";
        });
        if (!hasBorder) throw new Error(`${label} has no visible badge border.`);
    }
    if (fontSizes.settingsRow !== fontSizes.windowRow || fontSizes.settingsRow !== fontSizes.windowField || fontSizes.settingsRow !== fontSizes.modelRow || fontSizes.settingsLabel !== fontSizes.windowLabel || fontSizes.settingsLabel !== fontSizes.windowEcho) {
        throw new Error(`Settings and connect font sizes differ: ${JSON.stringify(fontSizes)}`);
    }
    await capture("providers", settingsPage);
    await connected.getByRole("button", { name: "Forget", exact: true }).click();
    await connected.getByRole("button", { name: "Cancel", exact: true }).click();
    await connected.click();
    await wizard.getByText("Stored in Vera").waitFor();
    await page.keyboard.press("Escape");
    const connectedRow = wizard.getByRole("button", { name: /faux-1/ });
    await connectedRow.getByText("Custom", { exact: true }).waitFor();
    await connectedRow.getByText("In use", { exact: true }).waitFor();
    await connectedRow.scrollIntoViewIfNeeded();
    await capture("provider-list", wizard);
    await wizard.getByRole("button", { name: "Back", exact: true }).click();
    await wizard.waitFor({ state: "detached" });

    await railSearch.fill("Pro");
    await press(app, ",", [MODIFIER]);
    await until("Settings search refocus", async () => await railSearch.evaluate((element) => element === document.activeElement));
    const selection = await railSearch.evaluate((element) => [element.selectionStart, element.selectionEnd, element.value.length]);
    if (selection[0] !== 0 || selection[1] !== selection[2]) throw new Error("Settings search text was not selected.");
    await railSearch.fill("");
    await rail.getByRole("button", { name: "Models", exact: true }).click();
    await settings.locator(".model-settings-row").filter({ hasText: "faux-1" }).getByRole("switch", { name: "Keep crow-0", exact: true }).waitFor({ timeout: 30_000 });
    if (await settings.locator(".model-settings-row").count() !== 12) throw new Error("Initial model page does not show 12 rows.");
    await capture("models", settingsPage);
    await settings.getByRole("button", { name: "View all models" }).click();
    await until("the first model page", async () => await settings.locator(".model-settings-row").count() === 50);
    await settings.getByRole("button", { name: "Show more" }).click();
    await until("the second model page", async () => await settings.locator(".model-settings-row").count() > 50);
    const search = settings.getByLabel("Search models");
    await search.fill("crow-1");
    if (await settings.getByRole("switch", { name: "Keep crow-0" }).count() !== 0) throw new Error("Model search did not filter the list.");
    const keep = settings.locator(".model-settings-row").filter({ hasText: "faux-1" }).getByRole("switch", { name: "Keep crow-1", exact: true });
    const wasKept = await keep.isChecked();
    await keep.click();
    await until("the model library change", async () => await keep.isChecked() !== wasKept);
    await keep.click();
    await until("the model library restoration", async () => await keep.isChecked() === wasKept);
    await search.fill("");
    if (await settings.locator(".model-settings-row").count() !== 12) throw new Error("Clearing search did not restore the initial model page.");
    const defaultBadge = settings.locator(".model-settings-row").filter({ hasText: "faux-1" }).filter({ hasText: "crow-0" }).getByText("Default", { exact: true });
    await defaultBadge.waitFor();
    const defaultStyle = await defaultBadge.evaluate((element) => {
        const style = getComputedStyle(element);
        return [style.display, style.borderTopStyle, style.borderTopWidth, style.borderTopColor,
            style.borderRadius, style.padding, style.fontSize, style.lineHeight, style.color];
    });
    if (JSON.stringify(defaultStyle) !== JSON.stringify(badgeStyle)) throw new Error(`Default badge differs from provider badge: ${JSON.stringify({ defaultStyle, badgeStyle })}`);
    const beforeRefresh = modelRequests;
    await settings.getByRole("button", { name: "Refresh", exact: true }).click();
    await until("the provider catalog refresh", () => modelRequests > beforeRefresh);

    for (const name of ["Appearance", "Data", "Approvals"]) {
        await rail.getByRole("button", { name, exact: true }).click();
        await settings.getByRole("heading", { name, exact: true }).waitFor();
        await capture(name.toLowerCase(), settingsPage);
    }
    await writeScreenshots();
    console.log(`Computed font sizes: ${JSON.stringify(fontSizes)}`);
    console.log("Provider setup, first chat and Settings passed.");
} finally {
    releaseFirstModelRequest();
    await trial.cleanup();
    await new Promise((resolve) => provider.close(resolve));
}
