import { openDials } from "./agents-dials.ts";
import { openPoolVerifyScopePicker } from "./pool-admission.ts";
import type { TuiCommandAction, TuiPaletteEntry } from "../commands.ts";
import { jumpMenuLines, type JumpRow } from "../jump.ts";
import { beginSessionResume, openHelp, openSearchOverlay, openWorkTab, renderCommandSuggestions, resumeJsonlView } from "../main.ts";
import { positionCommandSuggestions } from "../main/chrome.ts";
import { focusActiveSurface } from "../main/focus-switch.ts";
import { openPreferencesList, openReviewerMenu, openReviewerPicker, openThemePicker } from "../main/model-pickers.ts";
import { openSettingsDestination } from "../main/provider-forms.ts";
import { renderState } from "../main/render-state.ts";
import { submitPrompt } from "../main/submit-prompt.ts";
import { startTuiAnimationPicker, startTuiLiveReasoningRowsPicker, startTuiContextLimitPicker, startTuiOverridesMenu, startTuiOverrideValuePicker, startTuiSettingsMenu, withTuiPickerParent, type TuiSettingsMenuTarget, type TuiSettingsPickerState } from "../settings-picker.ts";
import { TUI_ACCENT, TUI_MUTED, TUI_TEXT, appendTuiError, appendTuiNotice } from "../state.ts";
import type { TuiRuntime } from "./runtime.ts";
import { StyledText, fg } from "@opentui/core";

export function openSettingsMenuTarget(rt: TuiRuntime, 
    target: TuiSettingsMenuTarget,
    parent?: TuiSettingsPickerState,
): void {
    if (target === "model") {
        openSettingsDestination(rt, { kind: "model" }, { parent });
        return;
    }
    if (target === "reasoning") {
        openSettingsDestination(rt, { kind: "reasoning" }, { parent });
        return;
    }
    if (target === "theme") return openThemePicker(rt, parent);
    if (target === "animation") {
        rt.settingsPicker = withTuiPickerParent(startTuiAnimationPicker(rt.animationLevel), parent);
        renderState(rt);
        focusActiveSurface(rt);
        return;
    }
    if (target === "live_reasoning_rows") {
        rt.settingsPicker = withTuiPickerParent(
            startTuiLiveReasoningRowsPicker(rt.liveReasoningRows),
            parent,
        );
        renderState(rt);
        focusActiveSurface(rt);
        return;
    }
    if (target === "context_limit") {
        rt.settingsPicker = withTuiPickerParent(
            startTuiContextLimitPicker(rt.state.modelSettings?.contextLimit),
            parent,
        );
        renderState(rt);
        focusActiveSurface(rt);
        return;
    }
    if (target === "overrides") {
        rt.settingsPicker = withTuiPickerParent(
            startTuiOverridesMenu(rt.state.modelSettings?.overrides),
            parent,
        );
        renderState(rt);
        focusActiveSurface(rt);
        return;
    }
    if (target.startsWith("override_")) {
        const pane = startTuiOverrideValuePicker(
            target,
            rt.state.modelSettings?.overrides,
        );
        if (pane !== undefined) {
            rt.settingsPicker = withTuiPickerParent(pane, parent);
            renderState(rt);
            focusActiveSurface(rt);
            return;
        }
    }
    if (target === "permission_mode") {
        openSettingsDestination(rt, { kind: "permission_mode" }, { parent });
        return;
    }
    if (target === "granted_permissions") return openPreferencesList(rt, parent);
    if (target === "reviewer") return openReviewerMenu(rt, parent);
    if (target === "reviewer_primary") {
        return openReviewerPicker(rt, "primary", parent);
    }
    if (target === "reviewer_fallback") {
        return openReviewerPicker(rt, "fallback", parent);
    }
    rt.settingsPicker = withTuiPickerParent(
        startTuiSettingsMenu("permission_settings"),
        parent,
    );
    renderState(rt);
    focusActiveSurface(rt);
}

export function runPaletteAction(rt: TuiRuntime, entry: TuiPaletteEntry): void {
    if (
        entry.action.type === "open_settings_destination"
        || entry.action.type === "open_model_utility"
        || entry.action.type === "prefill_composer"
        || entry.slashName === undefined
    ) {
        rt.composer.clearComposer();
        runStandalonePaletteAction(rt, entry.action);
        return;
    }
    rt.composer.setComposerText(`/${entry.slashName}`);
    renderState(rt);
    submitPrompt(rt);
}

export function runStandalonePaletteAction(rt: TuiRuntime, action: TuiCommandAction): void {
    if (action.type === "open_model_utility") return action.utility === "dials" ? openDials(rt) : openPoolVerifyScopePicker(rt);
    if (action.type === "resume_viewed_session") return resumeJsonlView(rt);
    if (action.type === "prefill_composer") {
        rt.composer.setComposerText(action.text);
        renderCommandSuggestions(rt);
        renderState(rt);
        rt.composer.focus();
        return;
    }
    if (action.type === "open_settings_destination") {
        openSettingsDestination(rt, action.destination);
        return;
    }
    if (action.type === "open_work_tab") return openWorkTab(rt);
    if (action.type === "go_back") return runBack(rt);
    if (action.type === "open_search") return openSearchOverlay(rt, "workspace");
    if (action.type === "open_theme_picker") return openThemePicker(rt);
    if (action.type === "open_preferences_list") {
        return openPreferencesList(rt);
    }
    if (action.type === "open_help") return openHelp(rt, action.tab);
    renderState(rt);
    focusActiveSurface(rt);
}

export function runBack(rt: TuiRuntime): void {
    if (rt.backOriginId === undefined) {
        rt.state = appendTuiNotice(
            rt.state,
            "Nothing to go back to. /work lists what needs you.",
        );
        renderState(rt);
        return;
    }
    if (rt.dependencies.listAgents === undefined) {
        rt.state = appendTuiError(rt.state, "Switching sessions is unavailable");
        renderState(rt);
        return;
    }
    const target = rt.backOriginId;
    void rt.dependencies.listAgents().then((agents) => {
        if (rt.shuttingDown) return;
        const origin = agents.find((agent) => agent.id === target);
        if (origin === undefined) {
            rt.backOriginId = undefined;
            rt.state = appendTuiNotice(
                rt.state,
                "The conversation you came from is gone."
                    + " /resume lists what is still here.",
            );
            renderState(rt);
            return;
        }
        beginSessionResume(rt, 
            origin.session_path,
            origin.id,
            true,
            true,
            "keep_running",
        );
    }).catch((error) => {
        if (rt.shuttingDown) return;
        rt.state = appendTuiError(
            rt.state,
            `Could not go back: ${
                error instanceof Error ? error.message : String(error)
            }`,
        );
        renderState(rt);
    });
}

export function jumpMenuContentWidth(rt: TuiRuntime): number {
    return Math.max(10, rt.jumpMenuBox.width - 4);
}

export function closeJumpMenu(rt: TuiRuntime): void {
    rt.jumpMenu = undefined;
    rt.jumpMenuBox.visible = false;
    rt.composer.focus();
    rt.renderer.requestRender();
}

export function renderJumpMenu(rt: TuiRuntime): void {
    if (rt.jumpMenu === undefined) {
        rt.jumpMenuBox.visible = false;
        rt.renderer.requestRender();
        return;
    }
    const widest = rt.jumpMenu.rows.reduce(
        (columns, row) =>
            Math.max(
                columns,
                row.label.length + (row.detail?.length ?? 0) + 8,
            ),
        24,
    );
    const boxWidth = Math.min(widest, Math.max(24, rt.renderer.width - 8));
    rt.jumpMenuBox.width = boxWidth;
    const lines = jumpMenuLines(rt.jumpMenu, Math.max(10, boxWidth - 4));
    rt.jumpMenuBox.height = lines.length + 2;
    rt.jumpMenuText.content = new StyledText(lines.flatMap((line, index) => [
        line.role === "header"
            ? fg(TUI_MUTED)(line.text)
            : fg(line.selected === true ? TUI_ACCENT : TUI_TEXT)(
                line.text,
            ),
        ...(index === lines.length - 1 ? [] : [fg(TUI_TEXT)("\n")]),
    ]));
    positionCommandSuggestions(rt);
    rt.jumpMenuBox.visible = true;
    rt.renderer.requestRender();
}

export function runJumpTo(rt: TuiRuntime, row: JumpRow): void {
    rt.jumpMenu = undefined;
    rt.jumpMenuBox.visible = false;
    beginSessionResume(rt, 
        row.sessionPath,
        row.sessionId,
        row.kind === "back",
        true,
        "keep_running",
    );
}
