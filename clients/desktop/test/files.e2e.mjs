import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { configureFauxHome, streamChunk, until } from "./faux-home.mjs";
import { startTrial } from "./trial.mjs";

const seen = [];
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
        seen.push(JSON.stringify(body.messages));
        if (body.stream === false) {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({ id: "reply", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: "Done." }, finish_reason: "stop" }] }));
            return;
        }
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(streamChunk(body.model, { content: "Done." }));
        response.write(streamChunk(body.model, {}, "stop"));
        response.end("data: [DONE]\n\n");
    });
});

function copies(root) {
    const found = [];
    function walk(dir) {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const path = join(dir, entry.name);
            if (entry.isDirectory()) walk(path);
            else if (entry.name === "report.txt") found.push(path);
        }
    }
    walk(root);
    return found;
}

const trial = startTrial();
let failed = false;
let page;
try {
    await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
    configureFauxHome(trial.home, provider.address().port);
    const source = join(trial.trialRoot, "report.txt");
    writeFileSync(source, "a crow report");
    const many = Array.from({ length: 9 }, (_, index) => join(trial.trialRoot, `file-${index}.txt`));
    for (const file of many) writeFileSync(file, "crow");
    mkdirSync(trial.home, { recursive: true });
    const app = await trial.launch();
    await app.evaluate(({ dialog }, file) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    }, source);
    page = await app.firstWindow();
    await page.waitForSelector('.app[data-sessions="0"]', { timeout: 45_000 });
    await trial.waitForHost();
    await app.evaluate(({ dialog }, files) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files });
    }, many);
    await page.getByRole("button", { name: "Attach files" }).click();
    await page.waitForSelector('text=A message can have up to 8 files.');
    if (await page.locator(".chip-file").count() !== 8) throw new Error("The file limit did not keep eight chips.");
    while (await page.locator(".chip-file").count() > 0) await page.locator(".chip-file .chip-x").first().click();
    await app.evaluate(({ dialog }, file) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    }, source);
    await page.locator(".composer-input").evaluate((input, path) => {
        const data = new DataTransfer();
        data.setData("text/plain", path);
        input.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }));
    }, source);
    await page.waitForSelector('.chip-file:has-text("report.txt")');
    await page.getByRole("button", { name: "Remove report.txt" }).click();
    await page.getByRole("button", { name: "Attach files" }).click();
    await page.waitForSelector('.chip-file:has-text("report.txt")');
    if (copies(trial.home).length !== 0) throw new Error("The file was copied before send.");
    await page.getByRole("button", { name: "Remove report.txt" }).click();
    if (copies(trial.home).length !== 0) throw new Error("Removing a chip copied the file.");
    await page.getByRole("button", { name: "Attach files" }).click();
    await page.waitForSelector('.chip-file:has-text("report.txt")');
    const input = page.locator(".composer-input");
    await input.fill("Read this report");
    await input.press("Enter");
    await until("the file reference", () => seen.some((body) => body.includes("Attached files:") && body.includes("report.txt")));
    await until("the copied file", () => copies(trial.home).length === 1);
    const [copied] = copies(trial.home);
    if (!copied.includes(".jsonl.files/") || readFileSync(copied, "utf8") !== "a crow report") throw new Error(`Unexpected copy: ${copied}`);
    await page.evaluate(() => {
        const picker = document.createElement("input");
        picker.type = "file";
        picker.id = "test-file";
        document.body.append(picker);
    });
    await page.locator("#test-file").setInputFiles(source);
    await page.locator(".transcript-scroll[data-session]").evaluate((target) => {
        const transfer = new DataTransfer();
        transfer.items.add(document.querySelector("#test-file").files[0]);
        target.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
    });
    await page.waitForSelector('.chip-file:has-text("report.txt")');
    await input.fill("Another report");
    await input.press("Enter");
    await until("the renamed reference", () => seen.some((body) => body.includes("report 2.txt")));
    if (readFileSync(copied.replace("report.txt", "report 2.txt"), "utf8") !== "a crow report") throw new Error("The second copy is missing.");
    console.log("files e2e passed");
} catch (error) {
    failed = true;
    console.error(error);
    if (page !== undefined) console.error("Page text:", await page.locator(".app").innerText().catch(() => "unreadable"));
} finally {
    await trial.cleanup();
    provider.closeAllConnections();
    await new Promise((resolve) => provider.close(resolve));
}
process.exit(failed ? 1 : 0);
