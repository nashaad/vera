import { expect, test } from "bun:test";

/**
 * A slot's label is the user's word for it and may be renamed at any time. Its
 * id is what callers compile against. A caller that matched on the label would
 * break the moment the user changed it, and would do so at the point of use
 * rather than at startup, so the split is only worth having if nothing outside
 * a client reads the label.
 */
test("only clients read a model slot's label", async () => {
    const sourceFiles = new Bun.Glob("src/**/*.ts").scan({
        cwd: process.cwd(),
        absolute: true,
    });
    const readers: string[] = [];

    for await (const path of sourceFiles) {
        if (path.endsWith("src/config/model-slots.ts")) {
            continue;
        }
        const source = await Bun.file(path).text();
        if (/\bslotLabel\s*\(|\bDEFAULT_SLOT_LABELS\b/.test(source)) {
            readers.push(path);
        }
    }

    expect(readers).toEqual([]);
});

test("every slot id has a shipped label and an intent", async () => {
    const { MODEL_SLOT_IDS, DEFAULT_SLOT_LABELS, MODEL_SLOT_INTENTS } =
        await import("../../src/config/model-slots.ts");

    for (const slot of MODEL_SLOT_IDS) {
        expect(DEFAULT_SLOT_LABELS[slot], slot).toBeTruthy();
        expect(MODEL_SLOT_INTENTS[slot], slot).toBeTruthy();
    }
});
