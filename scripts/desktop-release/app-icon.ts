import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";

import { run } from "./run.ts";

// The mark is a disc with the crow cut out of it. The cut-out shows this colour, as on the site's touch icon.
const CROW_COLOR = "#0b0c10";

const CANVAS = 1_024;
// The disc is drawn at the size of a standard macOS icon body, so it sits beside other icons in the Dock.
const DISC = 824;

// iconutil reads these names: a base size and its @2x.
const ICON_FILES: readonly { readonly name: string; readonly size: number }[] = [
    { name: "icon_16x16.png", size: 16 },
    { name: "icon_16x16@2x.png", size: 32 },
    { name: "icon_32x32.png", size: 32 },
    { name: "icon_32x32@2x.png", size: 64 },
    { name: "icon_128x128.png", size: 128 },
    { name: "icon_128x128@2x.png", size: 256 },
    { name: "icon_256x256.png", size: 256 },
    { name: "icon_256x256@2x.png", size: 512 },
    { name: "icon_512x512.png", size: 512 },
    { name: "icon_512x512@2x.png", size: 1_024 },
];

// Builds an .icns from an SVG mark that the repo already serves, at build time and with iconutil.
export async function writeAppIcon(svgPath: string, icnsPath: string): Promise<void> {
    const scratch = mkdtempSync(join(tmpdir(), "vera-app-icon-"));
    try {
        const iconset = join(scratch, "Vera.iconset");
        mkdirSync(iconset);
        const master = await renderMaster(svgPath);
        for (const file of ICON_FILES) {
            await sharp(master).resize(file.size, file.size, { kernel: "lanczos3" }).png().toFile(join(iconset, file.name));
        }
        run("iconutil", ["-c", "icns", "-o", icnsPath, iconset]);
    } finally {
        rmSync(scratch, { recursive: true, force: true });
    }
}

async function renderMaster(svgPath: string): Promise<Buffer> {
    const edge = (CANVAS - DISC) / 2;
    const mark = await sharp(svgPath, { density: 384 }).resize(DISC, DISC).png().toBuffer();
    const backing = Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${DISC}" height="${DISC}">`
        + `<circle cx="${DISC / 2}" cy="${DISC / 2}" r="${DISC / 2 - 2}" fill="${CROW_COLOR}"/></svg>`,
    );
    return sharp({ create: { width: CANVAS, height: CANVAS, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
        .composite([
            { input: backing, left: edge, top: edge },
            { input: mark, left: edge, top: edge },
        ])
        .png()
        .toBuffer();
}
