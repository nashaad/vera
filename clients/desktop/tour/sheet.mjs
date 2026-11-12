// Builds sheet.png, a four-column contact sheet of the tour screenshots, rendered in a hidden window of the running app.
import { writeFileSync } from "node:fs";
import { basename, join } from "node:path";

export async function writeSheet(app, dir, files) {
    const htmlPath = join(dir, "sheet.html");
    const pngPath = join(dir, "sheet.png");
    writeFileSync(htmlPath, sheetHtml(files));
    const windowReady = app.waitForEvent("window");
    await app.evaluate(async ({ BrowserWindow }, file) => {
        const sheet = new BrowserWindow({
            show: false,
            width: 2680,
            height: 800,
            paintWhenInitiallyHidden: true,
        });
        globalThis.tourSheetWindow = sheet;
        await sheet.loadFile(file);
    }, htmlPath);
    try {
        const page = await windowReady;
        await page.waitForFunction(() => [...document.images].every((image) => image.complete));
        await page.screenshot({ path: pngPath, fullPage: true });
    } finally {
        await app.evaluate(() => {
            globalThis.tourSheetWindow?.close();
            delete globalThis.tourSheetWindow;
        });
    }
    return pngPath;
}

function sheetHtml(files) {
    const figures = files.map((file) => {
        const name = basename(file);
        return `<figure><figcaption>${escapeHtml(name)}</figcaption><img src="${escapeHtml(name)}" alt=""></figure>`;
    });
    return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
body { margin: 0; padding: 24px; background: #15151a; color: #e6e3dc; font: 14px system-ui, sans-serif; }
.grid { display: grid; grid-template-columns: repeat(4, 640px); gap: 24px; }
figure { margin: 0; }
figcaption { margin-bottom: 8px; overflow: hidden; color: #b5b0a6; font: 13px ui-monospace, monospace; text-overflow: ellipsis; white-space: nowrap; }
img { display: block; width: 640px; border: 1px solid #2d2d36; }
</style>
</head>
<body>
<div class="grid">
${figures.join("\n")}
</div>
</body>
</html>
`;
}

function escapeHtml(text) {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
}
