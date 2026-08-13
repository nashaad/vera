import { mkdirSync, rmSync } from "node:fs";

import { VERA_HOME_ENV, veraHomeDirectory } from "../src/profile-paths.ts";

// .env.test points VERA_HOME at a throwaway tree so no test reads or writes the
// real one. Spawned hosts and TUIs inherit it only because it is a real
// environment entry, not a process.env mutation, and a test that wants its own
// tree sets VERA_HOME on the child it spawns.
if ((process.env[VERA_HOME_ENV] ?? "").trim().length === 0) {
    throw new Error("tests need VERA_HOME set, normally from .env.test");
}
const home = veraHomeDirectory();
if (home.endsWith(".vera-test-home")) {
    rmSync(home, { recursive: true, force: true });
}
mkdirSync(home, { recursive: true });
