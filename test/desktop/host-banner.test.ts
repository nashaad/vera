import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { HostBanner } from "../../clients/ui/src/components/HostBanner.tsx";
import type { BannerState } from "../../clients/ui/src/state/connection.ts";

function render(banner: BannerState): string {
    return renderToStaticMarkup(createElement(HostBanner, { banner, onAnswer: () => undefined, onReconnect: () => undefined }));
}

test("@core a refused desktop build shows the refusal and no button that cannot succeed", () => {
    const html = render({
        kind: "outdated",
        tone: "warning",
        title: "Vera was updated",
        detail: "Quit and reopen Vera to continue.",
    });
    expect(html).toContain("Quit and reopen Vera to continue.");
    expect(html).not.toContain("<button");
});

test("a restarting host offers Reconnect and not Run doctor", () => {
    const html = render({ kind: "restarting", tone: "info", title: "Vera is restarting", detail: "d" });
    expect(html).toContain("Reconnect");
    expect(html).not.toContain("Run doctor");
});
