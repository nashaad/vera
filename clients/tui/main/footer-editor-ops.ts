import { renderTuiActivityBar } from "../activity-bar.ts";
import { startFooterEditor, type FooterEditorTransition } from "../footer-editor.ts";
import { footerSeed, type FooterSeed } from "../footer-seed.ts";
import { IDLE_KEYS_HINT, READY_HINT, WORKING_HINT } from "../main.ts";
import { focusActiveSurface } from "../main/focus-switch.ts";
import { renderState } from "../main/render-state.ts";
import type { TuiSettingsPickerState } from "../settings-picker.ts";
import { TUI_ACCENT, TUI_ELEMENT } from "../state.ts";
import type { TuiStatusChunk } from "../status.ts";
import { saveTuiFooterLayout } from "../theme-preference.ts";
import type { TuiRuntime } from "./runtime.ts";

export function openFooterEditor(rt: TuiRuntime, parent?: TuiSettingsPickerState): void {
    rt.footerEditor = startFooterEditor(rt.footerLayout, editorSeed(rt), rt.state.working);
    rt.footerEditorParent = parent;
    rt.composer.blur();
    renderState(rt);
    focusActiveSurface(rt);
}

// Every change shows in the real footer at once; closing saves what it shows.
export function applyFooterEditorTransition(rt: TuiRuntime, transition: FooterEditorTransition): void {
    if (transition.state !== undefined) {
        rt.footerEditor = transition.state;
        rt.footerLayout = transition.state.layout;
        renderState(rt);
        return;
    }
    saveTuiFooterLayout(rt.footerLayout);
    rt.footerEditor = undefined;
    rt.footerEditorView.surface.visible = false;
    rt.settingsPicker = rt.footerEditorParent;
    rt.footerEditorParent = undefined;
    if (rt.settingsPicker === undefined) {
        rt.composer.focus();
    } else {
        rt.settingsPickerView.update(rt.settingsPicker);
        rt.settingsPickerView.focus();
    }
    renderState(rt);
}

export function updateFooterEditorView(rt: TuiRuntime): void {
    if (rt.footerEditor === undefined) return;
    rt.footerEditorView.update(rt.footerEditor);
}

// Hints follow the current key bindings. The strip is a still frame mid-pulse;
// at 0 ms every cell is dim and vanishes on the example's background.
const STILL_STRIP_MS = 1500;

function editorSeed(rt: TuiRuntime): FooterSeed {
    const cells = renderTuiActivityBar("thinking", rt.animationLevel, STILL_STRIP_MS, { active: TUI_ACCENT, dim: TUI_ELEMENT });
    const strip = cells.map((cell): TuiStatusChunk => ({ text: cell.glyph, tone: "accent", color: cell.color }));
    return footerSeed({ ready: READY_HINT, idleKeys: IDLE_KEYS_HINT, keys: WORKING_HINT, strip });
}
