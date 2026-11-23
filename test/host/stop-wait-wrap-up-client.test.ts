import { expect, test } from "bun:test";

import { parseRequestStopWaitWrapUpResponse } from "../../src/host/stop-wait-wrap-up-client.ts";

test("wrap-up client parses delivered recipients and no-wait refusals", () => {
    expect(parseRequestStopWaitWrapUpResponse({
        type: "ask_stop_wait_wrap_up_done",
        offered: ["working-session", 4],
    })).toEqual({
        type: "ask_stop_wait_wrap_up_done",
        offered: ["working-session"],
    });
    expect(parseRequestStopWaitWrapUpResponse({
        type: "ask_stop_wait_wrap_up_refused",
        reason: "no_wait",
        message: "No stop is waiting.",
    })).toEqual({
        type: "ask_stop_wait_wrap_up_refused",
        reason: "no_wait",
        message: "No stop is waiting.",
    });
    expect(parseRequestStopWaitWrapUpResponse({ type: "ask_stop_wait_wrap_up_done", offered: "wrong" }))
        .toEqual({ type: "unsupported" });
});
