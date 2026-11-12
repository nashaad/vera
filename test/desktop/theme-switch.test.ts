import { expect, test } from "bun:test";

import { activateTheme } from "../../clients/ui/src/theme/activate.ts";
import { applyTheme, startingThemeName, themeFile } from "../../clients/ui/src/theme/apply.ts";
import type { ThemeRoot } from "../../clients/ui/src/theme/apply.ts";

function fakeRoot(): { root: ThemeRoot; values: Map<string, string>; attribute: () => string } {
    const values = new Map<string, string>();
    let attribute = "";
    const root: ThemeRoot = {
        setAttribute(name: string, value: string): void {
            if (name === "data-theme") attribute = value;
        },
        style: {
            setProperty(name: string, value: string): void {
                values.set(name, value);
            },
        },
    };
    return { root, values, attribute: () => attribute };
}

test("@core switching themes applies at once without CSS or a reload", () => {
    const page = fakeRoot();
    applyTheme("dark", page.root);
    expect(page.attribute()).toBe("dark");
    expect(page.values.get("--vera-surface")).toBe(themeFile("dark").palette.canvas);
    expect(page.values.get("--vera-motion")).toBe(themeFile("dark").values.motion);

    applyTheme("light", page.root);
    expect(page.attribute()).toBe("light");
    expect(page.values.get("--vera-surface")).toBe(themeFile("light").palette.canvas);
    expect(page.values.get("--vera-surface")).not.toBe(themeFile("dark").palette.canvas);

    applyTheme("high-contrast", page.root);
    expect(page.attribute()).toBe("high-contrast");
    expect(page.values.get("--vera-radius")).toBe(themeFile("high-contrast").values.radius);
    expect(page.values.get("color-scheme")).toBe("dark");
});

test("@core the starting theme is dark", () => {
    expect(startingThemeName()).toBe("dark");
});

test("@core activating a theme reports the resolved surface to the window", () => {
    const page = fakeRoot();
    const reported: string[] = [];
    const bridge = { setWindowBackground: (color: string): void => { reported.push(color); } };
    const surface = (): string => ` ${page.values.get("--vera-surface") ?? ""} `;

    activateTheme("dark", { root: page.root, bridge, surface });
    activateTheme("light", { root: page.root, bridge, surface });

    expect(reported).toHaveLength(2);
    expect(reported[0]).toBe(themeFile("dark").palette.canvas);
    expect(reported[1]).toBe(themeFile("light").palette.canvas);
});

test("activating a theme without a window bridge or a surface value reports nothing", () => {
    const page = fakeRoot();
    const reported: string[] = [];
    const bridge = { setWindowBackground: (color: string): void => { reported.push(color); } };

    activateTheme("dark", { root: page.root, bridge, surface: () => "  " });
    expect(reported).toEqual([]);
    expect(page.attribute()).toBe("dark");

    const withoutBridge = { root: page.root, surface: () => "#000000" };
    expect(() => activateTheme("light", withoutBridge)).not.toThrow();
});
