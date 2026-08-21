import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const packageRoot = process.argv[2];
if (packageRoot === undefined) {
    throw new Error("usage: release-npm-native-smoke.ts <installed-package-directory>");
}

const root = resolve(packageRoot);
const sharpUrl = pathToFileURL(join(root, "node_modules", "sharp", "dist", "index.mjs")).href;
const sharp = (await import(sharpUrl)).default;
const image = await sharp({
    create: {
        width: 2,
        height: 3,
        channels: 4,
        background: { r: 1, g: 2, b: 3, alpha: 1 },
    },
}).png().toBuffer();
const metadata = await sharp(image).metadata();
if (metadata.width !== 2 || metadata.height !== 3 || image.byteLength === 0) {
    throw new Error("installed Sharp native smoke returned invalid image data");
}

const openTuiUrl = pathToFileURL(
    join(root, "node_modules", "@opentui", "core", "testing.js"),
).href;
const { createTestRenderer } = await import(openTuiUrl);
const setup = await createTestRenderer({ width: 20, height: 4 });
setup.renderer.destroy();

console.log(JSON.stringify({
    bun: Bun.version,
    sharp: true,
    openTui: true,
    width: metadata.width,
    height: metadata.height,
    bytes: image.byteLength,
}));
