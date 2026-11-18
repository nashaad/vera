import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { enterTestTempRoot, testTempBase } from "./support/temp-root.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const TEST_USER_HOME = join(REPO_ROOT, ".vera-test-user");
const TEST_TEMP_BASE = testTempBase();
const TEST_TEMP_ROOT = enterTestTempRoot();
const TEST_VERA_HOME = join(TEST_TEMP_ROOT.path, "home");

process.env.VERA_HOME = TEST_VERA_HOME;
process.env.VERA_TEST_HOME = TEST_VERA_HOME;
process.env.HOME = TEST_USER_HOME;

export { TEST_TEMP_BASE, TEST_TEMP_ROOT, TEST_USER_HOME, TEST_VERA_HOME };
