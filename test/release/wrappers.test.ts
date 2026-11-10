import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    RELEASE_ANNEX_NAME,
    RELEASE_CLI_NAME,
    RELEASE_HOST_NAME,
    RELEASE_SESSION_WORKER_NAME,
    RELEASE_SUPERVISOR_NAME,
    RELEASE_WORKER_NAME,
} from "../../src/release/layout.ts";
import { writeSelfContainedWrappers } from "../../src/release/wrappers.ts";

test("@core release wrappers dispatch every role through one executable", () => {
    const root = mkdtempSync(join(tmpdir(), "vera-release-wrappers-"));
    writeSelfContainedWrappers(root);
    for (const [name, role] of [
        [RELEASE_CLI_NAME, "cli"],
        [RELEASE_HOST_NAME, "host"],
        [RELEASE_WORKER_NAME, "worker"],
        [RELEASE_SESSION_WORKER_NAME, "session-worker"],
        [RELEASE_ANNEX_NAME, "annex"],
        [RELEASE_SUPERVISOR_NAME, "supervisor"],
    ] as const) {
        const wrapper = readFileSync(join(root, name), "utf8");
        expect(wrapper).toContain("/vera-bin");
        expect(wrapper).toContain(`--vera-role=${role}`);
    }
});
