import { openPicker } from "../overlays/store.ts";
import type { AnnexPage } from "../protocol/bridge.ts";

export function showPagePicker(pages: readonly AnnexPage[], open: (page: AnnexPage) => void): void {
    openPicker({
        title: "Vera's Pages",
        items: pages.map((page) => ({ key: page.path, label: page.label, detail: page.path })),
        cut: false,
        choose: (key) => {
            const page = pages.find((candidate) => candidate.path === key);
            if (page !== undefined) open(page);
        },
    });
}
