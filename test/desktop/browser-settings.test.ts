import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "bun:test";

import { BrowserSettingsControl } from "../../clients/ui/src/pages/settings/BrowserSection.tsx";
import { SETTINGS_SECTIONS } from "../../clients/ui/src/pages/settings/sections.ts";

describe("Browser settings", () => {
    test("keeps Appearance as the default section", () => {
        expect(SETTINGS_SECTIONS[0]?.id).toBe("appearance");
        expect(SETTINGS_SECTIONS.some((section) => section.id === "browser")).toBe(true);
    });

    test("offers Ask me and Refuse, defaulting to Ask me before state arrives", () => {
        const html = renderToStaticMarkup(createElement(BrowserSettingsControl, {
            behavior: "ask",
            available: true,
            onChange: () => undefined,
        }));

        expect(html).toContain("When Browser tools are off");
        expect(html).toContain(">Ask me</button>");
        expect(html).toContain(">Refuse</button>");
        expect(html).toContain('aria-pressed="true"');
        expect(html).not.toContain("disabled");
    });

    test("disables the choices while the Browser connection is unavailable", () => {
        const html = renderToStaticMarkup(createElement(BrowserSettingsControl, {
            behavior: "refuse",
            available: false,
            onChange: () => undefined,
        }));

        expect(html).toContain('aria-pressed="true" disabled=""');
    });
});
