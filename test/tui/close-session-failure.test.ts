import { expect, test } from "bun:test";

import { closeSessionFailure } from "../../clients/tui/main.ts";

test("a conversation being trashed is named, not reported as a host failure", () => {
    expect(closeSessionFailure("busy"))
        .toBe("This conversation is being moved to the trash.");
    expect(closeSessionFailure("failed"))
        .toBe("the host could not stop the current conversation");
});
