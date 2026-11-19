import { spyOn } from "bun:test";

import * as workerLaunch from "../../../src/host/pool/worker-launch.ts";

const wrapper = process.env.VERA_TEST_SESSION_WRAPPER;
if (wrapper === undefined) throw new Error("Missing session worker wrapper");
spyOn(workerLaunch, "sessionWorkerSpawnSpec").mockReturnValue({ command: wrapper, args: [] });
await import("./pool-adoption-host.ts");
