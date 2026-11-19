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
delete process.env.VERA_DEV_INSTANCE;

type SpawnOptions = NonNullable<Parameters<typeof Bun.spawn>[1]>;
type SpawnSyncOptions = NonNullable<Parameters<typeof Bun.spawnSync>[1]>;

function withCurrentEnvironment<T extends { env?: NodeJS.ProcessEnv }>(options: T): T {
    return options.env === undefined ? { ...options, env: process.env } : options;
}

// Bun gives children spawned without env the startup environment.
const spawn = Bun.spawn;
const spawnSync = Bun.spawnSync;
Bun.spawn = ((command: string[] | (SpawnOptions & { cmd: string[] }), options?: SpawnOptions) => {
    if (Array.isArray(command)) return spawn(command, withCurrentEnvironment(options ?? {}));
    return spawn(withCurrentEnvironment(command));
}) as typeof Bun.spawn;
Bun.spawnSync = ((command: string[] | (SpawnSyncOptions & { cmd: string[]; onExit?: never }), options?: SpawnSyncOptions) => {
    if (Array.isArray(command)) return spawnSync(command, withCurrentEnvironment(options ?? {}));
    return spawnSync(withCurrentEnvironment(command));
}) as typeof Bun.spawnSync;

export { TEST_TEMP_BASE, TEST_TEMP_ROOT, TEST_USER_HOME, TEST_VERA_HOME };
