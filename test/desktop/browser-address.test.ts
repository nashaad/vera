import { describe, expect, test } from "bun:test";

import { isAnnexPath, pageAt, resolveAddress } from "../../clients/ui/src/browser/address.ts";
import type { AnnexPage } from "../../clients/ui/src/protocol/bridge.ts";

const BASE = "http://127.0.0.1:8372/";
const PAGES: readonly AnnexPage[] = [
    { label: "Usage", path: "/usage" },
    { label: "Runs", path: "/runs" },
    { label: "Ledger", path: "/x/budget/ledger", extensionId: "vera.budget" },
];

describe("the address bar", () => {
    test("@core an annex address or path retains the page, query and fragment", () => {
        expect(resolveAddress("127.0.0.1:8372/usage?days=7#top", BASE)).toBe("/usage?days=7#top");
        expect(resolveAddress("http://localhost:8372/runs?session=abc", BASE)).toBe("/runs?session=abc");
        expect(resolveAddress("http://[::1]:8372/usage", BASE)).toBe("/usage");
        expect(resolveAddress("http://[::ffff:127.0.0.1]:8372/runs", BASE)).toBe("/runs");
        expect(resolveAddress("http://127.0.0.2:8372/usage", BASE)).toBe("/usage");
        expect(resolveAddress("http://localhost.:8372/usage", BASE)).toBe("/usage");
        expect(resolveAddress("vera.localhost:8372", BASE)).toBe("/");
        expect(resolveAddress("/x/budget/ledger?artifact=1", BASE)).toBe("/x/budget/ledger?artifact=1");
        expect(resolveAddress("", BASE)).toBe("");
    });

    test("@core page names and other websites are not resolved as Vera pages", () => {
        expect(resolveAddress("  Usage ", BASE)).toBe("Usage");
        expect(resolveAddress("ledger", BASE)).toBe("ledger");
        expect(resolveAddress("https://example.com/usage", BASE)).toBe("https://example.com/usage");
        expect(resolveAddress("http://localhost:9999/usage", BASE)).toBe("http://localhost:9999/usage");
        expect(resolveAddress("https://localhost:8372/usage", BASE)).toBe("https://localhost:8372/usage");
        expect(resolveAddress("usage", undefined)).toBe("usage");
        expect(isAnnexPath("//example.com")).toBe(false);
    });

    test("@core a path belongs to a listed page only when it names that page", () => {
        expect(pageAt("/usage", PAGES)?.label).toBe("Usage");
        expect(pageAt("/usage/?days=7#top", PAGES)?.label).toBe("Usage");
        expect(pageAt("/usage/more", PAGES)).toBeUndefined();
        expect(pageAt("/", PAGES)).toBeUndefined();
        expect(pageAt("/\\example.com", PAGES)).toBeUndefined();
    });
});
