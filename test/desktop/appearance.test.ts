import { expect, test } from "bun:test";

import { themeFile } from "../../clients/ui/src/theme/apply.ts";
import { applyAppearance, DEFAULT_APPEARANCE, readAppearance, storeAppearance } from "../../clients/ui/src/theme/preferences.ts";

function memoryStorage(initial?: string) {
    const items = new Map<string, string>(initial === undefined ? [] : [["vera.appearance", initial]]);
    return { getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => void items.set(key, value) };
}

function fakeRoot() {
    const properties = new Map<string, string>();
    const attributes = new Map<string, string>();
    return {
        properties,
        attributes,
        setAttribute: (name: string, value: string) => void attributes.set(name, value),
        style: { setProperty: (name: string, value: string) => void properties.set(name, value) },
    };
}

test("@core appearance round-trips through storage and falls back field by field", () => {
    const storage = memoryStorage();
    expect(readAppearance(storage)).toEqual(DEFAULT_APPEARANCE);
    const chosen = { textSize: "large", codeSize: "small", density: "compact", reduceMotion: true, pastApprovals: true } as const;
    storeAppearance(chosen, storage);
    expect(readAppearance(storage)).toEqual(chosen);
    expect(readAppearance(memoryStorage("{\"textSize\":\"huge\",\"density\":\"comfortable\"}")))
        .toEqual({ ...DEFAULT_APPEARANCE, density: "comfortable" });
    expect(readAppearance(memoryStorage("not json"))).toEqual(DEFAULT_APPEARANCE);
});

test("the default appearance leaves the theme's values as they are", () => {
    const root = fakeRoot();
    applyAppearance(DEFAULT_APPEARANCE, "dark", root);
    const values = themeFile("dark").values;
    expect(root.properties.get("--vera-font-size")).toBe(values["font-size"]);
    expect(root.properties.get("--vera-space")).toBe(values.space);
    expect(root.properties.get("--vera-motion")).toBe(values.motion);
    expect(root.attributes.get("data-density")).toBe("default");
});

test("larger text, compact density and reduced motion scale the theme's own values", () => {
    const root = fakeRoot();
    applyAppearance({ ...DEFAULT_APPEARANCE, textSize: "large", density: "compact", reduceMotion: true }, "light", root);
    const values = themeFile("light").values;
    expect(root.properties.get("--vera-font-size-chat")).toBe(`calc(${values["font-size-chat"]} * 1.1)`);
    expect(root.properties.get("--vera-font-size-code")).toBe(values["font-size-code"]);
    expect(root.properties.get("--vera-row-height")).toBe(`calc(${values["row-height"]} * 0.85)`);
    expect(root.properties.get("--vera-motion")).toBe(`calc(${values.motion} * 0)`);
    expect(root.properties.get("--vera-motion-slow")).toBe(`calc(${values["motion-slow"]} * 0)`);
    expect(root.properties.get("--vera-motion-loop")).toBe(`calc(${values["motion-loop"]} * 0)`);
});

test("past approvals is off by default, stored with the other settings and read back only when true", () => {
    expect(DEFAULT_APPEARANCE.pastApprovals).toBe(false);
    expect(readAppearance(memoryStorage("{\"pastApprovals\":\"yes\"}")).pastApprovals).toBe(false);
    expect(readAppearance(memoryStorage("{\"pastApprovals\":true}")).pastApprovals).toBe(true);
});
