import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const TEST_USER_HOME = join(REPO_ROOT, ".vera-test-user");
const TEST_VERA_HOME = join(REPO_ROOT, ".vera-test-home");

// Bun keeps a VERA_HOME inherited from the shell instead of taking .env.test,
// so a test run from a Vera session would read that session's home.
const inheritedVeraHome = process.env.VERA_HOME?.trim();
if (
    inheritedVeraHome !== undefined
    && inheritedVeraHome.length > 0
    && inheritedVeraHome !== TEST_VERA_HOME
) {
    process.env.VERA_HOME = TEST_VERA_HOME;
}

process.env.HOME = TEST_USER_HOME;

export { TEST_USER_HOME };
