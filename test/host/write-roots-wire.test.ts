import { expect, test } from "bun:test";

import { parseHostRequest } from "../../src/host/protocol.ts";
import { MAX_SESSION_WRITE_ROOTS } from "../../src/store/session-write-roots.ts";

test("@core a create request carries write roots as an additive field", () => {
    const request = parseHostRequest(JSON.stringify({
        type: "create_agent",
        workspace: "/work/vera",
        write_roots: ["/mnt/shared", "/mnt/scratch"],
    }));

    expect(request).toEqual({
        type: "create_agent",
        workspace: "/work/vera",
        write_roots: ["/mnt/shared", "/mnt/scratch"],
    });
    expect(parseHostRequest(JSON.stringify({
        type: "create_agent",
        workspace: "/work/vera",
    }))).toEqual({ type: "create_agent", workspace: "/work/vera" });
    expect(parseHostRequest(JSON.stringify({
        type: "create_agent",
        workspace: "/work/vera",
        write_roots: [],
    }))).toEqual({
        type: "create_agent",
        workspace: "/work/vera",
        write_roots: [],
    });
});

test("a create request refuses malformed write roots", () => {
    for (const writeRoots of [
        ["relative/path"],
        [""],
        ["/mnt/with\0nul"],
        [42],
        Array.from(
            { length: MAX_SESSION_WRITE_ROOTS + 1 },
            (_, index) => `/mnt/root-${index}`,
        ),
    ]) {
        expect(parseHostRequest(JSON.stringify({
            type: "create_agent",
            workspace: "/work/vera",
            write_roots: writeRoots,
        }))).toBeUndefined();
    }
});
