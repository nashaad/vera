import { expect, test } from "bun:test";

import { desktopFolder, sessionCountLabel } from "../../clients/ui/src/pages/settings/data.ts";
import { SESSIONS_PAGE_SIZE } from "../../clients/ui/src/protocol/sessions.ts";

test("@core the desktop folder is machine/desktop under the home, with or without a trailing slash", () => {
    expect(desktopFolder("/Users/nash/.vera")).toBe("/Users/nash/.vera/machine/desktop");
    expect(desktopFolder("/Users/nash/.vera/")).toBe("/Users/nash/.vera/machine/desktop");
    expect(desktopFolder("/Users/nash/.vera///")).toBe("/Users/nash/.vera/machine/desktop");
    expect(desktopFolder("C:\\Vera")).toBe("C:\\Vera\\machine\\desktop");
});

test("an unknown or empty home has no desktop folder", () => {
    expect(desktopFolder(undefined)).toBeUndefined();
    expect(desktopFolder("")).toBeUndefined();
});

test("@core the session count is exact below the page size and marked at it", () => {
    expect(sessionCountLabel(0, true)).toBe("0");
    expect(sessionCountLabel(SESSIONS_PAGE_SIZE - 1, true)).toBe(`${SESSIONS_PAGE_SIZE - 1}`);
    expect(sessionCountLabel(SESSIONS_PAGE_SIZE, true)).toBe(`${SESSIONS_PAGE_SIZE}+`);
});

test("the session count says not connected when the window is not attached", () => {
    expect(sessionCountLabel(12, false)).toBe("Not connected");
    expect(sessionCountLabel(undefined, false)).toBe("Not connected");
});

test("the session count reads loading until the host lists sessions", () => {
    expect(sessionCountLabel(undefined, true)).toBe("Loading");
});
