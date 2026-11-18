import { writeFileSync } from "node:fs";
import { createServer } from "node:http";

import { configureFauxHome, until } from "./faux-home.mjs";
import { MODIFIER, press, startTrial } from "./trial.mjs";

const provider = createServer((request, response) => {
    request.resume();
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [{ id: "crow-0" }] }));
});
const site = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<title>Switch fixture</title><p>Browser switch fixture</p>");
});
const trial = startTrial();
let page;
let failed = false;

try {
    await Promise.all([provider, site].map((server) => new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))));
    configureFauxHome(trial.home, provider.address().port);
    const app = await trial.launch();
    page = await app.firstWindow();
    await page.waitForSelector('.app[data-sessions="0"]', { timeout: 45_000 });
    const host = await trial.waitForHost();
    console.log(`Switch trial desktop ${app.process().pid}, host ${host}, home ${trial.trialRoot}`);

    await press(app, "K", [MODIFIER]);
    const palette = page.getByRole("textbox", { name: "Command palette" });
    await palette.fill("Usage");
    await palette.press("Enter");
    const pane = page.locator('[data-location="rightPane"]');
    const tools = pane.getByRole("switch", { name: "Browser tools" });
    const controls = pane.locator(".browser-controls");
    const label = controls.locator("label");
    const notice = page.locator(".browser-tools-notice");
    await until("Browser tools available", () => tools.isEnabled());
    if (await tools.isChecked()) throw new Error("Browser tools started on.");
    const address = pane.getByRole("textbox", { name: "Address" });
    await address.fill(`http://127.0.0.1:${site.address().port}/`);
    await address.press("Enter");
    const nativeBounds = () => app.evaluate(({ BrowserWindow }, port) => {
        const child = BrowserWindow.getAllWindows()[0].contentView.children.find((view) => view.webContents?.getURL().includes(`:${port}/`));
        return child?.getBounds();
    }, site.address().port);
    await until("native page shown", async () => (await nativeBounds())?.height > 0);

    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.locator('main[data-page="settings"]').waitFor();
    const reference = page.getByRole("switch", { name: "Reduce motion" });
    await reference.waitFor();
    await tools.waitFor();

    async function selectTheme(theme) {
        await app.evaluate(({ Menu }, name) => {
            const item = Menu.getApplicationMenu().getMenuItemById(`theme.${name}`);
            if (item === null) throw new Error(`No theme menu item for ${name}.`);
            item.click();
        }, theme);
        await until(`${theme} theme applied`, () => page.evaluate((name) => document.documentElement.getAttribute("data-theme") === name, theme));
        await page.mouse.move(0, 0);
    }

    async function style(locator) {
        return locator.evaluate((element) => {
            const css = getComputedStyle(element);
            const knob = getComputedStyle(element.querySelector(".appearance-switch-knob"));
            return {
                width: css.width,
                height: css.height,
                padding: css.padding,
                background: css.backgroundColor,
                border: css.border,
                radius: css.borderRadius,
                opacity: css.opacity,
                cursor: css.cursor,
                outline: css.outline,
                outlineOffset: css.outlineOffset,
                focusVisible: element.matches(":focus-visible"),
                knobWidth: knob.width,
                knobHeight: knob.height,
                knobBackground: knob.backgroundColor,
                knobRadius: knob.borderRadius,
                knobTransform: knob.transform,
            };
        });
    }

    async function sameSwitch(theme, state) {
        await page.mouse.move(0, 0);
        const keys = ["width", "height", "padding", "background", "border", "radius", "knobWidth", "knobHeight", "knobBackground", "knobRadius", "knobTransform"];
        try {
            await until(`${theme} ${state} matches Settings`, async () => {
                const actual = await style(tools);
                const expected = await style(reference);
                return keys.every((key) => actual[key] === expected[key]);
            }, 5_000);
        } catch {
            throw new Error(`${theme} ${state} switch differs from Settings: ${JSON.stringify({ actual: await style(tools), expected: await style(reference) })}`);
        }
    }

    async function setReference(enabled) {
        if (await reference.isChecked() !== enabled) await reference.click();
        await until(`Settings switch ${enabled}`, async () => await reference.isChecked() === enabled);
    }

    async function setTools(enabled) {
        if (await tools.isChecked() !== enabled) await tools.click();
        await until(`Browser switch ${enabled}`, async () => await tools.isChecked() === enabled);
        await until(`notice ${enabled}`, async () => await notice.isVisible().catch(() => false) === enabled);
    }

    async function clickLabelText() {
        const outer = await label.boundingBox();
        const control = await tools.boundingBox();
        if (outer === null || control === null) throw new Error("Browser tools label was not visible.");
        await page.mouse.click(control.x + control.width + 6, outer.y + outer.height / 2);
    }

    async function assertNativeLayout() {
        await until("native bounds match Browser frame", async () => {
            const bounds = await nativeBounds();
            const frame = await pane.locator(".browser-frame").boundingBox();
            const row = await controls.boundingBox();
            if (bounds === undefined || frame === null || row === null) return false;
            return Math.abs(bounds.x - frame.x) <= 1 && Math.abs(bounds.y - frame.y) <= 1
                && Math.abs(bounds.width - frame.width) <= 1 && Math.abs(bounds.height - frame.height) <= 1
                && bounds.y >= row.y + row.height;
        });
    }

    const shots = new Map();
    async function capture(theme, state) {
        await page.mouse.move(0, 0);
        await tools.evaluate((element) => element.blur());
        const png = await label.screenshot();
        if (png.length < 500) throw new Error(`${theme} ${state} screenshot is empty.`);
        shots.set(`${theme}-${state}`, png);
    }

    for (const theme of ["dark", "light"]) {
        await selectTheme(theme);
        await setTools(false);
        await setReference(false);
        await sameSwitch(theme, "off");
        await assertNativeLayout();
        await capture(theme, "off");

        const beforeHover = await style(tools);
        await tools.hover();
        await until(`${theme} hover`, async () => (await style(tools)).border !== beforeHover.border);
        await page.keyboard.press("Tab");
        await reference.evaluate((element) => element.focus());
        const referenceFocus = await style(reference);
        await tools.evaluate((element) => element.focus());
        const focused = await style(tools);
        if (!focused.focusVisible || focused.outline === "none" || focused.outline !== referenceFocus.outline || focused.outlineOffset !== referenceFocus.outlineOffset) {
            throw new Error(`${theme} focus ring differs from Settings: ${JSON.stringify({ focused, referenceFocus })}`);
        }
        await page.keyboard.press("Space");
        await until(`${theme} Space turns tools on`, () => tools.isChecked());
        await notice.waitFor();
        await setReference(true);
        await sameSwitch(theme, "on");
        await assertNativeLayout();
        await capture(theme, "on");
        await tools.evaluate((element) => element.focus());
        await page.keyboard.press("Enter");
        await until(`${theme} Enter turns tools off`, async () => !await tools.isChecked());
        await until(`${theme} notice off`, async () => await notice.count() === 0);
        await clickLabelText();
        await until(`${theme} label turns tools on`, () => tools.isChecked());
        await notice.waitFor();
        await clickLabelText();
        await until(`${theme} label turns tools off`, async () => !await tools.isChecked());
        await until(`${theme} label hides notice`, async () => await notice.count() === 0);
        await clickLabelText();
        await until(`${theme} label turns tools back on`, () => tools.isChecked());
        await notice.waitFor();
        await notice.getByRole("button", { name: "Turn off" }).click();
        await until(`${theme} notice action turns switch off`, async () => !await tools.isChecked());
        await until(`${theme} notice action hides notice`, async () => await notice.count() === 0);
    }

    await setTools(true);
    await setReference(true);
    process.kill(host, "SIGTERM");
    await until("Browser switch unavailable", async () => !await tools.isEnabled(), 20_000);
    if (!await tools.isChecked() || !await notice.isVisible()) throw new Error("The armed setting disappeared on disconnect.");
    for (const theme of ["dark", "light"]) {
        await selectTheme(theme);
        await reference.evaluate((element) => { element.disabled = true; });
        await sameSwitch(theme, "disabled");
        const disabled = await style(tools);
        if (disabled.opacity !== "0.6" || disabled.cursor !== "default") throw new Error(`${theme} disabled treatment is missing.`);
        await capture(theme, "disabled");
        await clickLabelText();
        if (!await tools.isChecked() || !await notice.isVisible()) throw new Error(`${theme}: disabled label changed the setting.`);
    }

    const tiles = ["dark-off", "dark-on", "dark-disabled", "light-off", "light-on", "light-disabled"];
    if (shots.get("dark-off").equals(shots.get("light-off")) || shots.get("dark-off").equals(shots.get("dark-on"))) {
        throw new Error("Switch screenshots do not reflect the theme and state.");
    }
    if (process.env.VERA_BROWSER_SWITCH_SCREENSHOT !== undefined) {
        const image = await page.evaluate(async (items) => {
            const images = await Promise.all(items.map(async ({ data }) => {
                const image = new Image();
                image.src = `data:image/png;base64,${data}`;
                await image.decode();
                return image;
            }));
            const width = Math.max(...images.map((item) => item.width)) * 2;
            const height = Math.max(...images.map((item) => item.height)) * 2;
            const header = 30;
            const canvas = document.createElement("canvas");
            canvas.width = width * 3;
            canvas.height = (height + header) * 2;
            const context = canvas.getContext("2d");
            if (context === null) throw new Error("Canvas unavailable.");
            context.fillStyle = "white";
            context.fillRect(0, 0, canvas.width, canvas.height);
            context.fillStyle = "black";
            context.font = "18px sans-serif";
            context.imageSmoothingEnabled = false;
            images.forEach((item, index) => {
                const x = (index % 3) * width;
                const y = Math.floor(index / 3) * (height + header);
                context.fillText(items[index].name, x + 6, y + 21);
                context.drawImage(item, x, y + header, item.width * 2, item.height * 2);
            });
            return canvas.toDataURL("image/png").split(",")[1];
        }, tiles.map((name) => ({ name, data: shots.get(name).toString("base64") })));
        writeFileSync(process.env.VERA_BROWSER_SWITCH_SCREENSHOT, Buffer.from(image, "base64"));
        console.log(`Stitched switch screenshot: ${process.env.VERA_BROWSER_SWITCH_SCREENSHOT}`);
    }
    console.log("Browser switch: dark and light off, on and disabled match Settings geometry; keyboard, label, notice and native bounds passed.");
    console.log("browser tools switch e2e passed");
} catch (error) {
    failed = true;
    console.error(error);
    if (page !== undefined) console.error("Page:", await page.locator(".app").innerText().catch(() => "unreadable"));
} finally {
    await trial.cleanup();
    provider.closeAllConnections();
    site.closeAllConnections();
    await Promise.all([new Promise((resolve) => provider.close(resolve)), new Promise((resolve) => site.close(resolve))]);
}
process.exit(failed ? 1 : 0);
