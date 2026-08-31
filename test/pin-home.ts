import { join } from "node:path";
import { fileURLToPath } from "node:url";

const TEST_USER_HOME = join(
    fileURLToPath(new URL("..", import.meta.url)),
    ".vera-test-user",
);

process.env.HOME = TEST_USER_HOME;

export { TEST_USER_HOME };
