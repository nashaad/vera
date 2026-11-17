import { expect, test } from "bun:test";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { backgroundCommandCount } from "../../clients/ui/src/protocol/backgroundCommands.ts";
import type { AgentListFacts, ListAgentsOptions } from "../../clients/ui/src/protocol/client.ts";
import { backgroundCommandWarningText, CloseBackgroundCommandsSheet } from "../../clients/ui/src/session/CloseBackgroundCommandsSheet.tsx";

function page(
    agents: readonly unknown[],
    next_cursor?: string,
    unavailable_workers?: readonly string[],
): AgentListFacts {
    return {
        agents,
        ...(next_cursor === undefined ? {} : { next_cursor }),
        ...(unavailable_workers === undefined ? {} : { unavailable_workers }),
    };
}

test("@core close warning copy handles singular and plural counts", () => {
    expect(backgroundCommandWarningText(1))
        .toBe("1 background command is running in this conversation. Closing stops it.");
    expect(backgroundCommandWarningText(2))
        .toBe("2 background commands are running in this conversation. Closing stops them.");
});

test("@core close confirmation names the conversation and exposes cancel and primary confirm", () => {
    const warning = {
        target: { agentId: "crow-9", title: "Crow's nest", workspace: "/nests", chat: false },
        count: 2,
        confirm: () => {},
    };
    const html = renderToStaticMarkup(createElement(CloseBackgroundCommandsSheet, {
        warning,
        onCancel: () => {},
        onConfirm: () => {},
    }));
    expect(html).toContain("Close Crow&#x27;s nest?");
    expect(html).toContain("2 background commands are running in this conversation. Closing stops them.");
    expect(html).toContain(">Cancel</button>");
    expect(html).toContain("class=\"button-primary session-sheet-action\">Stop and close</button>");

    let cancelled = 0;
    let confirmed = 0;
    interface ButtonProps { onClick: () => void }
    interface FooterProps { children: readonly ReactElement<ButtonProps>[] }
    interface SheetProps { foot: ReactElement<FooterProps> }
    const sheet = CloseBackgroundCommandsSheet({
        warning,
        onCancel: () => { cancelled += 1; },
        onConfirm: () => { confirmed += 1; },
    }) as ReactElement<SheetProps>;
    const buttons = sheet.props.foot.props.children;
    buttons[0]?.props.onClick();
    expect(cancelled).toBe(1);
    expect(confirmed).toBe(0);
    buttons[1]?.props.onClick();
    expect(cancelled).toBe(1);
    expect(confirmed).toBe(1);
});

test("@core fresh background counts handle zero, one and multiple commands", async () => {
    for (const [commands, expected] of [[undefined, 0], [1, 1], [2, 2]] as const) {
        const result = await backgroundCommandCount(async () => page([
            { id: "crow-9", ...(commands === undefined ? {} : { background_commands: commands }) },
        ]), "crow-9");
        expect(result).toEqual({ ok: true, count: expected });
    }
});

test("@core fresh background lookup pages to the target and treats missing targets as unknown", async () => {
    const requests: ListAgentsOptions[] = [];
    const result = await backgroundCommandCount(async (options = {}) => {
        requests.push(options);
        return options.cursor === undefined
            ? page([{ id: "other" }], "other")
            : page([{ id: "crow-9", background_commands: 2 }]);
    }, "crow-9");
    expect(result).toEqual({ ok: true, count: 2 });
    expect(requests).toEqual([
        { limit: 50, order: "recent" },
        { limit: 50, order: "recent", cursor: "other" },
    ]);

    const missing = await backgroundCommandCount(async () => page([{ id: "other" }]), "crow-9");
    expect(missing.ok).toBe(false);
});

test("@core background lookup stops on the first page containing the target", async () => {
    for (const [commands, expected] of [[undefined, 0], [1, 1], [2, 2]] as const) {
        const requests: ListAgentsOptions[] = [];
        const result = await backgroundCommandCount(async (options = {}) => {
            requests.push(options);
            if (options.cursor !== undefined) throw new Error("Unexpected next page");
            return page([
                { id: "crow-9", ...(commands === undefined ? {} : { background_commands: commands }) },
            ], "next-page");
        }, "crow-9");
        expect(result).toEqual({ ok: true, count: expected });
        expect(requests).toEqual([{ limit: 50, order: "recent" }]);
    }
});

test("@core background lookup returns a match on the last allowed page", async () => {
    let requests = 0;
    const result = await backgroundCommandCount(async () => {
        requests += 1;
        return page(requests === 100 ? [{ id: "crow-9", background_commands: 1 }] : [], `cursor-${requests}`);
    }, "crow-9");
    expect(requests).toBe(100);
    expect(result).toEqual({ ok: true, count: 1 });
});

test("@core background lookup refuses a listing longer than one hundred pages", async () => {
    let requests = 0;
    const result = await backgroundCommandCount(async () => {
        requests += 1;
        return page([], `cursor-${requests}`);
    }, "crow-9");
    expect(requests).toBe(100);
    expect(result.ok).toBe(false);
});

test("@core unavailable workers or malformed counts never become zero", async () => {
    const unavailable = await backgroundCommandCount(async () => page(
        [{ id: "crow-9" }],
        undefined,
        ["pool-worker-1"],
    ), "crow-9");
    expect(unavailable.ok).toBe(false);

    const malformed = await backgroundCommandCount(async () => page([
        { id: "crow-9", background_commands: 0 },
    ]), "crow-9");
    expect(malformed.ok).toBe(false);
});
