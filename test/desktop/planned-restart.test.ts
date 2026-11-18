import { expect, test } from "bun:test";

import type { DesktopEvent, SessionPane } from "../../clients/ui/src/protocol/bridge.ts";
import { hostRestartingBuild, parseSessionLine } from "../../clients/ui/src/session/wire.ts";
import { initialWatch, reduceWatch } from "../../clients/ui/src/session/transcript.ts";
import { PlannedRestartWatch } from "../../clients/ui/src/state/plannedRestart.ts";

const notice = (buildId: unknown): string => `${JSON.stringify({ type: "host_restarting", build_id: buildId })}\n`;

const frame = (text: string, pane: SessionPane = "main"): DesktopEvent => ({
    type: "session_frame",
    pane,
    agentId: "agent-a",
    text,
});

const closed = (pane: SessionPane = "main"): DesktopEvent => ({
    type: "session_closed",
    pane,
    agentId: "agent-a",
    reason: "The host closed the connection.",
});

test("@core wire reads the host restart notice with its build id", () => {
    expect(parseSessionLine(notice("vera-abc123+d1e2"))).toEqual({ type: "host_restarting", buildId: "vera-abc123+d1e2" });
    expect(hostRestartingBuild(notice("build-2"))).toBe("build-2");
});

test("wire drops a restart notice whose build id the host would not send", () => {
    expect(parseSessionLine(notice(""))).toBeUndefined();
    expect(parseSessionLine(notice("bad id"))).toBeUndefined();
    expect(parseSessionLine(notice("-leading"))).toBeUndefined();
    expect(parseSessionLine(notice("x".repeat(129)))).toBeUndefined();
    expect(parseSessionLine(notice(7))).toBeUndefined();
    expect(parseSessionLine(`${JSON.stringify({ type: "host_restarting" })}\n`)).toBeUndefined();
    expect(hostRestartingBuild(`${JSON.stringify({ type: "something_else" })}\n`)).toBeUndefined();
});

test("a restart notice leaves the transcript as it was", () => {
    const start = initialWatch("agent-a");
    const message = parseSessionLine(notice("build-2"));
    expect(message).toBeDefined();
    if (message === undefined) return;
    expect(reduceWatch(start, message)).toBe(start);
});

test("@core the page reconnects once after the host closes following a restart notice", () => {
    const watch = new PlannedRestartWatch();
    expect(watch.observe(frame(notice("build-2")))).toEqual({ kind: "announced", buildId: "build-2" });
    expect(watch.observe(closed())).toEqual({ kind: "reconnect" });
    expect(watch.observe(closed())).toEqual({ kind: "none" });
    expect(watch.lost()).toEqual({ kind: "none" });
});

test("@core a host pipe loss or a failed poll after a restart notice also reconnects once", () => {
    const viaPipe = new PlannedRestartWatch();
    viaPipe.observe(frame(notice("build-2")));
    expect(viaPipe.observe({ type: "disconnected", reason: "The host is not running." })).toEqual({ kind: "reconnect" });
    expect(viaPipe.lost()).toEqual({ kind: "none" });
    const viaPoll = new PlannedRestartWatch();
    viaPoll.observe(frame(notice("build-2")));
    expect(viaPoll.lost()).toEqual({ kind: "reconnect" });
    expect(viaPoll.observe(closed())).toEqual({ kind: "none" });
});

test("@core without a restart notice a lost connection is left to the Reconnect banner", () => {
    const watch = new PlannedRestartWatch();
    expect(watch.observe(closed())).toEqual({ kind: "none" });
    expect(watch.observe({ type: "disconnected", reason: "x" })).toEqual({ kind: "none" });
    expect(watch.lost()).toEqual({ kind: "none" });
    expect(watch.observe(frame(`${JSON.stringify({ type: "history" })}\n`))).toEqual({ kind: "none" });
});

test("a pane that did not hear the notice closing does not start the reconnect", () => {
    const watch = new PlannedRestartWatch();
    watch.observe(frame(notice("build-2"), "main"));
    expect(watch.observe(closed("subagent"))).toEqual({ kind: "none" });
    expect(watch.observe(closed("main"))).toEqual({ kind: "reconnect" });
});

test("a new host, a failure or a manual reconnect ends the wait", () => {
    const watch = new PlannedRestartWatch();
    watch.observe(frame(notice("build-2")));
    watch.clear();
    expect(watch.observe(closed())).toEqual({ kind: "none" });
    expect(watch.lost()).toEqual({ kind: "none" });
});
