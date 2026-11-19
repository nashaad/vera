import { describe, expect, test } from "bun:test";
import { BLOCKED_ANNEX_OPEN_ERROR, BrowserOriginGuard } from "../../clients/desktop/src/browser/origin-guard.ts";

describe("BrowserOriginGuard", () => {
    test("blocks all loopback aliases and representations until the annex is known", () => {
        const guard = new BrowserOriginGuard();
        for (const url of [
            "http://127.0.0.1:3000/",
            "http://localhost:3000/",
            "http://[::1]:3000/",
            "http://vera.localhost:3000/",
            "http://127.1:3000/",
            "http://127.0.0.2:3000/",
            "http://[::ffff:127.0.0.1]:3000/",
            "ws://localhost:3000/socket",
            "https://localhost.:3000/",
        ]) expect(guard.blocks(url)).toBe(true);
        expect(guard.blocks("https://example.com/")).toBe(false);
    });

    test("blocks the annex through aliases but allows other local ports", () => {
        const guard = new BrowserOriginGuard();
        guard.setAnnexUrl("http://127.0.0.1:8372/");
        for (const host of ["127.0.0.1", "127.0.0.2", "localhost", "localhost.", "[::1]", "[::ffff:127.0.0.1]", "vera.localhost"]) {
            expect(guard.blocks(`http://${host}:8372/usage`)).toBe(true);
        }
        expect(guard.blocks("ws://localhost:8372/socket")).toBe(true);
        expect(guard.blocks("wss://localhost:8372/socket")).toBe(false);
        expect(guard.blocks("https://localhost:8372/")).toBe(false);
        expect(guard.blocks("http://localhost:8373/")).toBe(false);
        expect(guard.blocks("http://127.0.0.1:8373/")).toBe(false);
    });

    test("replaces the annex origin and clears to fail closed", () => {
        const guard = new BrowserOriginGuard();
        guard.setAnnexUrl("http://localhost:8372/");
        guard.setAnnexUrl("http://127.0.0.1:9000/");
        expect(guard.blocks("http://vera.localhost:8372/")).toBe(false);
        expect(guard.blocks("http://vera.localhost:9000/")).toBe(true);
        guard.setAnnexUrl("http://example.com:9000/");
        expect(guard.blocks("http://localhost:8373/")).toBe(true);
        guard.setAnnexUrl(undefined);
        expect(guard.blocks("http://localhost:8373/")).toBe(true);
    });
});

expect(BLOCKED_ANNEX_OPEN_ERROR).toBe("Vera pages cannot be opened in the Browser pane.");
