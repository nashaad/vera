import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    annexLaunch,
    residentAnnexEntrypoint,
} from "../../src/host/annex-process.ts";
import {
    checkoutPackRoot,
    packedAnnexRoot,
    RELEASE_ANNEX_NAME,
} from "../../src/release/layout.ts";

async function withTemp(body: (root: string) => Promise<void>): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), "vera-annex-launch-"));
    try {
        await body(root);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}

test("a release root supplies the packed annex binary and its assets", async () => {
    await withTemp(async (root) => {
        const release = join(root, "release");
        expect(annexLaunch({ root: release, checkoutRoot: join(root, "checkout") })).toEqual({
            command: [join(release, RELEASE_ANNEX_NAME)],
            assets: packedAnnexRoot(release),
        });
    });
});

test("a development instance with no pack runs the source annex on this checkout's built page", async () => {
    await withTemp(async (root) => {
        const checkout = join(root, "checkout");
        const assets = join(checkout, "dist", "release", "annex");
        await mkdir(assets, { recursive: true });
        await writeFile(join(assets, "index.html"), "<html></html>\n");
        expect(annexLaunch({ root: undefined, checkoutRoot: checkout })).toEqual({
            command: [process.execPath, residentAnnexEntrypoint()],
            assets,
        });
    });
});

test("a development instance with no built page fails and names the pack:web fix", async () => {
    await withTemp(async (root) => {
        const checkout = join(root, "checkout");
        await mkdir(checkout, { recursive: true });
        expect(() => annexLaunch({ root: undefined, checkoutRoot: checkout })).toThrow(
            `This checkout has no built annex page. Run \`bun run pack:web\` in ${checkout}.`,
        );
    });
});

test("explicit command and assets overrides skip the built-page check", async () => {
    await withTemp(async (root) => {
        const checkout = join(root, "checkout");
        await mkdir(checkout, { recursive: true });
        expect(annexLaunch({
            root: undefined,
            checkoutRoot: checkout,
            command: ["/bin/custom-annex"],
            assets: "/somewhere/assets",
        })).toEqual({
            command: ["/bin/custom-annex"],
            assets: "/somewhere/assets",
        });
    });
});

test("the source annex entry comes from this module and the checkout pack from the working directory", () => {
    expect(existsSync(residentAnnexEntrypoint())).toBe(true);
    expect(checkoutPackRoot()).toBe(join(process.cwd(), "dist", "release"));
});
