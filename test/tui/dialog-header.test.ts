import { expect, test } from "bun:test";
import { BoxRenderable, RGBA, TextRenderable, type Renderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";

import { configureDialogHeaders, dialogHeaderNode, refreshDialogHeaders, updateDialogHeaderTitle } from "../../clients/tui/dialog-header.ts";
import { renderTuiExperimentalView } from "../../clients/tui/experimental-tui-renderer.ts";
import { createTuiExperimentalRawView, disposeTuiExperimentalRawView } from "../../clients/tui/experimental-tui-raw-view.ts";
import { createTuiAdmissionDialogView } from "../../clients/tui/admission-dialog.ts";
import { createTuiNamePromptView } from "../../clients/tui/name-prompt.ts";
import { createTuiSecretPromptView } from "../../clients/tui/secret-prompt.ts";
import { createTuiProviderFormView } from "../../clients/tui/settings-picker-provider-form.ts";
import { createTuiProviderForgetConfirmView } from "../../clients/tui/provider-forget-confirm.ts";
import { createTuiSessionCloseConfirmView } from "../../clients/tui/session-close-confirm.ts";
import { createTuiSessionTrashConfirmView } from "../../clients/tui/session-trash-confirm.ts";
import { createTuiOverridesResetConfirmView } from "../../clients/tui/overrides-reset-confirm.ts";
import { createTuiPermissionsConfirmView } from "../../clients/tui/permissions-confirm.ts";
import { createTuiApprovalView } from "../../clients/tui/approval.ts";
import { createTuiQuestionView } from "../../clients/tui/question.ts";
import { createTuiDiagnosticsDialogView } from "../../clients/tui/diagnostics-dialog.ts";
import { createTuiRequestOptionsEditorView } from "../../clients/tui/request-options-editor.ts";
import { applyTuiTheme } from "../../clients/tui/palette.ts";
import { VERA_TUI_THEME, mixHex } from "../../clients/tui/theme.ts";

test("underline and caret box share the body margins, with no fill on underline", async () => {
    for (const width of [36, 80]) {
        const setup = await createTestRenderer({ width, height: 24 });
        const card = new BoxRenderable(setup.renderer, {
            width: "100%", height: "auto", padding: 2, backgroundColor: "#123456",
        });
        const title = new TextRenderable(setup.renderer, {
            content: "Model Library (14)", fg: VERA_TUI_THEME.text,
            height: 1, wrapMode: "none", overflow: "hidden",
        });
        const header = dialogHeaderNode(setup.renderer, title);
        const body = new TextRenderable(setup.renderer, { content: "Search models", height: 1, marginTop: 1 });
        card.add(header);
        card.add(body);
        setup.renderer.root.add(card);
        try {
            await setup.flush();
            const underline = setup.captureCharFrame();
            expect(underline).toContain("Model Library (14)");
            expect(underline).toContain("esc");
            expect(underline).not.toContain("❱");
            expect(underline.split("\n")[header.screenY + header.height - 1]).toBe(`  ${"─".repeat(width - 4)}  `);
            expect(header.backgroundColor.a).toBe(0);
            const headerRows = setup.captureSpans().lines.slice(header.screenY, header.screenY + header.height);
            for (const span of headerRows.flatMap((line) => line.spans)) {
                expect(span.bg.toInts()).toEqual(RGBA.fromHex("#123456").toInts());
            }
            expect(header.screenX).toBe(body.screenX);
            expect(title.screenX).toBe(body.screenX);
            expect(title.fg.r).toBeGreaterThan(RGBA.fromHex(VERA_TUI_THEME.text).r);
            const bodyY = body.screenY;

            configureDialogHeaders(setup.renderer, "box");
            await setup.flush();
            const boxed = setup.captureCharFrame();
            expect(boxed).toContain("❱ Model Library (14)");
            expect(boxed).toContain("esc");
            expect(boxed).not.toMatch(/[┌┐└┘│─]/);
            expect(header.screenX).toBe(body.screenX);
            expect(body.screenY).toBe(bodyY);
            expect(header.screenX + header.width).toBe(width - 2);
            expect(header.height).toBe(3);
            expect(title.screenY).toBe(header.screenY + 1);

            title.content = "A title that is much too long to share a narrow line with its escape hint";
            await setup.flush();
            const long = setup.captureCharFrame().split("\n").find((line) => line.includes("❱"));
            expect(long).toContain("esc");
            expect(long?.trimEnd()).toEndWith("esc");
        } finally {
            setup.renderer.destroy();
        }
    }
});

test("a header slot preserves the inset underline when the dialog resizes", async () => {
    const setup = await createTestRenderer({ width: 80, height: 24 });
    const card = new BoxRenderable(setup.renderer, { width: "100%", padding: 4 });
    const slot = new BoxRenderable(setup.renderer, { width: "100%" });
    const header = dialogHeaderNode(setup.renderer, "Standing nudges");
    slot.add(header);
    card.add(slot);
    card.add(new TextRenderable(setup.renderer, { content: "Body", height: 1 }));
    setup.renderer.root.add(card);
    try {
        for (const width of [80, 48]) {
            setup.resize(width, 24);
            await setup.flush();
            const rule = setup.captureCharFrame().split("\n")[header.screenY + header.height - 1];
            expect(rule).toBe(`    ${"─".repeat(width - 8)}    `);
        }
    } finally {
        setup.renderer.destroy();
    }
});

test("existing dialogs repaint their header after theme changes and renderer styles stay independent", async () => {
    const first = await createTestRenderer({ width: 60, height: 20 });
    const second = await createTestRenderer({ width: 60, height: 20 });
    const a = dialogHeaderNode(first.renderer, "First");
    const b = dialogHeaderNode(second.renderer, "Second");
    first.renderer.root.add(a);
    second.renderer.root.add(b);
    try {
        configureDialogHeaders(first.renderer, "box");
        await first.flush();
        await second.flush();
        expect(first.captureCharFrame()).toContain("❱ First");
        expect(second.captureCharFrame()).not.toContain("❱");
        const theme = { ...VERA_TUI_THEME, accent: "#5599cc", panel: "#112233" };
        applyTuiTheme(theme);
        refreshDialogHeaders();
        expect(a.backgroundColor.toInts()).toEqual(RGBA.fromHex(mixHex(theme.panel, theme.text, 0.10)).toInts());
        expect(b.backgroundColor.a).toBe(0);
    } finally {
        first.renderer.destroy();
        second.renderer.destroy();
        applyTuiTheme(VERA_TUI_THEME);
        refreshDialogHeaders();
    }
});

test("persistent dialogs all use the configurable shared header", async () => {
    const setup = await createTestRenderer({ width: 100, height: 40 });
    const factories = [
        createTuiAdmissionDialogView, createTuiNamePromptView, createTuiSecretPromptView,
        createTuiProviderFormView, createTuiProviderForgetConfirmView, createTuiSessionCloseConfirmView,
        createTuiSessionTrashConfirmView, createTuiOverridesResetConfirmView,
        createTuiApprovalView, createTuiQuestionView, createTuiDiagnosticsDialogView,
        createTuiRequestOptionsEditorView,
    ];
    const views = [
        ...factories.map((create) => create(setup.renderer)),
        createTuiPermissionsConfirmView(setup.renderer, VERA_TUI_THEME),
    ];
    try {
        for (const view of views) {
            const root = "card" in view ? view.card : view.box;
            const header = descendants(root).find((node) => node.id.startsWith("dialog-header-")) as BoxRenderable | undefined;
            expect(header, root.id).toBeDefined();
            configureDialogHeaders(setup.renderer, "box");
            expect(header?.border, root.id).toBe(false);
            expect(header?.getChildren()[0]?.visible, root.id).toBe(true);
            configureDialogHeaders(setup.renderer, "underline");
            expect(header?.border, root.id).toEqual(["bottom"]);
        }
    } finally {
        for (const view of views) view.box.destroyRecursively();
        setup.renderer.destroy();
    }
});

function descendants(root: Renderable): Renderable[] {
    return root.getChildren().flatMap((child) => [child, ...descendants(child)]);
}

test("short terminals preserve the title and body while dropping decorative border rows", async () => {
    const setup = await createTestRenderer({ width: 50, height: 10 });
    const header = dialogHeaderNode(setup.renderer, "Extensions");
    setup.renderer.root.add(header);
    setup.renderer.root.add(new TextRenderable(setup.renderer, { content: "Dialog body", height: 1 }));
    try {
        for (const style of ["underline", "box"] as const) {
            configureDialogHeaders(setup.renderer, style);
            updateDialogHeaderTitle(header, "Remove extension");
            await setup.flush();
            const frame = setup.captureCharFrame();
            expect(frame).toContain("Remove extension");
            expect(frame).toContain("esc");
            expect(frame).toContain("Dialog body");
            expect(header.height).toBe(1);
            expect(frame.includes("❱")).toBe(style === "box");
        }
    } finally {
        setup.renderer.destroy();
    }
});

test("structured and raw extension overlays share the header, including untitled overlays", async () => {
    const setup = await createTestRenderer({ width: 80, height: 30 });
    configureDialogHeaders(setup.renderer, "box");
    try {
        for (const overlay of [true, false]) {
            const structured = renderTuiExperimentalView({
                renderer: setup.renderer, theme: VERA_TUI_THEME,
                id: "structured", overlay, node: { kind: "text", text: "Extension content" },
                focus() {}, triggerAction() {},
            });
            const raw = createTuiExperimentalRawView({
                renderer: setup.renderer, extensionId: "fixture", workspace: "/workspace",
                theme: VERA_TUI_THEME, transcript: [], requestRender() {},
                spec: {
                    id: "raw", slot: overlay ? "overlay" : "transcript-bottom",
                    create: () => new TextRenderable(setup.renderer, { content: "Raw content" }),
                },
            });
            for (const root of [structured, raw.container]) {
                const header = descendants(root).find((node) => node.id.startsWith("dialog-header-"));
                expect(header !== undefined).toBe(overlay);
                if (header !== undefined) {
                    expect((header as BoxRenderable).border).toBe(false);
                    expect(header.getChildren()[0]?.visible).toBe(true);
                }
            }
            structured.destroyRecursively();
            disposeTuiExperimentalRawView(raw, () => {});
        }
        // Destroyed extension headers must not remain in the theme repaint registry.
        refreshDialogHeaders();
    } finally {
        setup.renderer.destroy();
    }
});
