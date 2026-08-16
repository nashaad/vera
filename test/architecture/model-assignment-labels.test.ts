import { expect, test } from "bun:test";

/**
 * A assignment's label is the user's word for it and may be renamed at any time. Its
 * id is what callers compile against. A caller that matched on the label would
 * break the moment the user changed it, and would do so at the point of use
 * rather than at startup, so the split is only worth having if nothing outside
 * a client reads the label.
 */
test("only clients read a model assignment's label", async () => {
    const sourceFiles = new Bun.Glob("src/**/*.ts").scan({
        cwd: process.cwd(),
        absolute: true,
    });
    const readers: string[] = [];

    for await (const path of sourceFiles) {
        if (path.endsWith("src/config/model-assignments.ts")) {
            continue;
        }
        const source = await Bun.file(path).text();
        if (/\bslotLabel\s*\(|\bDEFAULT_SLOT_LABELS\b/.test(source)) {
            readers.push(path);
        }
    }

    expect(readers).toEqual([]);
});

test("every assignment id has a shipped label and an intent", async () => {
    const { MODEL_ASSIGNMENT_IDS, DEFAULT_ASSIGNMENT_LABELS, MODEL_ASSIGNMENT_INTENTS } =
        await import("../../src/config/model-assignments.ts");

    for (const assignment of MODEL_ASSIGNMENT_IDS) {
        expect(DEFAULT_ASSIGNMENT_LABELS[assignment], assignment).toBeTruthy();
        expect(MODEL_ASSIGNMENT_INTENTS[assignment], assignment).toBeTruthy();
    }
});
