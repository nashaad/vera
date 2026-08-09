import { expect, test } from "bun:test";

import {
    TuiAgentAttachments,
    type TuiAgentAttachment,
} from "../../clients/tui/agent-attachments.ts";

interface FakeAttachment extends TuiAgentAttachment {
    readonly detached: string[];
}

function attachment(agentId: string): FakeAttachment {
    const detached: string[] = [];
    return {
        agentId,
        detached,
        async detach() {
            detached.push(agentId);
        },
    };
}

test("a second attachment opens beside the main agent and takes focus", async () => {
    const main = attachment("main");
    const secondary = attachment("secondary");
    const attachments = new TuiAgentAttachments(main);

    await attachments.openSidebar(secondary);

    expect(attachments.main()).toBe(main);
    expect(attachments.sidebar()).toBe(secondary);
    expect(attachments.focus()).toBe("sidebar");
    expect(attachments.focused()).toBe(secondary);
    expect(main.detached).toEqual([]);
});

test("focus moves between the two open attachments", async () => {
    const main = attachment("main");
    const secondary = attachment("secondary");
    const attachments = new TuiAgentAttachments(main);
    await attachments.openSidebar(secondary);

    attachments.select("main");
    expect(attachments.focused()).toBe(main);

    attachments.select("sidebar");
    expect(attachments.focused()).toBe(secondary);
});

test("opening a third agent replaces only the sidebar attachment", async () => {
    const main = attachment("main");
    const first = attachment("first");
    const second = attachment("second");
    const attachments = new TuiAgentAttachments(main);
    await attachments.openSidebar(first);

    await attachments.openSidebar(second);

    expect(first.detached).toEqual(["first"]);
    expect(main.detached).toEqual([]);
    expect(attachments.sidebar()).toBe(second);
    expect(attachments.focused()).toBe(second);
});

test("detaching the sidebar leaves the main attachment open and focused", async () => {
    const main = attachment("main");
    const secondary = attachment("secondary");
    const attachments = new TuiAgentAttachments(main);
    await attachments.openSidebar(secondary);

    await attachments.detachSidebar();

    expect(secondary.detached).toEqual(["secondary"]);
    expect(main.detached).toEqual([]);
    expect(attachments.sidebar()).toBeUndefined();
    expect(attachments.focus()).toBe("main");
    expect(attachments.focused()).toBe(main);
});

test("opening an already visible agent focuses its existing pane", async () => {
    const main = attachment("main");
    const secondary = attachment("secondary");
    const attachments = new TuiAgentAttachments(main);
    await attachments.openSidebar(secondary);

    await attachments.openSidebar(main);

    expect(secondary.detached).toEqual([]);
    expect(main.detached).toEqual([]);
    expect(attachments.sidebar()).toBe(secondary);
    expect(attachments.focused()).toBe(main);
});

test("replacing the main attachment leaves the sidebar open", async () => {
    const main = attachment("main");
    const next = attachment("next");
    const secondary = attachment("secondary");
    const attachments = new TuiAgentAttachments(main);
    await attachments.openSidebar(secondary);

    await attachments.openMain(next);

    expect(main.detached).toEqual(["main"]);
    expect(secondary.detached).toEqual([]);
    expect(attachments.main()).toBe(next);
    expect(attachments.sidebar()).toBe(secondary);
    expect(attachments.focus()).toBe("main");
});

test("opening a session replaces whichever pane is focused", async () => {
    const main = attachment("main");
    const secondary = attachment("secondary");
    const replacement = attachment("replacement");
    const attachments = new TuiAgentAttachments(main);
    await attachments.openSidebar(secondary);

    await attachments.openFocused(replacement);

    expect(main.detached).toEqual([]);
    expect(secondary.detached).toEqual(["secondary"]);
    expect(attachments.main()).toBe(main);
    expect(attachments.sidebar()).toBe(replacement);
    expect(attachments.focus()).toBe("sidebar");
});
