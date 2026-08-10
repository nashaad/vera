import { expect, test } from "bun:test";

import {
    routeTuiAgentMessage,
    type TuiVisibleAgent,
} from "../../clients/tui/agent-message-routing.ts";

const visible: readonly TuiVisibleAgent[] = [
    { agentId: "main-id", pane: "main" },
    { agentId: "second-id", pane: "sidebar" },
];
const addressing = {
    primary: "vera",
    secondary: "analyst",
    broadcast: "all",
} as const;

test("an unaddressed message goes to the focused visible agent", () => {
    expect(routeTuiAgentMessage(
        "take a look",
        "sidebar",
        visible,
        addressing,
    )).toEqual({
        kind: "message",
        text: "take a look",
        targets: [visible[1]!],
    });
});

test("a visible mention overrides focus for one message", () => {
    expect(routeTuiAgentMessage(
        "@vera check this",
        "sidebar",
        visible,
        addressing,
    )).toEqual({
        kind: "message",
        text: "check this",
        targets: [visible[0]!],
    });
});

test("a bare visible mention changes focus without sending", () => {
    expect(routeTuiAgentMessage(
        "@analyst",
        "main",
        visible,
        addressing,
    )).toEqual({
        kind: "focus",
        pane: "sidebar",
    });
});

test("a declared broadcast alias fans out to visible agents", () => {
    expect(routeTuiAgentMessage(
        "@all compare",
        "main",
        visible,
        addressing,
    )).toEqual({
        kind: "message",
        text: "compare",
        targets: visible,
    });
});

test("omitting a broadcast alias makes all unknown", () => {
    expect(routeTuiAgentMessage(
        "@all compare",
        "main",
        visible,
        { primary: "author", secondary: "critic" },
    )).toEqual({ kind: "unknown", mention: "all" });
});

test("an agent that is not open cannot be mentioned", () => {
    expect(routeTuiAgentMessage(
        "@hidden hello",
        "main",
        visible,
        addressing,
    )).toEqual({
        kind: "unknown",
        mention: "hidden",
    });
});
