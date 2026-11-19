import { expect, test } from "bun:test";

import { pillLabel } from "../../clients/ui/src/session/ContextPill.tsx";

test("@core an opening context pill leaves an unknown measurement blank", () => {
    expect(pillLabel(undefined, true)).toBe("");
    expect(pillLabel(undefined, false)).toBe("–");
    expect(pillLabel({ tokens: 42, capacity: 200, estimated: false, components: [] }, true)).toBe("21%");
});
