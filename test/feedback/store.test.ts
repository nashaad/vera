import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { saveFeedback } from "../../src/feedback/store.ts";

const homes: string[] = [];
function home(): string {
    const path = mkdtempSync(join(tmpdir(), "vera-feedback-test-"));
    homes.push(path);
    return path;
}
afterEach(() => { for (const path of homes.splice(0)) rmSync(path, { recursive: true, force: true }); });
const report = { kind: "bug", title: "Crow cannot sail", description: "The boat is stuck.", source: "terminal" } as const;
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

describe("feedback store", () => {
    test("writes a report and image into a persistent folder", async () => {
        const root = home();
        const image = join(root, "input.png");
        writeFileSync(image, png);
        const path = await saveFeedback(root, { ...report, imagePaths: [image], sessionId: "crow" });
        const saved = JSON.parse(readFileSync(join(path, "report.json"), "utf8"));
        expect(saved).toMatchObject({ id: basename(path), ...report, session_id: "crow", images: ["image-1.png"] });
        expect(readFileSync(join(path, "image-1.png"))).toEqual(png);
        expect(path.startsWith(join(root, "machine", "feedback"))).toBe(true);
    });
    test("refuses invalid fields and images without leaving a report", async () => {
        const root = home();
        await expect(saveFeedback(root, { ...report, title: " " })).rejects.toThrow();
        await expect(saveFeedback(root, { ...report, title: "a".repeat(201) })).rejects.toThrow();
        await expect(saveFeedback(root, { ...report, description: "a".repeat(20_001) })).rejects.toThrow();
        await expect(saveFeedback(root, { ...report, imagePaths: Array(5).fill("no") })).rejects.toThrow();
        const large = join(root, "large.png");
        writeFileSync(large, Buffer.alloc(10 * 1024 * 1024 + 1));
        await expect(saveFeedback(root, { ...report, imagePaths: [large] })).rejects.toThrow();
        await expect(saveFeedback(root, { ...report, imagePaths: ["missing"] })).rejects.toThrow();
        expect(readdirSync(root)).toEqual(["large.png"]);
    });
    test("refuses the 501st report without deleting any", async () => {
        const root = home();
        const parent = join(root, "machine", "feedback");
        mkdirSync(parent, { recursive: true });
        for (let n = 0; n < 500; n++) mkdirSync(join(parent, String(n)));
        await expect(saveFeedback(root, report)).rejects.toThrow(parent);
        expect(readdirSync(parent)).toHaveLength(500);
    });
});

test("a write failure removes the temporary folder", async () => {
    const root = home();
    const fail = (() => { throw new Error("disk full"); }) as typeof writeFileSync;
    await expect(saveFeedback(root, report, fail)).rejects.toThrow("disk full");
    expect(readdirSync(join(root, "machine", "feedback"))).toEqual([]);
});

test("concurrent processes cannot exceed the report cap", async () => {
    const root = home();
    const parent = join(root, "machine", "feedback");
    mkdirSync(parent, { recursive: true });
    for (let n = 0; n < 499; n++) mkdirSync(join(parent, String(n)));
    const worker = join(import.meta.dir, "save-worker.ts");
    const first = Bun.spawn([process.execPath, worker, root], { stdout: "ignore", stderr: "ignore" });
    const second = Bun.spawn([process.execPath, worker, root], { stdout: "ignore", stderr: "ignore" });
    expect((await Promise.all([first.exited, second.exited])).sort()).toEqual([0, 1]);
    expect(readdirSync(parent)).toHaveLength(500);
});

test("a lock left by an interrupted save is taken over once it is stale", async () => {
    const root = home();
    const lock = join(root, "machine", "feedback", ".lock");
    mkdirSync(lock, { recursive: true });
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    const path = await saveFeedback(root, report);
    expect(readdirSync(join(root, "machine", "feedback"))).toEqual([basename(path)]);
});
