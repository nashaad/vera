import { expect, test } from "bun:test";

import { parseHostRequest } from "../../src/host/protocol.ts";
import { MAX_SESSION_ROOTS } from "../../src/store/session-roots.ts";

test("@core a create request carries read roots as an additive field", () => {
    const request = parseHostRequest(JSON.stringify({
        type: "create_agent",
        workspace: "/work/vera",
        read_roots: ["/mnt/shared", "/mnt/scratch"],
    }));

    expect(request).toEqual({
        type: "create_agent",
        workspace: "/work/vera",
        read_roots: ["/mnt/shared", "/mnt/scratch"],
    });
    expect(parseHostRequest(JSON.stringify({
        type: "create_agent",
        workspace: "/work/vera",
    }))).toEqual({ type: "create_agent", workspace: "/work/vera" });
    expect(parseHostRequest(JSON.stringify({
        type: "create_agent",
        workspace: "/work/vera",
        read_roots: [],
    }))).toEqual({
        type: "create_agent",
        workspace: "/work/vera",
        read_roots: [],
    });
});

test("a create request refuses malformed read roots", () => {
    for (const readRoots of [
        ["relative/path"],
        [""],
        ["/mnt/with\0nul"],
        [42],
        Array.from(
            { length: MAX_SESSION_ROOTS + 1 },
            (_, index) => `/mnt/root-${index}`,
        ),
    ]) {
        expect(parseHostRequest(JSON.stringify({
            type: "create_agent",
            workspace: "/work/vera",
            read_roots: readRoots,
        }))).toBeUndefined();
    }
});

test("a create request carries write roots and read roots together, each checked on its own", () => {
    expect(parseHostRequest(JSON.stringify({
        type: "create_agent",
        workspace: "/work/vera",
        write_roots: ["/mnt/scratch"],
        read_roots: ["/mnt/shared"],
    }))).toEqual({
        type: "create_agent",
        workspace: "/work/vera",
        write_roots: ["/mnt/scratch"],
        read_roots: ["/mnt/shared"],
    });
    expect(parseHostRequest(JSON.stringify({
        type: "create_agent",
        workspace: "/work/vera",
        write_roots: ["/mnt/scratch"],
        read_roots: ["relative/path"],
    }))).toBeUndefined();
    expect(parseHostRequest(JSON.stringify({
        type: "create_agent",
        workspace: "/work/vera",
        write_roots: ["relative/path"],
        read_roots: ["/mnt/shared"],
    }))).toBeUndefined();
});
