import { expect, test } from "bun:test";
import { join } from "node:path";

import { veraHomeDirectory } from "../../src/profile-paths.ts";
import {
    veraProfileDirectory,
    veraRuntimeDirectory,
    veraMachineDirectory,
} from "../../src/sdk/paths.ts";

// An extension reaching for its own state gets the same answer the engine does.
test("the sdk resolves the same directories the engine reads", () => {
    const home = veraHomeDirectory();
    expect(veraMachineDirectory()).toBe(join(home, "machine"));
    expect(veraProfileDirectory({ VERA_PROFILE: "dogfood" }))
        .toBe(home);
    expect(veraRuntimeDirectory({ VERA_PROFILE: "dogfood" }))
        .toBe(join(home, "runtime"));
});
