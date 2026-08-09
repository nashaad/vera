import { expect, test } from "bun:test";

import {
    routeTuiAgentMessage,
    type TuiVisibleAgent,
} from "../../clients/tui/agent-message-routing.ts";

const visible: readonly TuiVisibleAgent[] = [
    { agentId: "main-id", pane: "main", mention: "vera" },
    { agentId: "side-id", pane: "sidebar", mention: "sidekick" },
];

test("an unaddressed message goes to the focused visible agent", () => {
    expect(routeTuiAgentMessage("take a look", "sidebar", visible)).toEqual({
        kind: "message",
        text: "take a look",
        targets: [visible[1]!],
    });
});

test("a visible mention overrides focus for one message", () => {
    expect(routeTuiAgentMessage("@vera check this", "sidebar", visible)).toEqual({
        kind: "message",
        text: "check this",
        targets: [visible[0]!],
    });
});

test("a bare visible mention changes focus without sending", () => {
    expect(routeTuiAgentMessage("@sidekick", "main", visible)).toEqual({
        kind: "focus",
        pane: "sidebar",
    });
});

test("all broadcasts exactly to the visible agents", () => {
    expect(routeTuiAgentMessage("@all compare", "main", visible)).toEqual({
        kind: "message",
        text: "compare",
        targets: visible,
    });
});

test("an agent that is not open cannot be mentioned", () => {
    expect(routeTuiAgentMessage("@hidden hello", "main", visible)).toEqual({
        kind: "unknown",
        mention: "hidden",
    });
});
