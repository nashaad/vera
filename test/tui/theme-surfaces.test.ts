import { expect, test } from "bun:test";
import { RGBA, TextRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";

import {
    createTuiAdmissionDialogView,
} from "../../clients/tui/admission-dialog.ts";
import {
    createTuiProviderForgetConfirmView,
} from "../../clients/tui/provider-forget-confirm.ts";
import {
    createTuiSecretPromptView,
} from "../../clients/tui/secret-prompt.ts";
import {
    applyTuiThemeBindings,
} from "../../clients/tui/theme-bindings.ts";
import { VERA_TUI_THEME } from "../../clients/tui/theme.ts";

test("persistent dialog surfaces repaint from declarative bindings", async () => {
    const setup = await createTestRenderer({ width: 80, height: 24 });
    const nextTheme = {
        ...VERA_TUI_THEME,
        notice: "#123456",
        text: "#234567",
        muted: "#345678",
        panel: "#456789",
    };
    const admission = createTuiAdmissionDialogView(setup.renderer);
    const provider = createTuiProviderForgetConfirmView(setup.renderer);
    const secret = createTuiSecretPromptView(setup.renderer);

    try {
        for (const bindings of [
            admission.themeBindings,
            provider.themeBindings,
            secret.themeBindings,
        ]) {
            applyTuiThemeBindings(nextTheme, bindings);
        }

        const admissionText = admission.box.getChildren() as TextRenderable[];
        expect(admissionText[0]?.fg.toInts()).toEqual(
            RGBA.fromHex(nextTheme.notice).toInts(),
        );
        expect(admissionText[1]?.fg.toInts()).toEqual(
            RGBA.fromHex(nextTheme.text).toInts(),
        );
        expect(admissionText[2]?.fg.toInts()).toEqual(
            RGBA.fromHex(nextTheme.muted).toInts(),
        );
        expect(admission.box.backgroundColor.toInts()).toEqual(
            RGBA.fromHex(nextTheme.panel).toInts(),
        );

        const providerText = provider.box.getChildren() as TextRenderable[];
        expect(providerText[0]?.fg.toInts()).toEqual(
            RGBA.fromHex(nextTheme.notice).toInts(),
        );
        expect(providerText[1]?.fg.toInts()).toEqual(
            RGBA.fromHex(nextTheme.text).toInts(),
        );
        expect(providerText[2]?.fg.toInts()).toEqual(
            RGBA.fromHex(nextTheme.muted).toInts(),
        );
        expect(secret.card.backgroundColor.toInts()).toEqual(
            RGBA.fromHex(nextTheme.panel).toInts(),
        );
    } finally {
        setup.renderer.destroy();
    }
});
