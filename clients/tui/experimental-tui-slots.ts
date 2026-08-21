import { BoxRenderable, type CliRenderer } from "@opentui/core";

import type { TuiTheme } from "./theme.ts";
import type { VeraExperimentalTuiSlot } from "../../src/sdk/experimental-tui.ts";
import { DIALOG_CARD_Z_INDEX } from "./dialog-chrome.ts";

export interface TuiExperimentalSlotRegistry {
    readonly transcriptTop: BoxRenderable;
    readonly transcriptBottom: BoxRenderable;
    readonly footer: BoxRenderable;
    readonly composerAdornment: BoxRenderable;
    readonly overlay: BoxRenderable;
    slotFor(slot: VeraExperimentalTuiSlot): BoxRenderable;
    destroy(): void;
}

export interface TuiExperimentalSlotRegistryOptions {
    readonly renderer: CliRenderer;
    readonly theme: TuiTheme;
}

export function createTuiExperimentalSlotRegistry(
    options: TuiExperimentalSlotRegistryOptions,
): TuiExperimentalSlotRegistry {
    const transcriptTop = createSlot(options.renderer, "transcript-top");
    const transcriptBottom = createSlot(options.renderer, "transcript-bottom");
    const footer = createSlot(options.renderer, "footer");
    const composerAdornment = createSlot(options.renderer, "composer-adornment");
    const overlay = new BoxRenderable(options.renderer, {
        id: "experimental-tui-overlay",
        position: "absolute",
        left: 2,
        right: 2,
        top: 2,
        bottom: 2,
        flexDirection: "column",
        paddingTop: 1,
        paddingBottom: 1,
        paddingLeft: 2,
        paddingRight: 2,
        backgroundColor: options.theme.panel,
        // Client-owned approvals and questions must remain above extension UI.
        zIndex: DIALOG_CARD_Z_INDEX - 1,
        visible: false,
    });

    return {
        transcriptTop,
        transcriptBottom,
        footer,
        composerAdornment,
        overlay,
        slotFor(slot): BoxRenderable {
            switch (slot) {
                case "transcript-top": return transcriptTop;
                case "transcript-bottom": return transcriptBottom;
                case "footer": return footer;
                case "composer-adornment": return composerAdornment;
                case "overlay": return overlay;
            }
        },
        destroy(): void {
            let firstFailure: unknown;
            for (const slot of [
                transcriptTop,
                transcriptBottom,
                footer,
                composerAdornment,
                overlay,
            ]) {
                try {
                    slot.destroy();
                } catch (error) {
                    firstFailure ??= error;
                }
            }
            if (firstFailure !== undefined) throw firstFailure;
        },
    };
}

function createSlot(renderer: CliRenderer, id: string): BoxRenderable {
    return new BoxRenderable(renderer, {
        id: `experimental-tui-${id}`,
        width: "100%",
        flexDirection: "column",
        visible: false,
    });
}
