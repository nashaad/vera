import { expect, test } from "bun:test";
import { createPickerPreview } from "../../clients/ui/src/theme/picker-preview.ts";
import { filterThemes } from "../../clients/ui/src/theme/picker-search.ts";
import { BUILTIN_THEME_REGISTRY } from "../../clients/ui/src/theme/registry.ts";
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

test("@core ranked theme search previews Light instead of the saved Dark theme", () => {
    const applied: ThemeChoice[] = [];
    const stored: ThemeChoice[] = [];
    const picker = createPickerPreview("dark", (choice) => applied.push(choice), (choice) => stored.push(choice));
    const search = (query: string) => picker.search(filterThemes(BUILTIN_THEME_REGISTRY, query).map((theme) => theme.name), query);

    expect(search("l")).toBe("light");
    expect(search("light")).toBe("light");
    expect(applied).toEqual(["light"]);
    expect(stored).toEqual([]);
    expect(search("")).toBe("dark");
    expect(applied).toEqual(["light", "dark"]);
});

test("@core theme search previews the first match and restores the saved theme on clear or no match", () => {
    const applied: ThemeChoice[] = [];
    const stored: ThemeChoice[] = [];
    const picker = createPickerPreview("dark", (choice) => applied.push(choice), (choice) => {
        applied.push(choice);
        stored.push(choice);
    });
    const themes: { choice: ThemeChoice; label: string; description: string }[] = [
        { choice: "dark", label: "Dark", description: "dark surfaces" },
        { choice: "gruvbox-dark-hard", label: "Gruvbox Dark Hard", description: "warm brown" },
        { choice: "gruvbox-light-hard", label: "Gruvbox Light Hard", description: "warm ink" },
        { choice: "imported:crow.night", label: "Crow Night", description: "Imported. Crow." },
    ];
    const search = (query: string) => picker.search(filterThemes(themes, query).map((theme) => theme.choice), query);

    expect(search("gruv")).toBe("gruvbox-dark-hard");
    expect(search("gruv light")).toBe("gruvbox-light-hard");
    expect(stored).toEqual([]);
    expect(search("zzz")).toBeUndefined();
    expect(applied.at(-1)).toBe("dark");
    expect(stored).toEqual([]);
    expect(search("crow")).toBe("imported:crow.night");
    expect(search("")).toBe("dark");
    expect(applied.at(-1)).toBe("dark");
    expect(stored).toEqual([]);

    expect(search("gruv light")).toBe("gruvbox-light-hard");
    picker.commit("gruvbox-light-hard");
    expect(search("crow")).toBe("imported:crow.night");
    expect(search("")).toBe("gruvbox-light-hard");
    expect(applied.at(-1)).toBe("gruvbox-light-hard");
    expect(stored).toEqual(["gruvbox-light-hard"]);
});
