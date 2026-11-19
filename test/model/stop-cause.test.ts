import { expect, test } from "bun:test";
import { stopCauseText } from "../../clients/shared/stop-cause-text.ts";
import { isStopCause } from "../../src/model/types.ts";

test("stop cause validation and text accept only known values", () => {
    expect(isStopCause("host_stopped")).toBe(true);
    expect(isStopCause("host_stopped_unexpectedly")).toBe(true);
    expect(stopCauseText("host_stopped")).toBe("Host stopped");
    expect(stopCauseText("host_stopped_unexpectedly")).toBe("Host stopped unexpectedly");

    for (const value of [undefined, null, "", "future_cause", "HOST_STOPPED", 42, {}, []]) {
        expect(isStopCause(value)).toBe(false);
        expect(stopCauseText(value)).toBeUndefined();
    }
});
