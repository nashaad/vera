import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, open, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";

import { IMAGE_ATTACHMENT_LIMITS } from "../../src/attachments/image.ts";
import { includedExtensionConfigs } from "../../src/extensions/included.ts";
import { loadExtensionManifest } from "../../src/extensions/manifest.ts";
import { startExtensionRegistry } from "../../src/extensions/registry.ts";
import { executeToolHandler } from "../../src/tools/execute.ts";
import { ToolRuntime } from "../../src/tools/runtime.ts";

const directories: string[] = [];
const signal = new AbortController().signal;
let registry: Awaited<ReturnType<typeof startExtensionRegistry>>;

beforeAll(async () => {
    const configs = includedExtensionConfigs([]).filter((entry) =>
        loadExtensionManifest(entry.path).manifest.id === "vera.view-image"
    );
    expect(configs).toHaveLength(1);
    registry = await startExtensionRegistry({ extensions: configs });
});

afterEach(async () => {
    await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

afterAll(async () => {
    await registry.close();
});

test("@core view_image registers as an included read tool with the approved schema", () => {
    const tools = registry.tools();
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
        permissionInputs: [{ field: "path", kind: "path", verb: "read" }],
        definition: {
            name: "view_image",
            description: "View a still PNG, JPEG, GIF or WebP image at any path available to Vera, up to 20 MiB. Relative paths resolve from the workspace. A model without image input gets a note that the image was omitted.",
            inputSchema: {
                type: "object",
                properties: {
                    path: {
                        type: "string",
                        description: "Path to the local image file, absolute or relative to the workspace.",
                    },
                },
                required: ["path"],
                additionalProperties: false,
            },
        },
    });
    expect(tools[0]!.permissionOperation).toBeUndefined();
    expect(includedExtensionConfigs(["vera.view-image"]).some((entry) =>
        loadExtensionManifest(entry.path).manifest.id === "vera.view-image"
    )).toBe(false);
});

test("@core view_image returns supported still formats using workspace and absolute paths", async () => {
    const root = await temporaryDirectory();
    for (const format of ["png", "jpeg", "gif", "webp"] as const) {
        const filename = `cove.${format}`;
        const path = join(root, filename);
        const bytes = await sharp({
            create: { width: 3, height: 2, channels: 3, background: "red" },
        }).toFormat(format).toBuffer();
        await writeFile(path, bytes);
        for (const input of [filename, path]) {
            expect(await view(root, input)).toMatchObject({
                kind: "output",
                output: `${filename}: ${format.toUpperCase()}, 3x2, ${bytes.length} bytes`,
                isError: false,
                imagePaths: [await realpath(path)],
            });
        }
    }
});

test("@core view_image reports decoded metadata in one line for unusual names", async () => {
    const root = await temporaryDirectory();
    const filename = "crow\nnest\u2028.jpeg";
    const bytes = await sharp({
        create: { width: 4, height: 5, channels: 3, background: "black" },
    }).png().toBuffer();
    await writeFile(join(root, filename), bytes);
    expect(await view(root, filename)).toMatchObject({
        kind: "output",
        output: `crow\\nnest\\u2028.jpeg: PNG, 4x5, ${bytes.length} bytes`,
        isError: false,
    });
});

test("view_image rejects missing, non-file, invalid, animated and oversized images", async () => {
    const root = await temporaryDirectory();
    const invalid = join(root, "invalid.png");
    await writeFile(invalid, "not an image");
    const oversized = join(root, "large.png");
    const file = await open(oversized, "w");
    try {
        await file.truncate(IMAGE_ATTACHMENT_LIMITS.maxBytes + 1);
    } finally {
        await file.close();
    }
    const tooWide = join(root, "wide.png");
    await writeFile(tooWide, await sharp({
        create: { width: IMAGE_ATTACHMENT_LIMITS.maxWidth + 1, height: 1, channels: 3, background: "red" },
    }).png().toBuffer());
    const animated = join(root, "animated.gif");
    const frames = Uint8Array.from([255, 0, 0, 0, 0, 255]);
    await writeFile(animated, await sharp(frames, {
        raw: { width: 1, height: 2, channels: 3, pageHeight: 1 },
    }).gif().toBuffer());

    for (const [path, message] of [
        ["", "non-empty string"],
        ["missing.png", "not found"],
        [".", "regular file"],
        [invalid, "decoder"],
        [oversized, "maximum"],
        [tooWide, "maximum"],
        [animated, "Animated images are not supported"],
    ] as const) {
        const result = await view(root, path);
        expect(result).toMatchObject({ kind: "output", isError: true, output: expect.stringContaining(message) });
        expect(result).not.toHaveProperty("imagePaths");
    }
    if (process.getuid?.() !== 0) {
        const unreadable = join(root, "unreadable.png");
        await writeFile(unreadable, "not an image");
        await chmod(unreadable, 0);
        expect(await view(root, unreadable)).toMatchObject({
            kind: "output", isError: true, output: expect.stringContaining("EACCES"),
        });
    }
});

test("@core view_image refuses symlinks crossing the workspace boundary in either direction", async () => {
    const root = await temporaryDirectory();
    const workspace = join(root, "workspace");
    const outside = join(root, "outside");
    const sibling = join(root, "workspace-sibling");
    await mkdir(workspace);
    await mkdir(outside);
    await mkdir(sibling);
    const image = await sharp({
        create: { width: 2, height: 2, channels: 3, background: "blue" },
    }).png().toBuffer();
    const inner = join(workspace, "inner.png");
    const outer = join(outside, "outer.png");
    const siblingImage = join(sibling, "sibling.png");
    await writeFile(inner, image);
    await writeFile(outer, image);
    await writeFile(siblingImage, image);
    await symlink(outer, join(workspace, "out.png"));
    await symlink(inner, join(outside, "in.png"));
    await symlink(outside, join(workspace, "external-folder"));
    await symlink(siblingImage, join(workspace, "sibling.png"));
    await symlink(inner, join(workspace, "same.png"));
    await symlink(outer, join(outside, "same.png"));

    for (const [path, target] of [
        ["out.png", outer],
        [join(outside, "in.png"), inner],
        ["external-folder/outer.png", outer],
        ["sibling.png", siblingImage],
    ] as const) {
        const result = await view(workspace, path);
        expect(result).toMatchObject({
            kind: "output", isError: true, output: expect.stringContaining(await realpath(target)),
        });
        expect(result).not.toHaveProperty("imagePaths");
    }
    expect(await view(workspace, "same.png")).toMatchObject({ isError: false, imagePaths: [await realpath(inner)] });
    expect(await view(workspace, join(outside, "same.png"))).toMatchObject({ isError: false, imagePaths: [await realpath(outer)] });
});

async function temporaryDirectory(): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), "vera-view-image-"));
    directories.push(path);
    return path;
}

async function view(workspace: string, path: string) {
    const runtime = new ToolRuntime(workspace);
    try {
        return await executeToolHandler(
            { type: "tool_call", id: "image", name: "view_image", input: { path } },
            runtime,
            signal,
            registry.tools(),
        );
    } finally {
        await runtime.close();
    }
}
