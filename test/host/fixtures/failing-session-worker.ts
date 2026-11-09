import { spyOn } from "bun:test";

import { SessionStore } from "../../../src/store/session-store.ts";

spyOn(SessionStore.prototype, "appendContextMeasurement").mockImplementation(async () => {
    throw new Error("Injected pool context failure");
});

await import("../../../clients/host/session-worker.ts");
