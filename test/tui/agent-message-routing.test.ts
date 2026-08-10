import { expect, test } from "bun:test";

import {
    resolveTuiHostedAgentAddressing,
    routeTuiAgentMessage,
    type TuiVisibleAgent,
    visibleTuiAgentMentions,
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

test("declared aliases drive both suggestions and message routing", () => {
    expect(visibleTuiAgentMentions({
        declared: addressing,
        hasSidebar: true,
        sidebarMention: "legacy",
    })).toEqual(["vera", "analyst", "all"]);
    expect(resolveTuiHostedAgentAddressing({
        declared: addressing,
        hasSidebar: true,
    })).toEqual(addressing);
});

test("legacy aliases remain available to undeclared hosted agents", () => {
    const options = {
        hasSidebar: true,
        sidebarMention: "sidekick",
        sidebarAgentId: "side-id",
    } as const;
    expect(visibleTuiAgentMentions(options)).toEqual([
        "sidekick",
        "all",
        "vera",
    ]);
    expect(resolveTuiHostedAgentAddressing(options)).toEqual({
        primary: "vera",
        secondary: "sidekick",
        broadcast: "all",
    });
});

test("a hidden sidebar does not leak its mention into suggestions", () => {
    expect(visibleTuiAgentMentions({
        hasSidebar: false,
        sidebarMention: "sidekick",
        extensionMentions: ["configured"],
    })).toEqual(["configured"]);
});
