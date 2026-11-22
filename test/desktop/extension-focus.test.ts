import { expect, test } from "bun:test";

import { readFocusKeys } from "../../clients/ui/src/extensions/context.ts";

class FocusElement {
    constructor(private readonly blocked: boolean) {}

    closest(selector: string): FocusElement | null {
        if (selector.includes("[role='menu']") && selector.includes("[role='listbox']")) {
            return this.blocked ? this : null;
        }
        return null;
    }
}

test("menus and listboxes do not expose conversation focus to extension keys", () => {
    expect(readFocusKeys(new FocusElement(true) as unknown as Element)).toBeUndefined();
    expect(readFocusKeys(new FocusElement(false) as unknown as Element)).toEqual({
        view: undefined,
        container: undefined,
        entryKind: undefined,
    });
});
