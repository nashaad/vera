import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RGBA } from "@opentui/core";

import {
    createTuiToolDetailsDependencies,
} from "../../support/tui-tool-details-child.ts";
import { startTuiTestSession } from "../../support/tui-harness.ts";

test("persisted TUI appearance config controls transcript and composer layout", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-appearance-"));
    const configDirectory = join(home, ".vera");
    mkdirSync(configDirectory, { recursive: true });
    writeFileSync(join(configDirectory, "config.json"), JSON.stringify({
        schema_version: 1,
        model: "anthropic/example-model",
        tui: {
            transcript: {
                padding_left: 2,
                padding_right: 3,
                activity_indent: 3,
                message_spacing: 1,
                tool_group_spacing: 1,
                separator_visible: false,
                separator_spacing_before: 1,
                separator_spacing_after: 1,
                separator_color: "#112233",
            },
            composer: {
                margin_horizontal: 4,
                padding_horizontal: 2,
                tip_indent: 5,
                boundary_color: "#334455",
            },
        },
    }));
    const session = await startTuiTestSession({
        home,
        dependencies: () => createTuiToolDetailsDependencies(),
    });
    let pane = "";

    try {
        pane = await session.waitForVisiblePane("Start a conversation");
        expect(pane).toMatch(/^ {5}Start a conversation with Vera\.$/m);
        session.sendText("show configured layout");
        session.sendKey("Enter");
        pane = await session.waitForVisiblePane("TOOL DETAILS COMPLETED");
        expect(pane).toContain("default · ask");

        expect(pane).toMatch(/^ {5}Ran/m);
        expect(pane).not.toMatch(/^ {5}─{20}/m);
        expect(pane).toMatch(/^ {2}• {2}TOOL DETAILS COMPLETED$/m);
        expect(pane).toMatch(/^ {5}Tip /m);
        expect(pane).toMatch(/^ {4}╭─{20}/m);

        const lines = pane.split("\n");
        const answer = lines.findIndex((line) =>
            line.includes("TOOL DETAILS COMPLETED")
        );
        expect(answer).toBeGreaterThan(2);
        expect(lines[answer - 1]?.trim()).toBe("");
        expect(lines[answer - 2]?.trim()).toBe("");

        // The tmux test read the boundary color back out of the escape
        // stream; the virtual frame carries it as a span color directly.
        const styled = session.captureSpans();
        const configured = RGBA.fromHex("#334455").toInts();
        const boundary = styled.lines.flatMap((line) => line.spans)
            .find((span) =>
                span.text.includes("╭")
                && span.fg.toInts().toString() === configured.toString()
            );
        expect(boundary).toBeDefined();

        session.resize(20, 34);
        pane = await session.waitForVisiblePaneWhere(
            (current) => /^ {3}╭─{10}/m.test(current),
            "composer fitted to a narrow terminal",
        );
        expect(pane).toMatch(/^ {3}╭─{10}/m);
        expect(pane).toMatch(/^ {3}│Message/m);
    } finally {
        await session.close();
    }
}, 15_000);
