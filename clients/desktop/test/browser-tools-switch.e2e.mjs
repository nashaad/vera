import { writeFileSync } from "node:fs";
import { createServer } from "node:http";

import { configureFauxHome, until } from "./faux-home.mjs";
import { MODIFIER, press, startTrial, waitForAnnexPages } from "./trial.mjs";

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
let desktopPid;
let host;
let failed = false;

try {
    await Promise.all([provider, site].map((server) => new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))));
    configureFauxHome(trial.home, provider.address().port);
    const app = await trial.launch({ args: ["--force-device-scale-factor=2"] });
    desktopPid = app.process().pid;
    page = await app.firstWindow();
    await page.waitForSelector('.app[data-sessions="0"]', { timeout: 45_000 });
    host = await trial.waitForHost();
    await waitForAnnexPages(page, app);
    const scale = await page.evaluate(() => window.devicePixelRatio);
    if (scale !== 2) throw new Error(`Expected a 2x device scale, got ${scale}.`);
    console.log(`Switch trial desktop ${desktopPid}, host ${host}, home ${trial.trialRoot}, device scale ${scale}x`);

    await press(app, "K", [MODIFIER]);
    const palette = page.getByRole("textbox", { name: "Command palette" });
    await palette.fill("Open a web page");
    await page.locator('[data-command="page.openBrowser"]').click();
    const pane = page.locator('[data-location="rightPane"]');
    const bar = pane.locator(".browser-bar");
    const tools = bar.getByRole("switch", { name: "Browser tools" });
    const label = bar.locator(".browser-tools-switch");
    const labelText = label.locator(".browser-tools-label");
    const notice = page.locator(".browser-tools-notice");
    const sash = page.getByRole("separator", { name: "Resize rightPane" });
    if (await pane.locator(".browser-controls").count() !== 0) throw new Error("The separate Browser controls row still exists.");
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
    await until("fixture title shown", async () => (await pane.locator('[role="tab"][data-container="core.browser"]').first().innerText()).includes("Switch fixture"));
    await until("fixture address shown", async () => (await address.inputValue()).includes(`:${site.address().port}/`));

    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.locator('main[data-page="settings"]').waitFor();
    const reference = page.getByRole("switch", { name: "Reduce motion" });
    await reference.waitFor();
    await tools.waitFor();

    async function resizePane(target) {
        for (let attempt = 0; attempt < 60; attempt += 1) {
            const current = Number(await sash.getAttribute("aria-valuenow"));
            if (current === target) return;
            await sash.press(current > target ? "ArrowRight" : "ArrowLeft");
        }
        throw new Error(`Could not resize the Browser pane to ${target}px.`);
    }

    async function assertRow(name, textVisible) {
        await until(`${name} label visibility`, async () => await labelText.isVisible() === textVisible);
        const geometry = await bar.evaluate((element) => {
            const barBox = element.getBoundingClientRect();
            const children = [...element.children].map((child) => {
                const box = child.getBoundingClientRect();
                const icon = child.querySelector("svg")?.getBoundingClientRect();
                return { name: child.getAttribute("aria-label") ?? child.className, left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height, iconLeft: icon?.left, iconRight: icon?.right };
            });
            const action = element.closest('.view[data-merged="true"]')?.querySelector(":scope > .view-header .view-actions");
            const actionBox = action?.getBoundingClientRect();
            return { left: barBox.left, right: barBox.right, top: barBox.top, bottom: barBox.bottom, width: barBox.width, actionLeft: actionBox?.left, children };
        });
        for (const [index, item] of geometry.children.entries()) {
            const previous = geometry.children[index - 1];
            if (item.left < geometry.left - 0.5 || item.right > geometry.right + 0.5
                || item.top < geometry.top - 0.5 || item.bottom > geometry.bottom + 0.5
                || (previous !== undefined && item.left < previous.right - 0.5)
                || (item.iconLeft !== undefined && (item.iconLeft < item.left - 0.5 || item.iconRight > item.right + 0.5))
                || Math.abs((item.top + item.bottom) / 2 - (geometry.top + geometry.bottom) / 2) > 1) {
                throw new Error(`${name} has clipped, overlapping or wrapped controls: ${JSON.stringify(geometry)}`);
            }
        }
        const input = geometry.children.find((item) => item.name === "Address");
        if (input === undefined || input.width < 50) throw new Error(`${name} address is too narrow: ${JSON.stringify(geometry)}`);
        if (geometry.actionLeft !== undefined && geometry.children.at(-1).right > geometry.actionLeft) {
            throw new Error(`${name} switch overlaps the view actions: ${JSON.stringify(geometry)}`);
        }
        const button = await bar.getByRole("button", { name: "Back" }).boundingBox();
        const track = await tools.boundingBox();
        if (button === null || track === null || track.height > button.height + 0.1) throw new Error(`${name} switch is taller than the toolbar buttons.`);
        console.log(`${name}: bar ${geometry.width}px, address ${input.width}px, switch ${track.width}x${track.height}px, label ${textVisible ? "shown" : "hidden"}.`);
    }

    await resizePane(240);
    await assertRow("minimum pane", false);
    await resizePane(528);
    await assertRow("wide pane", true);

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
                knobLeft: knob.left,
                knobTop: knob.top,
                knobBackground: knob.backgroundColor,
                knobRadius: knob.borderRadius,
                knobTransform: knob.transform,
                knobTravel: knob.transform === "none" ? 0 : new DOMMatrixReadOnly(knob.transform).m41,
                knobTransition: knob.transition,
            };
        });
    }

    async function sameSwitch(theme, state) {
        await page.mouse.move(0, 0);
        const keys = ["padding", "background", "border", "radius", "knobBackground", "knobRadius", "knobTransition"];
        try {
            await until(`${theme} ${state} matches Settings colors and treatment`, async () => {
                const actual = await style(tools);
                const expected = await style(reference);
                return keys.every((key) => actual[key] === expected[key]);
            }, 5_000);
        } catch {
            throw new Error(`${theme} ${state} switch differs from Settings: ${JSON.stringify({ actual: await style(tools), expected: await style(reference) })}`);
        }
    }

    const offGaps = new Map();
    async function assertGeometry(theme, state) {
        const checked = state !== "off";
        await until(`${theme} ${state} knob transition`, async () => {
            const browser = await style(tools);
            const settings = await style(reference);
            return checked ? browser.knobTravel > 0 && settings.knobTravel > 0
                : Math.abs(browser.knobTravel) < 0.1 && Math.abs(settings.knobTravel) < 0.1;
        });
        await page.waitForTimeout(300);
        const actual = await tools.evaluate((element) => {
            const label = element.closest("label");
            const text = label.querySelector(".browser-tools-label").getBoundingClientRect();
            const box = element.getBoundingClientRect();
            const knob = element.querySelector(".appearance-switch-knob").getBoundingClientRect();
            const css = getComputedStyle(label);
            const track = getComputedStyle(element);
            return {
                width: box.width,
                height: box.height,
                center: box.y + box.height / 2,
                textCenter: text.y + text.height / 2,
                lineHeight: Number.parseFloat(css.lineHeight),
                fontSize: Number.parseFloat(getComputedStyle(document.body).fontSize),
                space: Number.parseFloat(css.columnGap),
                knobWidth: knob.width,
                knobHeight: knob.height,
                top: knob.top - box.top,
                bottom: box.bottom - knob.bottom,
                left: knob.left - box.left,
                right: box.right - knob.right,
                borderLeft: Number.parseFloat(track.borderLeftWidth),
                borderRight: Number.parseFloat(track.borderRightWidth),
            };
        });
        const settings = await reference.boundingBox();
        const browserStyle = await style(tools);
        const settingsStyle = await style(reference);
        const near = (value, target) => Math.abs(value - target) < 0.1;
        const unit = Math.min(actual.space, actual.lineHeight / 3.5, actual.fontSize / 3.25);
        const expectedTravel = actual.width - actual.borderLeft - actual.borderRight - unit * 0.75 - actual.knobWidth;
        if (settings === null || !Number.isFinite(actual.lineHeight) || !Number.isFinite(actual.space)
            || !near(actual.width, unit * 6) || !near(actual.height, unit * 3.5)
            || !near(settings.width, actual.space * 9) || !near(settings.height, actual.space * 5)
            || !near(actual.knobWidth, unit * 2.25) || !near(actual.knobHeight, unit * 2.25)
            || !near(Number.parseFloat(browserStyle.knobLeft), unit * 0.375)
            || !near(Number.parseFloat(settingsStyle.knobWidth), actual.space * 3.5)
            || !near(Number.parseFloat(settingsStyle.knobHeight), actual.space * 3.5)
            || !near(browserStyle.knobTravel, checked ? expectedTravel : 0)
            || !near(settingsStyle.knobTravel, checked ? actual.space * 4 : 0)
            || actual.width >= settings.width || actual.height >= settings.height
            || actual.height > actual.lineHeight || Math.abs(actual.center - actual.textCenter) > 1.5
            || Math.abs(actual.top - actual.bottom) > 0.5
            || Math.min(actual.top, actual.bottom, actual.left, actual.right) <= 1) {
            throw new Error(`${theme} ${state} switch geometry: ${JSON.stringify({ actual, settings, browserStyle, settingsStyle })}`);
        }
        if (!checked) offGaps.set(theme, actual.left);
        else if (Math.abs(offGaps.get(theme) - actual.right) > 0.5) {
            throw new Error(`${theme} knob gaps differ: off left ${offGaps.get(theme)}, ${state} right ${actual.right}.`);
        }
        console.log(`${theme} ${state}: track ${actual.width}x${actual.height}px, knob ${actual.knobWidth}x${actual.knobHeight}px, gaps top/bottom/left/right ${actual.top}/${actual.bottom}/${actual.left}/${actual.right}px, Settings ${settings.width}x${settings.height}px.`);
    }

    async function setReference(enabled) {
        if (await reference.isChecked() !== enabled) await reference.click();
        await until(`Settings switch ${enabled}`, async () => await reference.isChecked() === enabled);
    }

    async function setTools(enabled) {
        if (await tools.isChecked() !== enabled) await tools.click();
        await until(`Browser switch ${enabled}`, async () => await tools.isChecked() === enabled);
        await until(`Browser tooltip ${enabled}`, async () => await tools.getAttribute("title") === `Browser tools ${enabled ? "on" : "off"}`);
        await until(`notice ${enabled}`, async () => await notice.isVisible().catch(() => false) === enabled);
    }

    async function clickLabelText() {
        const text = await labelText.boundingBox();
        if (text === null) throw new Error("Browser tools label was not visible.");
        await page.mouse.click(text.x + text.width / 2, text.y + text.height / 2);
    }

    async function assertNativeLayout() {
        await until("native bounds match Browser frame", async () => {
            const bounds = await nativeBounds();
            const frame = await pane.locator(".browser-frame").boundingBox();
            const row = await bar.boundingBox();
            if (bounds === undefined || frame === null || row === null) return false;
            return Math.abs(bounds.x - frame.x) <= 1 && Math.abs(bounds.y - frame.y) <= 1
                && Math.abs(bounds.width - frame.width) <= 1 && Math.abs(bounds.height - frame.height) <= 1
                && bounds.y >= row.y + row.height;
        });
    }

    const shots = new Map();
    const barShots = new Map();
    async function capture(theme, state) {
        await page.mouse.move(0, 0);
        await tools.evaluate((element) => element.blur());
        const png = await tools.screenshot();
        const box = await tools.boundingBox();
        const pixels = { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
        if (box === null || Math.abs(pixels.width - box.width * 2) > 2
            || Math.abs(pixels.height - box.height * 2) > 2) {
            throw new Error(`${theme} ${state} switch crop is not at 2x device scale: ${JSON.stringify({ pixels, box })}`);
        }
        shots.set(`${theme}-${state}`, png);
        if (theme === "dark" && state !== "disabled") barShots.set(`wide ${state}`, await bar.screenshot());
    }

    for (const theme of ["dark", "light"]) {
        await selectTheme(theme);
        await setTools(false);
        await setReference(false);
        await sameSwitch(theme, "off");
        await assertGeometry(theme, "off");
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
        await assertGeometry(theme, "on");
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

    await selectTheme("dark");
    await setTools(false);
    await resizePane(240);
    await assertRow("minimum pane after toggles", false);
    await assertNativeLayout();
    await tools.click();
    await until("narrow switch turns tools on", () => tools.isChecked());
    await until("narrow tooltip shows on", async () => await tools.getAttribute("title") === "Browser tools on");
    await setTools(false);
    barShots.set("narrow off", await bar.screenshot());
    await resizePane(528);
    await assertRow("wide pane restored", true);
    await assertNativeLayout();

    await page.locator('[data-theme-card="high-contrast"]').click();
    await until("high-contrast theme applied", () => page.evaluate(() => document.documentElement.getAttribute("data-theme") === "high-contrast"));
    const textSize = page.getByRole("group", { name: "Text size" });
    const density = page.getByRole("group", { name: "Density" });
    await textSize.getByRole("button", { name: "Small" }).click();
    await density.getByRole("button", { name: "Comfortable" }).click();
    await setTools(false);
    await setReference(false);
    await sameSwitch("high contrast", "off");
    await assertGeometry("high contrast", "off");
    await setTools(true);
    await setReference(true);
    await sameSwitch("high contrast", "on");
    await assertGeometry("high contrast", "on");
    await assertRow("high contrast wide pane", true);
    await resizePane(240);
    await assertRow("high contrast minimum pane", false);
    await assertNativeLayout();
    await resizePane(528);
    await textSize.getByRole("button", { name: "Default" }).click();
    await density.getByRole("button", { name: "Default" }).click();

    await setTools(true);
    await setReference(true);
    process.kill(host, "SIGTERM");
    await until("Browser switch unavailable", async () => !await tools.isEnabled(), 20_000);
    if (!await tools.isChecked() || !await notice.isVisible()) throw new Error("The armed setting disappeared on disconnect.");
    for (const theme of ["dark", "light"]) {
        await selectTheme(theme);
        await reference.evaluate((element) => { element.disabled = true; });
        await sameSwitch(theme, "disabled");
        await assertGeometry(theme, "disabled");
        const disabled = await style(tools);
        if (disabled.opacity !== "0.6" || disabled.cursor !== "default") throw new Error(`${theme} disabled treatment is missing.`);
        await capture(theme, "disabled");
        await clickLabelText();
        if (!await tools.isChecked() || !await notice.isVisible()) throw new Error(`${theme}: disabled label changed the setting.`);
    }

    if (shots.get("dark-off").equals(shots.get("light-off")) || shots.get("dark-off").equals(shots.get("dark-on"))) {
        throw new Error("Switch screenshots do not reflect the theme and state.");
    }
    if (process.env.VERA_BROWSER_SWITCH_SCREENSHOT !== undefined) {
        const items = [
            ...["wide off", "wide on", "narrow off"].map((name) => ({ name, data: barShots.get(name).toString("base64") })),
            ...["dark-off", "dark-on", "dark-disabled", "light-off", "light-on", "light-disabled"].map((name) => ({ name, data: shots.get(name).toString("base64") })),
        ];
        const image = await page.evaluate(async (captures) => {
            const images = await Promise.all(captures.map(async ({ data }) => {
                const image = new Image();
                image.src = `data:image/png;base64,${data}`;
                await image.decode();
                return image;
            }));
            const header = 28;
            const rowHeight = Math.max(...images.slice(0, 3).map((item) => item.height));
            const cropWidth = Math.max(...images.slice(3).map((item) => item.width)) * 3 + 30;
            const cropHeight = Math.max(...images.slice(3).map((item) => item.height)) * 3;
            const canvas = document.createElement("canvas");
            canvas.width = Math.max(...images.slice(0, 3).map((item) => item.width), cropWidth * 6);
            canvas.height = (rowHeight + header) * 3 + cropHeight + header;
            const context = canvas.getContext("2d");
            if (context === null) throw new Error("Canvas unavailable.");
            context.fillStyle = "white";
            context.fillRect(0, 0, canvas.width, canvas.height);
            context.fillStyle = "black";
            context.font = "18px sans-serif";
            context.imageSmoothingEnabled = false;
            images.forEach((item, index) => {
                const x = index < 3 ? 0 : (index - 3) * cropWidth;
                const y = index < 3 ? index * (rowHeight + header) : 3 * (rowHeight + header);
                context.fillText(captures[index].name, x + 6, y + 21);
                context.drawImage(item, x, y + header, item.width * (index < 3 ? 1 : 3), item.height * (index < 3 ? 1 : 3));
            });
            return canvas.toDataURL("image/png").split(",")[1];
        }, items);
        writeFileSync(process.env.VERA_BROWSER_SWITCH_SCREENSHOT, Buffer.from(image, "base64"));
        console.log(`Stitched 2x toolbar and switch crops: ${process.env.VERA_BROWSER_SWITCH_SCREENSHOT}`);
    }
    console.log("Browser switch: compact geometry, Settings treatment, keyboard, label, notice and native bounds passed.");
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
    for (const pid of [desktopPid, host]) {
        if (pid === undefined) continue;
        await until(`trial process ${pid} exited`, () => {
            try {
                process.kill(pid, 0);
                return false;
            } catch (error) {
                if (error.code !== "ESRCH") throw error;
                return true;
            }
        }, 10_000);
    }
    console.log("Switch trial desktop and host exited.");
}
process.exit(failed ? 1 : 0);
