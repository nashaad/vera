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
            defaultBrowser: "ask",
            available: true,
            onChange: () => undefined,
            onDefaultBrowserChange: () => undefined,
        }));

        expect(html).toContain("When Browser tools are off");
        expect(html).toContain(">Ask me</button>");
        expect(html).toContain(">Refuse</button>");
        expect(html).toContain('aria-pressed="true"');
        expect(html).not.toContain("disabled");
    });

    test("offers the default browser choices in the same row shape", () => {
        const html = renderToStaticMarkup(createElement(BrowserSettingsControl, {
            behavior: "ask",
            defaultBrowser: "pane",
            available: true,
            onChange: () => undefined,
            onDefaultBrowserChange: () => undefined,
        }));

        expect(html).toContain("Default browser");
        expect(html).toContain(">Browser pane</button>");
        expect(html).toContain(">Chrome</button>");
        expect(html).toContain(">Ask each chat</button>");
        expect(html.match(/aria-pressed="true"/g)).toHaveLength(2);
        expect(html).not.toContain("disabled");
    });

    test("defaults the browser choice to Ask each chat before state arrives", () => {
        const html = renderToStaticMarkup(createElement(BrowserSettingsControl, {
            behavior: "ask",
            defaultBrowser: "ask",
            available: true,
            onChange: () => undefined,
            onDefaultBrowserChange: () => undefined,
        }));

        expect(html).toContain('aria-pressed="true">Ask each chat</button>');
    });

    test("disables the choices while the Browser connection is unavailable", () => {
        const html = renderToStaticMarkup(createElement(BrowserSettingsControl, {
            behavior: "refuse",
            defaultBrowser: "chrome",
            available: false,
            onChange: () => undefined,
            onDefaultBrowserChange: () => undefined,
        }));

        expect(html).toContain('aria-pressed="true" disabled=""');
        expect(html.match(/disabled=""/g)).toHaveLength(5);
    });
});
