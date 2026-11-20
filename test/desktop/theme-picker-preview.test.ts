import { expect, test } from "bun:test";
import { createPickerPreview } from "../../clients/ui/src/theme/picker-preview.ts";
import type { ThemeChoice } from "../../clients/ui/src/theme/tokens.ts";

test("@core theme picker previews without storing and restores the latest commit", () => {
    const applied: ThemeChoice[] = [];
    const stored: ThemeChoice[] = [];
    const picker = createPickerPreview("dark", (choice) => applied.push(choice), (choice) => {
        applied.push(choice);
        stored.push(choice);
    });
    picker.restore();
    picker.preview("light");
    picker.commit("light");
    picker.preview("imported:crow.night");
    picker.restore();
    picker.restore();
    expect(applied).toEqual(["light", "light", "imported:crow.night", "light"]);
    expect(stored).toEqual(["light"]);
});

test("@core theme picker rapid previews cannot follow a commit or restore", () => {
    const applied: ThemeChoice[] = [];
    const picker = createPickerPreview("dark", (choice) => applied.push(choice), (choice) => applied.push(choice));
    picker.preview("light");
    picker.preview("github");
    picker.commit("light");
    picker.preview("github");
    picker.restore();
    expect(applied).toEqual(["light", "github", "light", "github", "light"]);
});
