import { expect, test } from "bun:test";

import { TuiBodyFocusController } from "../../clients/tui/body-focus.ts";

test("body clicks focus input but drags and modal clicks do not", () => {
    const focus = new TuiBodyFocusController();

    expect(focus.release(false)).toBe(true);
    expect(focus.release(true)).toBe(false);

    focus.noteDrag();
    expect(focus.release(false)).toBe(false);
    expect(focus.release(false)).toBe(true);
});
