import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { BrowserToolsNotice } from "../../clients/ui/src/browser/BrowserToolsNotice.tsx";
import { browserSlots } from "../../clients/ui/src/browser/slots.ts";

function render(enabled: boolean, available: boolean): string {
    return renderToStaticMarkup(createElement(BrowserToolsNotice, { enabled, available, onTurnOff: () => {} }));
}

test("@core the Browser tools notice follows the enabled setting", () => {
    expect(render(false, true)).toBe("");
    expect(render(false, false)).toBe("");
    const html = render(true, true);
    expect(html).toContain("Browser tools are on. Vera can open, read and act on pages in the Browser.");
    expect(html).toContain('class="chip chip-button"');
    expect(html).toContain(">Turn off</button>");
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).not.toContain("disabled");
});

test("@core shared Browser tools status remains visible across views", () => {
    try {
        for (const enabled of [false, true]) {
            browserSlots.read({ active: null, tabs: [], toolsEnabled: enabled, toolsAvailable: true, toolsOffBehavior: "ask" });
            for (const view of ["conversation", "settings", "browser"]) {
                const native = browserSlots.get().native;
                const html = renderToStaticMarkup(createElement("main", null,
                    createElement("section", { "data-view": view }),
                    createElement(BrowserToolsNotice, {
                        enabled: native?.toolsEnabled ?? false,
                        available: native?.toolsAvailable ?? false,
                        onTurnOff: () => {},
                    })));
                expect(html.includes("Browser tools are on.")).toBe(enabled);
            }
        }
    } finally {
        browserSlots.reset();
    }
});

test("@core the Browser tools request shows its approved wording and choices", () => {
    const html = renderToStaticMarkup(createElement(BrowserToolsNotice, {
        enabled: false,
        available: true,
        onTurnOff: () => {},
        toolsAsk: { id: "ask" },
    }));
    expect(html).toContain("Vera wants to use the Browser pane. Turn on Browser tools?");
    expect(html).toContain(">Turn on</button>");
    expect(html).toContain(">Not now</button>");
    expect(html).not.toContain("Browser tools are on.");
});

test("@core the notice stays on when the gateway is unavailable", () => {
    const html = render(true, false);
    expect(html).toContain("Browser tools are on.");
    expect(html).toContain("disabled");
    expect(html).toContain(">Turn off</button>");
});
