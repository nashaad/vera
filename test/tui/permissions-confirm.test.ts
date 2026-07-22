import { expect, test } from "bun:test";

import { handleTuiPermissionsConfirmKey } from "../../clients/tui/permissions-confirm.ts";

test("full access requires an explicit confirmation", () => {
    expect(handleTuiPermissionsConfirmKey({ name: "1" })).toBe("confirm");
    expect(handleTuiPermissionsConfirmKey({ name: "enter" })).toBe("confirm");
    expect(handleTuiPermissionsConfirmKey({ name: "escape" })).toBe("cancel");
    expect(handleTuiPermissionsConfirmKey({ name: "2" })).toBeUndefined();
});
