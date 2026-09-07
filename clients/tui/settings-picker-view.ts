import { handleVerificationKey } from "./model-verification.ts";
import { providerActions, providerActionTransition } from "./provider-actions.ts";
import { emptyModelJourney, handleModelJourneyKey, journeyHeader, journeyFooter, journeyWindow, journeyModels } from "./model-journeys.ts";
import { BoxRenderable, fg, StyledText, TextRenderable, type Renderable, type RenderContext, type TextChunk } from "@opentui/core";

import {
    isJobAssignmentId,
    JOB_ASSIGNMENT_INTENTS,
    type ModelAssignmentId,
    type ModelAssignmentRow,
} from "../../src/config/model-assignments.ts";
import type {
    ModelPricing,
    ReasoningLevel,
    ReasoningLevelId,
} from "../../src/model/catalog-shape.ts";
import { formatBlendedRate, formatListedRates } from "../../src/model/listed-rates.ts";
import { stepIntelligenceCutoff } from "../../src/model/intelligence-cutoff.ts";
import {
    isVeraProviderId,
    type VeraCustomProviderConfig,
    type VeraProviderCredential,
    type VeraProviderProtocol,
} from "../../src/config.ts";
import type {
    ModelTurnSettings,
    ReviewerModelDefault,
    ReviewerModelSelection,
} from "../../src/engine/model-settings.ts";
import { TUI_ACCENT, TUI_CHROME, TUI_DANGER, TUI_ELEMENT, TUI_INPUT, TUI_MUTED, TUI_PANEL, TUI_SUCCESS, TUI_SELECTION_TEXT, TUI_TEXT } from "./state.ts";
import {
    dialogBoxHeight,
    halfPageCursor,
    LIST_MIN_ROWS,
    listWindowRows,
    listWindowSlice,
    wheelCursor,
} from "./list-window.ts";
import { APP_PADDING_BOTTOM, APP_PADDING_TOP, DIALOG_CARD_Z_INDEX, DIALOG_CARD_PADDING, DIALOG_CHROME_HEIGHT, DIALOG_BUTTON_LINES, dialogButtonNode, DIALOG_GUTTER, dialogFooterNode, dialogGroupHeaderNode, dialogHeaderNode, dialogInsetBottomOffset, dialogInsetTop, attachDialogRowPointer, dialogOptionRows, dialogRowPointer, type DialogRowPointer, createDialogSearchNode, updateDialogSearchNode, centeredDialogSurface } from "./dialog-chrome.ts";
import { tuiThemeSwatch, type TuiThemeName } from "./theme.ts";
import {
    tuiThemeProperties,
    type TuiThemeBinding,
} from "./theme-bindings.ts";
import { tuiBindingId, tuiKeyHint } from "./keymap.ts";
import {
    atFirstPickerSection,
    focusedOnSection,
    focusedPickerSection,
    repairedSectionFocus,
    sectionHasKeys,
    steppedPickerSection,
    teachesSectionRing,
} from "./picker-sections.ts";
import {
    insertTuiSingleLinePaste,
    tuiTextareaKey,
} from "./single-line-editor.ts";

import {
    MODEL_ASSIGNMENT_BROWSE_VALUE,
    MODEL_ASSIGNMENT_SELF_VALUE,
    REVIEWER_CLEAR_VALUE,
    SESSION_MODEL_VALUE,
    type TuiAnySettingsPickerState,
    type TuiExtensionPickerActionKey,
    type TuiExtensionPickerState,
    type TuiExtensionPickerTransition,
    type TuiModelPickerTab,
    type TuiPickerTipLine,
    type TuiSettingsPickerKey,
    type TuiSettingsPickerKind,
    type TuiSettingsPickerOption,
    type TuiSettingsPickerState,
    type TuiSettingsPickerTransition,
    type TuiSettingsPickerView,
    tuiModelActionOfValue,
} from "./settings-picker-types.ts";

import {
    ALL_MODELS_SECTION_GAP_LINES,
    ALL_MODELS_TREE_PAD_LINES,
    INTELLIGENCE_SCALE_LINES,
    MODEL_ALL_MAX_ROWS,
    modelArrowHintChunks,
    MODEL_LIST_RULE_GAP,
    allModelsInfoOption,
    allModelsPriceChromeLines,
    allModelsPriceNode,
    enclosingSection,
    intelligenceScaleLines,
    isPooled,
    listedFactsFootnoteNode,
    listedFactsHeaderText,
    metaPartsLength,
    modelActionCursor,
    modelActionLineChunks,
    modelActionTransition,
    modelDetailActionTransition,
    modelDetailActions,
    modelDetailHeight,
    modelDetailNode,
    modelEmptyMessage,
    modelHelpNode,
    modelListAction,
    modelListActionLineChunks,
    modelListActionTransition,
    modelListFor,
    modelOptionCanVerify,
    modelPageActions,
    modelPageEntry,
    modelPageEntryLabel,
    modelPaneNote,
    modelPaneSplit,
    modelStripPane,
    modelStripStop,
    modelTabRows,
    modelTabStripHeight,
    modelTabStripNode,
    optionMeta,
    optionMetaPrefixParts,
    pickerCardWidth,
    pickerContentWidth,
    pickerIsSearchable,
    pickerSelection,
    restoredCursor,
    searched,
    sectionLabels,
    showsAllModelsPrices,
    showsIntelligenceCutoff,
    showsListedFactsHeader,
    stackedBelowListLines,
    stackedDetailLines,
    switchedModelTab,
    themePreview,
    toggledSection,
    unchanged,
    wrappedTo,
} from "./settings-picker-model.ts";

export function handleTuiExtensionPickerKey(
    state: TuiExtensionPickerState,
    key: TuiSettingsPickerKey,
): TuiExtensionPickerTransition {
    if (key.ctrl || key.meta || key.super || key.hyper || key.shift) {
        return unchanged(state, false);
    }
    if (key.name === "escape") {
        return { handled: true };
    }
    if (key.name === "up" || key.name === "down") {
        const step = key.name === "up" ? -1 : 1;
        const nextIndex = Math.min(
            state.options.length - 1,
            Math.max(0, state.selectedIndex + step),
        );
        const next = state.options[nextIndex];
        return unchanged({
            ...state,
            selectedIndex: nextIndex,
            ...(next === undefined ? {} : { selectedId: next.value }),
        }, true);
    }

    const actionKey = extensionPickerActionKey(key);
    const action = actionKey === undefined
        ? undefined
        : state.extensionActions?.find((candidate) =>
            candidate.key === actionKey
        );
    const row = state.options[state.selectedIndex];
    if (action === undefined) {
        return unchanged(state, false);
    }
    if (row === undefined) {
        return unchanged(state, true);
    }
    return {
        selection: {
            kind: "extension",
            rowId: row.value,
            actionId: action.id,
        },
        handled: true,
    };
}

export function extensionPickerActionKey(
    key: TuiSettingsPickerKey,
): TuiExtensionPickerActionKey | undefined {
    if (key.name === "return" || key.name === "enter") return "enter";
    if (key.name === "d") return "d";
    if (key.name === "s") return "s";
    if (key.name === "delete") return "delete";
    if (key.name === "backspace") return "backspace";
    return undefined;
}

export function handleTuiSettingsPickerKey(
    state: TuiExtensionPickerState,
    key: TuiSettingsPickerKey,
    viewportRows?: number,
): TuiExtensionPickerTransition;

export function handleTuiSettingsPickerKey(
    state: TuiSettingsPickerState,
    key: TuiSettingsPickerKey,
    viewportRows?: number,
): TuiSettingsPickerTransition;

export function handleTuiSettingsPickerKey(
    state: TuiAnySettingsPickerState,
    key: TuiSettingsPickerKey,
    viewportRows?: number,
): TuiSettingsPickerTransition | TuiExtensionPickerTransition {
    if (state.kind === "extension") {
        return handleTuiExtensionPickerKey(state, key);
    }
    if (state.kind === "model_assignment" && state.options[state.selectedIndex]?.value === "verify_shortlist"
        && (key.name === "enter" || key.name === "return")) return { state, handled: true, poolVerifySweep: true };
    if (state.kind === "model_defaults") {
        if (key.name === "escape") return { state: state.parent, handled: true };
        if (key.name === "enter" || key.name === "return") {
            const row = state.options[state.selectedIndex];
            return row === undefined ? { state, handled: true } : { state, handled: true,
                selection: { kind: "model_assignment_open", assignment: row.value as ModelAssignmentId } };
        }
    }
    if (state.kind === "model_verification" || state.verificationTargets !== undefined) return handleVerificationKey(state, key);
    if (state.modelJourney !== undefined) return handleModelJourneyKey(state, key, viewportRows);
    if (state.kind === "model") {
        // Whoever rebuilt this pane may have taken the focused section away.
        // Settle that once, here, so no handler below has to ask.
        const repaired = repairedSectionFocus(state);
        if (repaired !== state) {
            return handleTuiSettingsPickerKey(repaired, key, viewportRows);
        }
    }
    if (
        state.kind === "session"
        && tuiBindingId("session_picker", key) === "rename_session"
    ) {
        const selected = state.options[state.selectedIndex];
        return selected?.sessionId === undefined
            ? unchanged(state, true)
            : {
                state,
                renameCandidate: {
                    sessionId: selected.sessionId,
                    label: selected.label,
                    ...(selected.sessionName === undefined
                        ? {}
                        : { value: selected.sessionName }),
                },
                handled: true,
            };
    }
    if (
        state.kind === "session"
        && tuiBindingId("session_picker", key) === "trash_session"
    ) {
        const selected = state.options[state.selectedIndex];
        return selected?.sessionId === undefined
            ? unchanged(state, true)
            : {
                state,
                trashCandidate: {
                    sessionId: selected.sessionId,
                    label: selected.label,
                },
                handled: true,
            };
    }
    if (
        state.kind === "session"
        && tuiBindingId("session_picker", key) === "background_switch"
    ) {
        const selected = state.options[state.selectedIndex];
        return selected === undefined
            ? unchanged(state, true)
            : {
                selection: {
                    kind: "session",
                    sessionPath: selected.value,
                    sourceDisposition: "keep_running",
                    ...(selected.sessionId === undefined
                        ? {}
                        : { sessionId: selected.sessionId }),
                },
                handled: true,
            };
    }
    if (
        state.kind === "model_assignment"
        && state.modelAssignment === "subagents"
        && tuiBindingId("model_assignment_picker", key)
            === "toggle_subagent_assignment"
    ) {
        const selected = state.options[state.selectedIndex];
        if (
            selected === undefined
            || selected.value === REVIEWER_CLEAR_VALUE
            || selected.value === MODEL_ASSIGNMENT_BROWSE_VALUE
        ) {
            return unchanged(state, true);
        }
        return {
            state,
            selection: {
                ...pickerSelection(state, selected),
                ...(state.assignedModels?.includes(selected.value) === true
                    || selected.value === MODEL_ASSIGNMENT_SELF_VALUE
                    ? {}
                    : { acceptDefaultReasoning: true as const }),
            },
            handled: true,
        };
    }
    if (
        state.kind === "model"
        && tuiBindingId("model_picker", key) === "toggle_pooled"
    ) {
        const selected = state.options[state.selectedIndex];
        if (selected?.provider === undefined || selected.model === undefined) {
            return unchanged(state, true);
        }
        return {
            state,
            handled: true,
            poolToggle: {
                action: isPooled(state, selected) ? "remove" : "add",
                provider: selected.provider,
                model: selected.model,
            },
        };
    }
    if (
        state.kind === "model"
        && tuiBindingId("model_picker", key) === "undo_pool_change"
    ) {
        return state.canUndoPoolChange === true
            ? { state, handled: true, undoPoolChange: true }
            : unchanged(state, true);
    }
    if (
        state.kind === "model"
        && tuiBindingId("model_picker", key) === "name_pooled"
    ) {
        const selected = state.options[state.selectedIndex];
        if (
            selected?.provider === undefined || selected.model === undefined
            || !isPooled(state, selected)
        ) {
            return unchanged(state, true);
        }
        return {
            state,
            handled: true,
            poolName: {
                provider: selected.provider,
                model: selected.model,
                label: selected.label,
            },
        };
    }
    if (
        state.kind === "model"
        && (tuiBindingId("model_picker", key) === "move_pooled_up"
            || tuiBindingId("model_picker", key) === "move_pooled_down")
    ) {
        const selected = state.options[state.selectedIndex];
        if (
            selected?.provider === undefined || selected.model === undefined
            || !isPooled(state, selected)
        ) {
            return unchanged(state, true);
        }
        return {
            state,
            handled: true,
            poolMove: {
                provider: selected.provider,
                model: selected.model,
                delta: tuiBindingId("model_picker", key) === "move_pooled_up"
                    ? -1
                    : 1,
            },
        };
    }
    if (
        (state.kind === "model" || state.kind === "provider")
        && tuiBindingId("model_picker", key) === "refresh_catalog"
    ) {
        const selected = state.options[state.selectedIndex];
        const provider = state.kind === "provider"
            ? (selected?.action === true ? undefined : selected?.value)
            : selected?.provider;
        if (provider === undefined || selected?.refreshable !== true) {
            return unchanged(state, true);
        }
        return { state, handled: true, refreshCatalog: provider };
    }
    if (
        state.kind === "model"
        && tuiBindingId("model_picker", key) === "verify_pool"
    ) {
        return { state, handled: true, poolVerifySweep: true };
    }
    if (
        state.kind === "model"
        && tuiBindingId("model_picker", key) === "verify_model"
    ) {
        const selected = state.options[state.selectedIndex];
        if (selected?.provider === undefined || selected.model === undefined) {
            return unchanged(state, true);
        }
        return {
            state,
            handled: true,
            poolVerify: {
                provider: selected.provider,
                model: selected.model,
            },
        };
    }
    if (
        state.kind === "model"
        && tuiBindingId("model_picker", key) === "reveal_all_models"
    ) {
        const modelState = state as TuiSettingsPickerState;
        const revealAll = modelState.revealAll !== true;
        const options = modelListFor(modelState, { revealAll });
        const selectedValue = modelState.options[modelState.selectedIndex]
            ?.value;
        return {
            state: {
                ...modelState,
                revealAll,
                options,
                selectedIndex: restoredCursor(
                    options,
                    selectedValue,
                    modelState.initialModel,
                ),
            },
            handled: true,
        };
    }
    if (
        state.kind === "model"
        && tuiBindingId("model_picker", key) === "open_providers"
    ) {
        return { state, handled: true, openProviders: true };
    }
    if (
        state.kind === "model"
        && tuiBindingId("model_picker", key) === "switch_tab"
        && key.ctrl !== true
        && (state.pickerLevel ?? "page") === "page"
    ) {
        // In the page, tab belongs to the sections. Shift+tab off the first one
        // is the way back up to the strip, so the two levels share one key
        // without either needing a chord the terminal may not report.
        const backward = key.shift === true;
        if (backward && atFirstPickerSection(state)) {
            return {
                state: { ...state, pickerLevel: "strip" },
                handled: true,
            };
        }
        const next = steppedPickerSection(state, backward ? -1 : 1);
        // A page with one section has nowhere else to put the cursor, so tab
        // means the strip there rather than nothing at all.
        return next === undefined
            ? { state: { ...state, pickerLevel: "strip" }, handled: true }
            : { state: focusedOnSection(state, next), handled: true };
    }
    if (
        state.kind === "model"
        && (state.pickerLevel ?? "page") === "strip"
        && (key.name === "left" || key.name === "right")
        && key.shift !== true
        && key.ctrl !== true
    ) {
        return steppedModelTabTransition(state, key.name === "left");
    }
    if (
        state.kind === "model"
        && (state.pickerLevel ?? "page") === "strip"
        && (key.name === "down" || key.name === "return"
            || key.name === "enter")
    ) {
        return { state: descendedIntoPage(state), handled: true };
    }
    if (
        state.kind === "model"
        && tuiBindingId("model_picker", key) === "switch_tab"
    ) {
        return steppedModelTabTransition(state, key.shift === true);
    }
    if (
        state.kind === "provider"
        && tuiBindingId("model_picker", key) === "declare_provider"
    ) {
        return { state, handled: true, declareProvider: true };
    }
    if (
        state.kind === "provider"
        && tuiBindingId("model_picker", key) === "edit_endpoint"
    ) {
        const selected = state.options[state.selectedIndex];
        if (selected?.endpointEditable !== true) {
            return unchanged(state, true);
        }
        return selected.declared === true
            ? { state, handled: true, editProvider: selected.value }
            : { state, handled: true, editEndpoint: selected.value };
    }
    if (
        state.kind === "provider"
        && tuiBindingId("model_picker", key) === "forget_provider"
    ) {
        const selected = state.options[state.selectedIndex];
        if (selected === undefined || selected.action === true) {
            return unchanged(state, true);
        }
        return { state, handled: true, forgetProvider: selected.value };
    }
    if (state.kind === "model" && state.modelFocus === "page") {
        const actions = modelPageActions(state);
        const selected = Math.min(
            state.modelPageIndex ?? 0,
            Math.max(0, actions.length - 1),
        );
        if (key.name === "left" || key.name === "escape") {
            return {
                state: { ...state, modelFocus: "page_entry" },
                handled: true,
            };
        }
        if (key.name === "up" || key.name === "down") {
            const delta = key.name === "up" ? -1 : 1;
            return {
                state: {
                    ...state,
                    modelPageIndex: Math.max(
                        0,
                        Math.min(actions.length - 1, selected + delta),
                    ),
                },
                handled: true,
            };
        }
        if (key.name === "return" || key.name === "enter") {
            const transition = modelActionTransition(state, actions[selected]!);
            return transition ?? unchanged(state, true);
        }
        if (key.name === "right") {
            return unchanged(state, true);
        }
        if ((key.name.length === 1 || key.name === "space") && !key.ctrl) {
            return unchanged(state, true);
        }
    }
    if (state.kind === "model" && state.modelFocus === "page_entry") {
        if (
            key.name === "right" || key.name === "return"
            || key.name === "enter"
        ) {
            return modelPageActions(state).length === 0
                ? unchanged(state, true)
                : {
                    state: { ...state, modelFocus: "page", modelPageIndex: 0 },
                    handled: true,
                };
        }
        if (key.name === "up" || key.name === "down" || key.name === "left") {
            // The More button is a section of its own; tab is what leaves it.
            return unchanged(state, true);
        }
    }
    if (state.kind === "model" && state.modelFocus === "intelligence") {
        if (key.name === "left" || key.name === "right") {
            const intelligenceCutoff = stepIntelligenceCutoff(
                state.intelligenceCutoff ?? "any",
                key.name === "right" ? 1 : -1,
            );
            const options = modelListFor(state, { intelligenceCutoff });
            return {
                state: {
                    ...state,
                    intelligenceCutoff,
                    options,
                    selectedIndex: restoredCursor(
                        options,
                        state.options[state.selectedIndex]?.value,
                        state.initialModel,
                    ),
                },
                handled: true,
            };
        }
        if (key.name === "up" || key.name === "down") {
            // Left and right are the cutoff's own keys; up and down would be
            // leaving the section, which is tab's job.
            return unchanged(state, true);
        }
    }
    if (state.kind === "model" && state.modelFocus === "detail") {
        const actions = modelDetailActions(
            state,
            state.options[state.selectedIndex],
        );
        const selectedAction = modelActionCursor(state, actions);
        if (key.name === "left") {
            return {
                state: { ...state, modelFocus: "list" },
                handled: true,
            };
        }
        if (key.name === "right") {
            return unchanged(state, true);
        }
        if (key.name === "up" || key.name === "down") {
            const delta = key.name === "up" ? -1 : 1;
            return {
                state: {
                    ...state,
                    modelActionIndex: Math.max(
                        0,
                        Math.min(actions.length - 1, selectedAction + delta),
                    ),
                },
                handled: true,
            };
        }
        if (key.name === "return" || key.name === "enter") {
            return modelDetailActionTransition(state, actions[selectedAction]);
        }
        if ((key.name.length === 1 || key.name === "space") && !key.ctrl) {
            return unchanged(state, true);
        }
    }
    if (state.kind === "model" && state.modelFocus === "list_action") {
        if (key.name === "up") {
            return {
                state: { ...state, modelFocus: "list" },
                handled: true,
            };
        }
        if (key.name === "down" || key.name === "left") {
            return unchanged(state, true);
        }
        if (key.name === "right") {
            const actions = modelDetailActions(
                state,
                state.options[state.selectedIndex],
            );
            return actions.length === 0
                ? unchanged(state, true)
                : {
                    state: {
                        ...state,
                        modelFocus: "detail",
                        modelActionIndex: 0,
                    },
                    handled: true,
                };
        }
        if (key.name === "return" || key.name === "enter") {
            return modelListActionTransition(state, modelListAction(state));
        }
        if ((key.name.length === 1 || key.name === "space") && !key.ctrl) {
            return unchanged(state, true);
        }
    }
    const foldAll = state.kind !== "model"
        ? undefined
        : tuiBindingId("model_picker", key);
    if (foldAll === "collapse_all" || foldAll === "expand_all") {
        const collapsed = foldAll === "collapse_all"
            ? sectionLabels(state as TuiSettingsPickerState)
            : [];
        const modelState = state as TuiSettingsPickerState;
        const options = modelListFor(modelState, { collapsed });
        const selectedValue = modelState.options[modelState.selectedIndex]
            ?.value;
        return {
            state: {
                ...modelState,
                collapsed,
                options,
                selectedIndex: restoredCursor(
                    options,
                    selectedValue,
                    modelState.initialModel,
                ),
            },
            handled: true,
        };
    }
    const halfPage = tuiBindingId("picker", key);
    if (halfPage === "half_page_down" || halfPage === "half_page_up") {
        const next = {
            ...state,
            selectedIndex: halfPageCursor(
                state.selectedIndex,
                state.options.length,
                viewportRows ?? FALLBACK_JUMP * 2,
                halfPage === "half_page_down" ? "down" : "up",
            ),
        };
        return { state: next, handled: true, ...themePreview(next) };
    }
    if (key.ctrl || key.meta || key.super || key.hyper || key.shift) {
        return unchanged(state, false);
    }
    if (
        key.name === "escape"
        && state.kind === "model"
        && (state.pickerLevel ?? "page") === "page"
    ) {
        // Up one level, not out. A second escape closes the card.
        return { state: { ...state, pickerLevel: "strip" }, handled: true };
    }
    if (key.name === "escape") {
        const preview = state.kind === "theme" && state.initialTheme !== undefined
            ? { previewTheme: state.initialTheme }
            : {};
        if (state.parent !== undefined) {
            return { state: state.parent, handled: true, ...preview };
        }
        return { handled: true, ...preview };
    }
    if (
        digitQuickSelect(state)
        && state.query === ""
        && /^[1-9]$/.test(key.name)
    ) {
        const selected = state.options[Number(key.name) - 1];
        if (selected === undefined) {
            return unchanged(state, true);
        }
        return {
            selection: pickerSelection(state, selected),
            handled: true,
        };
    }
    if (
        state.kind === "model_assignment"
        && state.modelAssignment === "subagents"
        && (key.name.length === 1 || key.name === "space")
    ) {
        return unchanged(state, true);
    }
    if (key.name.length === 1 || key.name === "space") {
        return unchanged(state, true);
    }
    if (key.name === "left" || key.name === "right") {
        if (
            state.kind === "model"
            && key.name === "right"
            && state.options[state.selectedIndex]?.section === undefined
        ) {
            const actions = modelDetailActions(
                state,
                state.options[state.selectedIndex],
            );
            if (actions.length > 0) {
                return {
                    state: {
                        ...state,
                        modelFocus: "detail",
                        modelActionIndex: 0,
                    },
                    handled: true,
                };
            }
        }
        const heading = enclosingSection(state);
        if (heading === undefined) {
            return unchanged(state, false);
        }
        const closed = heading.sectionCollapsed === true;
        if (closed === (key.name === "left")) {
            return unchanged(state, true);
        }
        return toggledSection(state, heading.section);
    }
    if (key.name === "up") {
        const next = {
                ...state,
                selectedIndex: Math.max(0, state.selectedIndex - 1),
            };
        return {
            state: next,
            handled: true,
            ...themePreview(next),
        };
    }
    if (key.name === "down") {
        if (
            state.kind === "model"
            && state.selectedIndex === state.options.length - 1
            && modelListAction(state) !== undefined
        ) {
            return {
                state: { ...state, modelFocus: "list_action" },
                handled: true,
            };
        }
        const next = {
                ...state,
                selectedIndex: Math.max(
                    0,
                    Math.min(
                        state.options.length - 1,
                        state.selectedIndex + 1,
                    ),
                ),
            };
        return {
            state: next,
            handled: true,
            ...themePreview(next),
        };
    }
    if (key.name === "return" || key.name === "enter") {
        const selected = state.options[state.selectedIndex];
        if (selected === undefined) {
            return unchanged(state, true);
        }
        if (state.kind === "model" && selected.section !== undefined) {
            return toggledSection(state, selected.section);
        }
        if (state.kind === "provider" && selected.action === true) {
            return { state, handled: true, declareProvider: true };
        }
        if (state.kind === "provider") {
            return { state: providerActions(state, selected), handled: true };
        }
        if (state.kind === "provider_actions") {
            return providerActionTransition(state);
        }
        const action = state.kind === "model"
            ? modelActionTransition(state as TuiSettingsPickerState, selected)
            : undefined;
        if (action !== undefined) {
            return action;
        }
        if (state.kind === "model" && selected.value === SESSION_MODEL_VALUE) {
            return {
                state: switchedModelTab(state as TuiSettingsPickerState, "all"),
                handled: true,
            };
        }
        return {
            selection: pickerSelection(state, selected),
            handled: true,
        };
    }
    return unchanged(state, false);
}

/** The tab to either side, wrapping through Providers, which is a page of its own rather than a tab in the strip. */
function steppedModelTabTransition(
    state: TuiSettingsPickerState,
    backward: boolean,
): TuiSettingsPickerTransition {
    const cycle: readonly TuiModelPickerTab[] = [
        "pool",
        "all",
        "actions",
        "defaults",
        "help",
    ];
    const at = cycle.indexOf(state.tab ?? "all");
    const wraps = backward ? at === 0 : at === cycle.length - 1;
    const next = backward
        ? cycle[at - 1] ?? cycle.at(-1)!
        : cycle[at + 1] ?? cycle[0]!;
    return {
        state: switchedModelTab(state, wraps ? (backward ? cycle.at(-1)! : cycle[0]!) : next),
        handled: true,
        ...(wraps ? { openProviders: true } : {}),
    };
}

/** Into the page, on the list. The list is what the page is for, and the sections above it are a shift+tab away; landing on the More button instead would leave the arrows with nothing to move. */
function descendedIntoPage(
    state: TuiSettingsPickerState,
): TuiSettingsPickerState {
    return { ...focusedOnSection(state, "list"), pickerLevel: "page" };
}

export function handleTuiSettingsPickerScroll(
    state: TuiAnySettingsPickerState,
    scroll: { readonly direction: "up" | "down" | "left" | "right"; readonly delta: number },
): TuiSettingsPickerTransition | TuiExtensionPickerTransition {
    const selectedIndex = wheelCursor(
        state.selectedIndex,
        state.options.length,
        scroll,
    );
    if (state.kind === "extension") {
        return selectedIndex === undefined
            ? unchanged(state, false)
            : { state: { ...state, selectedIndex }, handled: true };
    }
    if (selectedIndex === undefined) {
        return unchanged(state, false);
    }
    const next = { ...state, selectedIndex };
    return { state: next, handled: true, ...themePreview(next) };
}

export function updateTuiSettingsPickerSearch(
    state: TuiSettingsPickerState,
    query: string,
    cursor = query.length,
): TuiSettingsPickerTransition {
    return pickerIsSearchable(state)
        ? searched(state, query, cursor)
        : unchanged(state, false);
}

export function createTuiSettingsPickerView(
    renderer: RenderContext,
): TuiSettingsPickerView {
    let nodes: Renderable[] = [];
    let searchLive = false;
    const search = createDialogSearchNode(renderer, "settings-picker-search");
    const box = new BoxRenderable(renderer, {
        id: "settings-picker",
        border: false,
        backgroundColor: TUI_PANEL,
        width: "80%",
        height: 8,
        zIndex: DIALOG_CARD_Z_INDEX,
        paddingLeft: DIALOG_CARD_PADDING,
        paddingRight: DIALOG_CARD_PADDING,
        paddingTop: 2,
        paddingBottom: 1,
        focusable: true,
    });
    const surface = centeredDialogSurface(renderer, "settings-picker-surface", box);

    const view: TuiSettingsPickerView = {
        box,
        surface,
        focus(): void {
            if (searchLive) search.focus();
            else box.focus();
        },
        handleEditorKey(state, key): TuiSettingsPickerTransition {
            if (
                !pickerIsSearchable(state)
                || (state.modelJourney !== undefined && (key.ctrl === true || tuiBindingId("switch_model_picker", key) === "journey_scope"
                    || (state.tab === "all" && key.name === "left")
                    || (state.modelFocus === "intelligence" && key.name === "right")))
                || (state.kind === "model" && state.tab === "help")
                || key.name === "escape" || key.name === "up"
                || key.name === "down" || key.name === "return"
                || key.name === "enter" || key.name === "kpenter"
                || tuiBindingId("picker", key) !== undefined
                || ((state.kind === "model" || state.kind === "provider")
                    && tuiBindingId("model_picker", key) !== undefined)
                || (state.kind === "session"
                    && tuiBindingId("session_picker", key) !== undefined)
                || (state.query.length === 0
                    && (key.name === "left" || key.name === "right"))
                || (digitQuickSelect(state) && state.query === ""
                    && /^[1-9]$/.test(key.name))
            ) {
                return unchanged(state, false);
            }
            if (!search.handleKeyPress(tuiTextareaKey(key))) {
                return unchanged(state, false);
            }
            return updateTuiSettingsPickerSearch(
                state,
                search.plainText,
                search.cursorOffset,
            );
        },
        handleEditorPaste(state, text): TuiSettingsPickerTransition {
            if (
                !pickerIsSearchable(state)
                || (state.kind === "model" && state.tab === "help")
            ) {
                return unchanged(state, false);
            }
            insertTuiSingleLinePaste(search, text);
            return updateTuiSettingsPickerSearch(
                state,
                search.plainText,
                search.cursorOffset,
            );
        },
        update(state, railInset = 0): void {
            search.parent?.remove(search.id);
            for (const node of nodes) {
                node.destroyRecursively();
            }
            nodes = [];
            searchLive = state.kind !== "extension"
                && pickerIsSearchable(state)
                && !(state.kind === "model" && (state.tab === "help" || state.modelFocus === "intelligence"));
            box.title = undefined;
            surface.justifyContent = state.kind === "session" ? "flex-start" : "center";
            if (state.kind === "theme") {
                box.paddingTop = 2;
                box.paddingBottom = 1;
                box.width = "60%";
                box.height = "auto";
                renderThemePickerRows(
                    renderer,
                    box,
                    state,
                    nodes,
                    search,
                    view.pointer,
                );
                return;
            }
            box.width = state.kind === "session"
                ? "100%"
                : state.kind === "model"
                ? "96%"
                : "80%";
            renderListPickerRows(
                renderer,
                box,
                state,
                nodes,
                view.pointer,
                view.tip,
                view.verification,
                view.onTab,
                view.onConfigure,
                search,
                railInset,
            );
        },
    };
    return view;
}

export const FALLBACK_JUMP = 5;

export function pickerMaxRows(
    renderer: RenderContext,
    extraChrome: number,
    rowLines = 1,
): number {
    const lines = listWindowRows(
        dialogBoxHeight(
            renderer,
            dialogInsetTop(renderer),
            dialogInsetBottomOffset(renderer),
        ),
        DIALOG_CHROME_HEIGHT + extraChrome,
    );
    return Math.max(LIST_MIN_ROWS, Math.floor(lines / rowLines));
}

export const THEME_CARD_CHROME_LINES = 9;

export function themePickerTop(renderer: RenderContext, themeRows: number): number {
    const height = themeRows + THEME_CARD_CHROME_LINES;
    return Math.max(
        APP_PADDING_TOP,
        Math.min(
            dialogInsetTop(renderer),
            renderer.height - APP_PADDING_BOTTOM - height,
        ),
    );
}

export function tuiPickerViewportRows(
    renderer: RenderContext,
    state: TuiAnySettingsPickerState,
    extraChrome = 0,
): number {
    if (state.kind === "model" && state.modelJourney !== undefined) return journeyListLayout(renderer, state).rows;
    const stripHeight = modelStripStop(state) === undefined
        ? 0
        : modelTabStripHeight(pickerContentWidth(renderer, state));
    const listedHeaderLines = showsListedFactsHeader(state)
            && state.options.length > 0
        ? 1
        : 0;
    const modelTreePadLines = listedHeaderLines > 0
        ? ALL_MODELS_TREE_PAD_LINES
        : 0;
    const intelligenceLines = showsIntelligenceCutoff(state)
        ? INTELLIGENCE_SCALE_LINES + ALL_MODELS_SECTION_GAP_LINES
        : 0;
    const allModelsInfoLines = showsAllModelsPrices(state)
        ? allModelsPriceChromeLines()
        : 0;
    const rows = pickerMaxRows(
        renderer,
        stripHeight
            + (state.kind === "extension" && state.subtitle !== undefined ? 1 : 0)
            + listedHeaderLines
            + modelTreePadLines
            + intelligenceLines
            + allModelsInfoLines
            + extraChrome,
    );
    return state.kind === "model" && state.tab === "all"
        ? Math.min(rows, MODEL_ALL_MAX_ROWS)
        : rows;
}

function journeyScopeLayout(renderer: RenderContext, state: TuiSettingsPickerState, railInset = 0) {
    const text = [journeyHeader(state), state.journeyNotice].filter(Boolean).join("\n");
    const headerLines = text ? text.split("\n").flatMap((line) => wrappedTo(line, pickerContentWidth(renderer, state, railInset))) : [];
    const scope = state.modelJourney === "switch";
    const summaryMargin = scope && renderer.height < 30 ? 0 : 1;
    const headerHeight = (scope ? 2 : 0) + (headerLines.length ? headerLines.length + summaryMargin : 0);
    const cutoff = state.modelJourney === "switch" && state.tab === "all";
    const priceLines = cutoff ? (renderer.height < 30 ? 1 : 3) : 0;
    const room = Math.max(1, renderer.height - 14 - headerHeight - (cutoff ? 4 : 0) - priceLines);
    const split = state.options.length === 0 ? undefined : modelPaneSplit(renderer, state, railInset);
    const rowWidth = split === undefined ? pickerContentWidth(renderer, state, railInset) : split.listWidth - MODEL_LIST_RULE_GAP;
    const listed = cutoff && rowWidth >= 48 && room >= 4;
    const rows = Math.max(1, Math.min(12, room - (listed ? 2 : 0)));
    const groups = state.options.filter((row, index) => index === 0 || row.group !== state.options[index - 1]?.group).length;
    const listHeight = Math.min(rows, Math.max(2, state.options.length + groups * 2 - 1));
    const detailHeight = split === undefined ? 0 : Math.max(0, ...state.options.map((_, selectedIndex) =>
        modelDetailHeight({ ...state, selectedIndex }, split.detailWidth)));
    const bodyHeight = Math.max(1, Math.min(room - (listed ? 1 : 0), Math.max(listHeight + (listed ? 1 : 0), detailHeight)));
    return { priceLines, listed, rows, bodyHeight, headerLines, summaryMargin, chromeHeight: headerHeight + (cutoff ? 4 : 0) + priceLines + (listed ? 1 : 0) };

}

function journeyListLayout(renderer: RenderContext, state: TuiSettingsPickerState, railInset = 0) {
    const layout = journeyScopeLayout(renderer, state, railInset);
    if (state.modelJourney !== "switch") return layout;
    const other = { ...state, tab: state.tab === "all" ? "pool" as const : "all" as const };
    const alternative = journeyScopeLayout(renderer, { ...other, options: journeyModels(other) }, railInset);
    const height = Math.max(layout.chromeHeight + layout.bodyHeight, alternative.chromeHeight + alternative.bodyHeight);
    return { ...layout, bodyHeight: height - layout.chromeHeight };
}

export type PickerDisplayRow =
    | { readonly kind: "group"; readonly label: string }
    | {
        readonly kind: "option";
        readonly option: TuiSettingsPickerOption;
        readonly index: number;
    };

const TIP_LABELS: Record<TuiPickerTipLine["tone"], string> = {
    tip: "Tip",
    refusal: "Not set",
};

export function renderListPickerRows(
    renderer: RenderContext,
    box: BoxRenderable,
    state: TuiAnySettingsPickerState,
    nodes: Renderable[],
    pointer?: DialogRowPointer,
    tip?: string | TuiPickerTipLine,
    verification?: { readonly subject: string },
    onTab?: (tab: TuiModelPickerTab) => void,
    onConfigure?: () => void,
    search?: ReturnType<typeof createDialogSearchNode>,
    railInset = 0,
): void {
    if (state.kind === "model" && state.modelJourney !== undefined) {
        const width = pickerContentWidth(renderer, state, railInset);
        const add = (node: Renderable) => { box.add(node); nodes.push(node); };
        add(dialogHeaderNode(renderer, state.title ?? "Switch model"));
        const layout = journeyListLayout(renderer, state, railInset);
        if (state.modelJourney === "switch") {
            const scope = new BoxRenderable(renderer, { width: "100%", height: 1, marginTop: 1, flexDirection: "row", gap: 2 });
            for (const [tab, label] of [["pool", "Shortlist"], ["all", "All models"]] as const) {
                const active = state.tab === tab;
                const chip = new TextRenderable(renderer, {
                    content: active ? `[ ${label} ]` : `  ${label}  `, height: 1,
                    fg: active ? TUI_SELECTION_TEXT : TUI_MUTED,
                    bg: active ? TUI_ACCENT : TUI_PANEL, attributes: active ? 1 : 0,
                });
                if (onTab !== undefined) chip.onMouseDown = (event) => {
                    event.preventDefault(); event.stopPropagation(); onTab(tab);
                };
                scope.add(chip);
            }
            scope.add(new TextRenderable(renderer, { content: "tab to switch", fg: TUI_MUTED, height: 1 }));
            add(scope);
        }
        if (layout.headerLines.length) add(new TextRenderable(renderer, {
            content: layout.headerLines.join("\n"), fg: TUI_MUTED, height: layout.headerLines.length,
            marginTop: layout.summaryMargin, width: "100%",
        }));
        if (search !== undefined) {
            updateDialogSearchNode(search, state.query, "Search models", state.modelFocus !== "intelligence", state.queryCursor);
            box.add(search);
        }
        const cutoff = state.modelJourney === "switch" && state.tab === "all";
        const scaleLines = cutoff ? intelligenceScaleLines(width, state.intelligenceCutoff ?? "any", state.modelFocus === "intelligence") : [];
        for (const chunks of scaleLines) add(new TextRenderable(renderer, {
            content: new StyledText([...chunks]), width: "100%", height: 1,
        }));
        if (cutoff) add(new TextRenderable(renderer, { content: "", height: 1 }));
        const { priceLines, listed, rows: maxRows, bodyHeight } = layout;
        const split = state.options.length === 0 ? undefined : modelPaneSplit(renderer, state, railInset);
        const rowWidth = split === undefined ? width : split.listWidth - MODEL_LIST_RULE_GAP;
        const rows = journeyWindow(state, maxRows);
        const body = new BoxRenderable(renderer, { width: "100%", flexShrink: 0, flexDirection: "row" });
        const list = new BoxRenderable(renderer, { width: split?.listWidth ?? width, flexShrink: 0, flexDirection: "column" });
        body.add(list);
        add(body);
        const addRow = (node: Renderable) => list.add(node);
        if (rows.length === 0) addRow(new TextRenderable(renderer, {
            content: emptyModelJourney(state),
            fg: TUI_MUTED, height: 2, width: "100%",
        }));
        const prefixWidth = listed ? Math.max(0, ...state.options.map((option) =>
            metaPartsLength(optionMetaPrefixParts(state, { ...option, poolName: undefined }, true)))) : 0;
        const rowNodes = dialogOptionRows(renderer, [
            ...(listed ? [{ label: "", active: false,
                meta: `${" ".repeat(prefixWidth)}${listedFactsHeaderText()}` }] : []),
            ...rows.flatMap(({ option: row, index }) => {
                if (row === undefined) return [];
                const heading = row.section !== undefined;
                return [{
                    label: row.label,
                    active: index === state.selectedIndex,
                    current: row.value === state.initialModel,
                    dimmed: state.modelFocus === "intelligence",

                    meta: heading ? "" : listed ? optionMeta(state, { ...row, poolName: undefined }, true, prefixWidth)
                        : `${row.pricing === undefined ? "price unknown" : "$" + formatListedRates(row.pricing)}  ${state.modelJourney === "shortlist"
                            ? `${row.pooledRank === undefined ? "not kept ✗" : "kept ✓"}  ${row.verificationError ? "failed" : row.unverified === false || row.pooledRank !== undefined && row.unverified !== true ? "verified" : "unverified"}`
                            : row.value === state.initialModel ? "current" : ""}${row.unavailable ? "  not available" : ""}`,
                    ...dialogRowPointer(pointer, index),
                }];
            }),
        ], rowWidth);
        let at = 0;
        if (listed) addRow(rowNodes[at++]!);
        for (const row of rows) {
            addRow(row.heading !== undefined ? dialogGroupHeaderNode(renderer, row.heading, false) : row.option === undefined
                ? new TextRenderable(renderer, { content: "", height: 1 })
                : rowNodes[at++]!);
        }
        body.height = bodyHeight;
        list.height = bodyHeight;
        if (split !== undefined) body.add(modelDetailNode(renderer, state, split.detailWidth, bodyHeight));
        if (priceLines > 0) {
            const selected = state.options[state.selectedIndex];
            const prices = allModelsPriceNode(renderer, selected?.model === undefined ? undefined : selected, width);
            if (priceLines === 1) {
                prices.marginTop = 0;
                prices.marginBottom = 0;
            }
            add(prices);
        }
        if (listed) add(listedFactsFootnoteNode(renderer, width));
        add(dialogFooterNode(renderer, journeyFooter(state)));
        box.height = "auto";
        return;
    }
    const tab = state.kind === "model" ? state.tab ?? "all" : undefined;
    const stripPane = modelStripPane(state);
    const stop = modelStripStop(state);
    const searchable = pickerIsSearchable(state);
    const header = dialogHeaderNode(
        renderer,
        pickerTitle(
            state.kind,
            state.kind === "extension"
                ? state.title
                : stop === "providers"
                ? pickerTitle("model")
                : state.title,
        ),
    );
    box.add(header);
    nodes.push(header);
    let subtitleLines = 0;
    if (state.subtitle !== undefined) {
        const subtitleNode = new TextRenderable(renderer, {
            content: state.subtitle,
            fg: TUI_MUTED,
            width: "100%",
            height: 3,
            marginTop: 1,
            paddingLeft: 1,
        });
        box.add(subtitleNode);
        nodes.push(subtitleNode);
        subtitleLines = 4;
    }
    if (searchable && search !== undefined) {
        updateDialogSearchNode(
            search,
            state.query,
            "Search",
            tab !== "help",
            "queryCursor" in state ? state.queryCursor : undefined,
        );
        box.add(search);
    }
    let tabStripHeight = 0;
    if (stop !== undefined && stripPane !== undefined) {
        const strip = modelTabStripNode(
            renderer,
            stop,
            {
                pool: modelTabRows(
                    stripPane.allOptions,
                    "pool",
                    false,
                    [],
                    stripPane.actionOptions ?? [],
                ).filter((option) => option.action !== true).length,
                all: modelTabRows(stripPane.allOptions, "all").length,
            },
            pickerContentWidth(renderer, state, railInset),
            tab === undefined || tab === "help" ? undefined : modelPaneNote(state),
            onTab,
            onConfigure,
            state.kind !== "model" || (state.pickerLevel ?? "page") === "strip",
        );
        tabStripHeight = strip.height;
        box.add(strip.node);
        nodes.push(strip.node);
    }

    if (tab === "help") {
        const page = modelHelpNode(
            renderer,
            pickerCardWidth(renderer, state, railInset),
            state,
        );
        box.add(page);
        nodes.push(page);
        const footer = dialogFooterNode(
            renderer,
            pickerFooter(state, pickerCardWidth(renderer, state, railInset)),
        );
        box.add(footer);
        nodes.push(footer);
        box.height = "auto";
        return;
    }

    const split = modelPaneSplit(renderer, state, railInset);
    const detailed = split !== undefined;
    // The More page stands in for the list, so the cutoff slider, the facts
    // header and the price card stay off while it is open.
    const stackedPage = split === undefined && state.kind === "model"
        && state.modelFocus === "page";
    let body: BoxRenderable | undefined;
    let listColumn = box;
    if (split !== undefined) {
        body = new BoxRenderable(renderer, {
            width: "100%",
            flexShrink: 0,
            flexDirection: "row",
        });
        listColumn = new BoxRenderable(renderer, {
            width: split.listWidth,
            flexShrink: 0,
            flexDirection: "column",
            paddingRight: MODEL_LIST_RULE_GAP,
        });
        body.add(listColumn);
        box.add(body);
        nodes.push(body);
    }
    const rowWidth = split === undefined
        ? pickerContentWidth(renderer, state, railInset)
        : split.listWidth - MODEL_LIST_RULE_GAP;
    const listAction = modelListAction(state);
    const listActionLines = listAction === undefined ? 0 : 2;
    const pageEntryLines = modelPageEntry(state) === undefined
        ? 0
        : DIALOG_BUTTON_LINES;
    const listedHeaderLines = showsListedFactsHeader(state)
            && state.options.length > 0
            && !stackedPage
        ? 1
        : 0;
    const modelTreePadLines = listedHeaderLines > 0
        ? ALL_MODELS_TREE_PAD_LINES
        : 0;
    const intelligenceLines = showsIntelligenceCutoff(state) && !stackedPage
        ? INTELLIGENCE_SCALE_LINES + ALL_MODELS_SECTION_GAP_LINES
        : 0;
    const allModelsInfoLines = showsAllModelsPrices(state) && !stackedPage
        ? allModelsPriceChromeLines()
        : 0;
    const stackedLines = split === undefined
        ? stackedBelowListLines(state, rowWidth)
        : 0;

    const availableRows = pickerMaxRows(
        renderer,
        tabStripHeight + subtitleLines
            + (verification === undefined
                ? 0
                : verificationConsoleLines(verification))
            + listActionLines
            + 1
            + pageEntryLines
            + listedHeaderLines
            + modelTreePadLines
            + intelligenceLines
            + allModelsInfoLines
            + stackedLines,
    );
    const detailMaxLines = availableRows + listActionLines + pageEntryLines;
    const rows = windowedDisplayRows(
        listDisplayRows(state),
        state.selectedIndex,
        tab === "all"
            ? Math.min(availableRows, MODEL_ALL_MAX_ROWS)
            : availableRows,
    );
    let lines = 0;
    const activityWidth = Math.max(0, ...rows.map((row) =>
        row.kind === "option" ? row.option.activity?.length ?? 0 : 0));
    // A fork is drawn under its parent only while the parent is on the list. Search filters the threaded order without rebuilding it, so a fork whose parent was filtered out would oth…
    const onScreen = new Set(state.options.map((option) => option.sessionId));
    const sharedOnScreen = new Map<string, number>();
    for (const option of state.options) {
        if (option.sharedGroup === undefined) continue;
        sharedOnScreen.set(
            option.sharedGroup,
            (sharedOnScreen.get(option.sharedGroup) ?? 0) + 1,
        );
    }
    let tinted = false;
    const listedHeader = listedHeaderLines > 0 && rows.length > 0;
    const optionRowWidth = listedHeader
        ? Math.max(1, rowWidth - 4)
        : rowWidth;
    const listedPrefixWidth = listedHeader
        ? Math.max(
            0,
            ...rows.flatMap((row) =>
                row.kind === "option"
                    ? [metaPartsLength(
                        optionMetaPrefixParts(state, row.option, detailed),
                    )]
                    : []
            ),
        )
        : 0;
    const optionNodes = dialogOptionRows(renderer, [
        ...(listedHeader
            ? [{
                label: "",
                active: false,
                ...(listedHeader ? { background: TUI_INPUT } : {}),
                meta: [{
                    text: `${" ".repeat(listedPrefixWidth)}${listedFactsHeaderText()}`,
                    tone: "detail" as const,
                }],
            }]
            : []),
        ...rows.flatMap((row) =>
        row.kind === "option"
            ? [{
                label: digitQuickSelect(state)
                        && state.kind !== "settings"
                        && state.query === ""
                        && row.index < 9
                    ? `${row.index + 1}. ${row.option.label}`
                    : row.option.label,
                marker: state.kind === "provider"
                        && row.index === state.selectedIndex
                    ? "›"
                    : optionMarker(state, row.option),
                leading: optionLeading(
                    state,
                    row.option,
                    activityWidth,
                    (row.option.threadParent ?? row.option.forkedFrom)
                            !== undefined
                        && onScreen.has(
                            (row.option.threadParent ?? row.option.forkedFrom)!,
                        ),
                    row.option.sharedGroup !== undefined
                        && sharedOnScreen.get(row.option.sharedGroup) === 2,
                ),
                ...(state.kind === "session"
                    ? { tint: (tinted = !tinted) }
                    : {}),
                // One row of air between the providers a reader picks from and
                // the thing they can do at the end of the list.
                ...(state.kind === "provider" && row.option.action === true
                    ? { spaced: true }
                    : {}),
                // The detail pane carries the prose when there is one.
                ...(state.kind === "model" || state.kind === "session"
                        || detailed
                    ? {}
                    : { description: row.option.description }),
                meta: row.option.rowMeta
                    ?? optionMeta(state, row.option, detailed, listedPrefixWidth),
                card: row.option.card,
                ...(listedHeader ? { background: TUI_INPUT } : {}),
                active: row.index === state.selectedIndex,
                // The list keeps its cursor while another section is being
                // used: the actions there act on this row, and hiding it is
                // what makes an inspector look like it belongs to nothing.
                dimmed: state.kind === "model"
                    && (!sectionHasKeys(state, "list")
                        || state.modelFocus === "list_action"),
                current: row.option.section !== undefined
                    || isCurrentOption(state, row.option),
                ...dialogRowPointer(pointer, row.index),
            }]
            : []
        ),
    ], optionRowWidth);
    const pageEntry = modelPageEntry(state);
    if (pageEntry !== undefined) {
        // Border, padding and the chevron all eat into the label's room.
        const labelWidth = Math.max(1, rowWidth - 6);
        const entry = dialogButtonNode(renderer, {
            label: modelPageEntryLabel(state, labelWidth),
            width: rowWidth,
            focused: sectionHasKeys(state, "more"),
            opens: true,
        });
        attachDialogRowPointer(entry, pointer, -1);
        listColumn.add(entry);
        nodes.push(entry);
        lines += DIALOG_BUTTON_LINES;
    }
    if (stackedPage) {
        const title = new TextRenderable(renderer, {
            content: new StyledText([fg(TUI_MUTED)("More")]),
            width: "100%",
            height: 1,
            marginTop: 1,
        });
        listColumn.add(title);
        nodes.push(title);
        lines += 2;
        const actions = modelPageActions(state);
        const selected = Math.min(
            state.modelPageIndex ?? 0,
            Math.max(0, actions.length - 1),
        );
        actions.forEach((action, index) => {
            const node = new TextRenderable(renderer, {
                content: new StyledText(modelActionLineChunks(
                    { label: action.label, chord: action.description ?? "" },
                    rowWidth,
                    index === selected,
                )),
                width: "100%",
                height: 1,
            });
            attachDialogRowPointer(node, pointer, -2 - index);
            listColumn.add(node);
            nodes.push(node);
            lines += 1;
        });
    }
    if (intelligenceLines > 0) {
        const focused = sectionHasKeys(state, "cutoff");
        const intelligence = new BoxRenderable(renderer, {
            width: rowWidth,
            height: INTELLIGENCE_SCALE_LINES,
            flexShrink: 0,
            flexDirection: "column",
            backgroundColor: TUI_INPUT,
            paddingLeft: 3,
            paddingRight: 1,
            paddingTop: 1,
            paddingBottom: 1,
            marginBottom: ALL_MODELS_SECTION_GAP_LINES,
        });
        for (const chunks of intelligenceScaleLines(
            Math.max(1, rowWidth - 4),
            state.kind === "model" ? state.intelligenceCutoff ?? "any" : "any",
            focused,
        )) {
            const node = new TextRenderable(renderer, {
                content: new StyledText([...chunks]),
                bg: TUI_INPUT,
                width: "100%",
                height: 1,
            });
            intelligence.add(node);
        }
        listColumn.add(intelligence);
        nodes.push(intelligence);
        lines += intelligenceLines;
    }
    if (rows.length === 0 && !stackedPage) {
        const empty = new TextRenderable(renderer, {
            content: `${DIALOG_GUTTER}${emptyPickerMessage(state)}`,
            fg: TUI_MUTED,
            width: "100%",
            height: 1,
        });
        listColumn.add(empty);
        nodes.push(empty);
        lines += 1;
    }
    let optionNodeIndex = listedHeader ? 1 : 0;
    let modelTree = listColumn;
    if (listedHeader) {
        modelTree = new BoxRenderable(renderer, {
            width: rowWidth,
            height: "auto",
            flexShrink: 0,
            flexDirection: "column",
            backgroundColor: TUI_INPUT,
            paddingLeft: 3,
            paddingRight: 1,
            paddingTop: 1,
            paddingBottom: 1,
        });
        listColumn.add(modelTree);
        nodes.push(modelTree);
        lines += ALL_MODELS_TREE_PAD_LINES;
    }
    if (listedHeader) {
        const header = optionNodes[0]!;
        modelTree.add(header);
        nodes.push(header);
        lines += 1;
    }
    (stackedPage ? [] : rows).forEach((row, position) => {
        const node = row.kind === "group"
            ? dialogGroupHeaderNode(renderer, row.label, position > 0)
            : optionNodes[optionNodeIndex++]!;
        lines += row.kind === "group" ? (position > 0 ? 2 : 1)
            : state.kind === "provider" && row.option.action === true ? 2 : 1;
        modelTree.add(node);
        nodes.push(node);
    });
    if (allModelsInfoLines > 0) {
        const prices = allModelsPriceNode(
            renderer,
            allModelsInfoOption(state),
            rowWidth,
        );
        listColumn.add(prices);
        nodes.push(prices);
        const footnote = listedFactsFootnoteNode(renderer, rowWidth);
        listColumn.add(footnote);
        nodes.push(footnote);
        lines += allModelsPriceChromeLines();
    }
    if (listAction !== undefined && !stackedPage) {
        const divider = new TextRenderable(renderer, {
            content: new StyledText([
                fg(TUI_ELEMENT)("─".repeat(rowWidth)),
            ]),
            width: rowWidth,
            height: 1,
        });
        listColumn.add(divider);
        nodes.push(divider);
        const actionWidth = Math.max(1, rowWidth - 2);
        const action = new TextRenderable(renderer, {
            content: new StyledText(modelListActionLineChunks(
                listAction,
                actionWidth,
                state.kind === "model" && state.modelFocus === "list_action",
            )),
            bg: TUI_INPUT,
            width: rowWidth,
            height: 1,
            paddingLeft: 1,
            paddingRight: 1,
        });
        attachDialogRowPointer(action, pointer, state.options.length);
        listColumn.add(action);
        nodes.push(action);
        lines += listActionLines;
    }
    if (split !== undefined && body !== undefined) {
        const detailLines = Math.min(
            modelDetailHeight(state, split.detailWidth),
            detailMaxLines,
        );
        lines = Math.max(lines, detailLines);
        listColumn.height = lines;
        const detail = modelDetailNode(
            renderer,
            state,
            split.detailWidth,
            lines,
            pointer,
        );
        body.add(detail);
        nodes.push(detail);
        body.height = lines;
    }

    if (split === undefined && !stackedPage) {
        const option = state.options[state.selectedIndex];
        for (const chunks of stackedDetailLines(state, option, rowWidth)) {
            const node = new TextRenderable(renderer, {
                content: new StyledText([...chunks]),
                width: "100%",
                height: 1,
            });
            lines += 1;
            listColumn.add(node);
            nodes.push(node);
        }
        const actions = state.kind === "model" && state.tab === "all"
            ? []
            : modelDetailActions(state, option);
        if (actions.length > 0) {
            const title = new TextRenderable(renderer, {
                content: new StyledText([
                    fg(TUI_MUTED)(
                        "Actions".padEnd(Math.max(0, rowWidth - 7)),
                    ),
                    fg(TUI_ACCENT)(
                        state.kind === "model" && state.modelFocus === "detail"
                            ? "← list"
                            : "→ enter",
                    ),
                ]),
                width: "100%",
                height: 1,
                marginTop: 1,
            });
            listColumn.add(title);
            nodes.push(title);
            lines += 2;
            actions.forEach((action, index) => {
                const node = new TextRenderable(renderer, {
                    content: new StyledText(modelActionLineChunks(
                        action,
                        rowWidth,
                        state.kind === "model"
                            && state.modelFocus === "detail"
                            && modelActionCursor(state, actions) === index,
                    )),
                    width: "100%",
                    height: 1,
                });
                attachDialogRowPointer(
                    node,
                    pointer,
                    state.options.length + 1 + index,
                );
                listColumn.add(node);
                nodes.push(node);
                lines += 1;
            });
        }
    }

    const tipLine: TuiPickerTipLine | undefined = typeof tip === "string"
        ? { tone: "tip", text: tip }
        : tip;
    if (tipLine !== undefined && tipLine.text.length > 0 && (state.kind === "extension" || state.verificationTargets === undefined)
        && state.kind !== "model_verification" && state.kind !== "model_defaults") {
        const tipNode = new TextRenderable(renderer, {
            content: new StyledText([
                { text: DIALOG_GUTTER } as TextChunk,
                fg(tipLine.tone === "tip" ? TUI_ACCENT : TUI_DANGER)(
                    `${TIP_LABELS[tipLine.tone]} `,
                ),
                fg(TUI_MUTED)(tipLine.text),
            ]),
            width: "100%",
            height: 1,
            marginTop: 1,
        });
        box.add(tipNode);
        nodes.push(tipNode);
    }

    if (verification !== undefined) {
        const consoleBox = verificationConsoleNode(renderer, verification);
        box.add(consoleBox);
        nodes.push(consoleBox);
    }

    const footer = dialogFooterNode(
        renderer,
        pickerFooter(state, pickerCardWidth(renderer, state, railInset)),
    );
    box.add(footer);
    nodes.push(footer);
    if (state.kind === "model" && teachesSectionRing(state)) {
        const arrows = new TextRenderable(renderer, {
            content: new StyledText([
                fg(TUI_MUTED)(DIALOG_GUTTER),
                ...modelArrowHintChunks(),
            ]),
            width: "100%",
            height: 1,
        });
        box.add(arrows);
        nodes.push(arrows);
    }
    box.height = "auto";
}

export const VERIFICATION_CONSOLE_STEPS = 3;

export type VerificationConsole = NonNullable<TuiSettingsPickerView["verification"]>;

export function verificationConsoleLines(console_: VerificationConsole): number {
    const steps = console_.steps ?? [];
    return 4 + Math.max(1, Math.min(VERIFICATION_CONSOLE_STEPS, steps.length));
}

export function verificationConsoleNode(
    renderer: RenderContext,
    console_: VerificationConsole,
): BoxRenderable {
    const steps = console_.steps ?? [];
    const shown = steps.slice(-VERIFICATION_CONSOLE_STEPS);
    const consoleBox = new BoxRenderable(renderer, {
        width: "100%",
        height: verificationConsoleLines(console_) - 1,
        marginTop: 1,
        flexShrink: 0,
        flexDirection: "column",
        border: false,
        backgroundColor: TUI_INPUT,
        paddingLeft: 1,
        paddingRight: 1,
        paddingTop: 1,
        paddingBottom: 1,
    });
    const line = (chunks: TextChunk[]): void => {
        consoleBox.add(new TextRenderable(renderer, {
            content: new StyledText(chunks),
            bg: TUI_INPUT,
            width: "100%",
            height: 1,
        }));
    };
    line([
        fg(TUI_TEXT)("Verifying "),
        fg(TUI_MUTED)(console_.subject),
    ]);
    if (shown.length === 0) {
        line([
            fg(TUI_ACCENT)("⠋ "),
            fg(TUI_MUTED)("Waiting for provider response"),
        ]);
        return consoleBox;
    }
    for (const step of shown) {
        line(
            step.status === "running"
                ? [fg(TUI_ACCENT)("⠋ "), fg(TUI_MUTED)(step.label)]
                : [
                    fg(TUI_MUTED)("  "),
                    fg(TUI_MUTED)(`${step.label} `),
                    fg(
                        step.status === "failed" ? TUI_DANGER : TUI_SUCCESS,
                    )(VERIFICATION_STEP_MARKS[step.status] ?? "✓"),
                ],
        );
    }
    return consoleBox;
}

export const VERIFICATION_STEP_MARKS: Record<string, string> = {
    passed: "✓",
    failed: "✗",
    skipped: "skipped",
    running: "",
};

export interface PickerHint {
    readonly text: string;
    readonly drop: number;
}

export function clippedToWidth(text: string, width: number): string {
    if (width <= 0 || Bun.stringWidth(text) <= width) return text;
    if (width === 1) return "\u2026";
    const chars = [...text];
    let kept = "";
    for (const char of chars) {
        if (Bun.stringWidth(kept + char) > width - 1) break;
        kept += char;
    }
    return `${kept.trimEnd()}\u2026`;
}

export function fittedHints(hints: readonly PickerHint[], width: number): string {
    const kept = [...hints];
    for (;;) {
        const line = kept.map((hint) => hint.text).join(" · ");
        if (width <= 0 || Bun.stringWidth(line) <= width || kept.length <= 1) {
            return clippedToWidth(line, width);
        }
        let last = 0;
        kept.forEach((hint, index) => {
            if (hint.drop >= kept[last]!.drop) {
                last = index;
            }
        });
        if (kept[last]!.drop === 0) {
            return clippedToWidth(line, width);
        }
        kept.splice(last, 1);
    }
}

export function pickerFooter(
    state: TuiAnySettingsPickerState,
    width = 0,
): string {
    return clippedToWidth(pickerFooterText(state, width), width);
}

export function pickerFooterText(
    state: TuiAnySettingsPickerState,
    width = 0,
): string {
    if (state.kind === "model_verification") return "↑↓ results · esc close (checks continue)";
    if (state.kind !== "extension" && state.verificationTargets !== undefined) return "↵ start · tab coverage · esc";
    if (state.kind === "session") {
        const leavingSomething = state.nothingToLeave !== true;
        return [
            "↑↓ ^d^u move",
            !leavingSomething
                ? "⏎ open"
                : state.enterDisposition === "keep_running"
                ? "⏎ switch"
                : "⏎ stop & switch",
            ...(leavingSomething && state.enterDisposition !== "keep_running"
                ? [tuiKeyHint("background_switch")]
                : []),
            tuiKeyHint("rename_session"),
            tuiKeyHint("trash_session"),
            "esc close",
        ].join(" · ");
    }
    if (state.kind === "extension") {
        const actions = (state.extensionActions ?? []).map((action) =>
            `${extensionPickerKeyLabel(action.key)} ${action.label}`
        );
        return ["↑↓ move", ...actions, "esc close"].join(" · ");
    }
    if (state.kind === "settings") {
        return "↑↓ move · ⏎ open · esc close";
    }
    if (state.kind === "configure") {
        return "↑↓ move · ⏎ edit · esc close";
    }
    if (state.kind === "permission_settings") {
        return "↑↓ move · ⏎ open · esc back";
    }
    if (state.kind === "reasoning" && state.pendingModel !== undefined) {
        return "↑↓ move · ⏎ select · esc back";
    }
    if (state.kind === "provider_actions") {
        return "↑↓ move · ⏎ select · esc back";
    }
    if (state.kind === "provider") {
        const selected = state.options[state.selectedIndex];
        return [
            "↑↓ move",
            selected?.action === true
                ? "⏎ add provider"
                : "⏎ actions",
            ...(selected?.hasCredential === true
                ? [tuiKeyHint("forget_provider")]
                : []),
            ...(selected?.endpointEditable === true
                && selected.declared !== true
                ? [tuiKeyHint("edit_endpoint")]
                : []),
            ...(selected?.action === true
                ? []
                : [tuiKeyHint("declare_provider")]),
            ...(selected?.refreshable === true
                ? [tuiKeyHint("refresh_catalog")]
                : []),
            state.parent === undefined ? "esc close" : "esc back",
        ].join(" · ");
    }
    if (
        state.kind === "model_assignment"
        && state.modelAssignment === "subagents"
    ) {
        const selected = state.options[state.selectedIndex];
        if (selected?.value === MODEL_ASSIGNMENT_BROWSE_VALUE) {
            return "↑↓ move · ⏎ open · esc done";
        }
        if (selected?.value === REVIEWER_CLEAR_VALUE) {
            return "↑↓ move · esc done";
        }
        const action = selected?.value === MODEL_ASSIGNMENT_SELF_VALUE
            ? "p toggle"
            : state.assignedModels?.includes(selected?.value ?? "") === true
            ? "p remove"
            : "p assign";
        return `↑↓ move · ${action} · esc done`;
    }
    if (state.kind === "model" && (state.pickerLevel ?? "page") === "strip") {
        return fittedHints([
            { text: "←→ ⇥ tabs", drop: 0 },
            { text: "↓ list", drop: 0 },
            { text: "type to filter", drop: 1 },
            { text: "esc close", drop: 0 },
        ], width);
    }
    if (
        state.kind === "model"
        && (state.tab === "defaults" || state.tab === "actions")
    ) {
        return fittedHints([
            { text: "\u2191\u2193 move", drop: 0 },
            {
                text: state.tab === "actions" ? "\u23ce run" : "\u23ce change",
                drop: 0,
            },
            { text: "\u21e5 tabs", drop: 1 },
            { text: "esc tabs", drop: 0 },
        ], width);
    }
    if (state.kind === "model" && state.tab === "help") {
        return "⇥ tabs · esc tabs";
    }
    if (state.kind === "model") {
        const selected = state.options[state.selectedIndex];
        if (state.modelFocus === "detail") {
            return fittedHints([
                { text: "↑↓ move", drop: 0 },
                { text: "⏎ run", drop: 0 },
                { text: "← list", drop: 0 },
                { text: "⇥ section", drop: 2 },
                { text: "esc tabs", drop: 0 },
            ], width);
        }
        if (state.modelFocus === "intelligence") {
            return fittedHints([
                { text: "←→ cutoff", drop: 0 },
                { text: "⇥ section", drop: 1 },
                { text: "esc tabs", drop: 0 },
            ], width);
        }
        if (state.modelFocus === "page") {
            return fittedHints([
                { text: "\u2191\u2193 move", drop: 0 },
                { text: "\u23ce run", drop: 0 },
                { text: "\u2190 back", drop: 0 },
                { text: "esc back", drop: 1 },
            ], width);
        }
        if (state.modelFocus === "page_entry") {
            return fittedHints([
                { text: "\u23ce open", drop: 0 },
                { text: "\u21e5 section", drop: 2 },
                { text: "esc tabs", drop: 0 },
            ], width);
        }
        if (state.modelFocus === "list_action") {
            return fittedHints([
                { text: "↑ list", drop: 0 },
                { text: "⏎ run", drop: 0 },
                { text: "⇥ section", drop: 2 },
                { text: "esc tabs", drop: 0 },
            ], width);
        }
        const action = tuiModelActionOfValue(selected?.value ?? "");
        if (action === "shortlist_current") {
            return fittedHints([
                { text: "↑↓ move", drop: 0 },
                { text: "⏎ add", drop: 0 },
                { text: "⇥ tabs", drop: 1 },
                { text: "esc close", drop: 0 },
            ], width);
        }
        const pool = selected === undefined || selected.provider === undefined
            ? undefined
            : isPooled(state, selected)
                ? tuiKeyHint("toggle_pooled").replace("pin", "unpin")
                : tuiKeyHint("toggle_pooled");
        return fittedHints([
            { text: "↑↓ ^d^u move", drop: 0 },
            { text: "⏎ select", drop: 0 },
            ...(pool === undefined ? [] : [{ text: pool, drop: 1 }]),
            ...(state.canUndoPoolChange === true
                ? [{ text: tuiKeyHint("undo_pool_change"), drop: 1 }]
                : []),
            ...(modelOptionCanVerify(state, selected)
                ? [{ text: tuiKeyHint("verify_model"), drop: 2 }]
                : []),

            ...(state.tab === "pool" ? [] : [
                selected?.section === undefined
                    ? { text: "⇧←→ fold all", drop: 5 }
                    : { text: "←→ ⇧←→ fold", drop: 1 },
            ]),
            ...(state.tab !== "pool" && hasFoldedRows(state)
                ? [{
                    text: state.revealAll === true
                        ? tuiKeyHint("reveal_all_models").replace(
                            "show all",
                            "show fewer",
                        )
                        : tuiKeyHint("reveal_all_models"),
                    drop: 4,
                }]
                : []),
            { text: tuiKeyHint("open_providers"), drop: 6 },
            { text: "⇥ section", drop: 3 },
            { text: "esc tabs", drop: 0 },
        ], width);
    }
    return "↑↓ move · ⏎ select · esc close";
}

export function hasFoldedRows(state: TuiSettingsPickerState): boolean {
    return state.allOptions.some((option) =>
        option.hiddenByDefault !== undefined
        && option.pooledRank === undefined
        && option.unavailable !== true
    );
}

export function extensionPickerKeyLabel(
    key: TuiExtensionPickerActionKey,
): string {
    if (key === "enter") return "⏎";
    if (key === "delete") return "del";
    if (key === "backspace") return "⌫";
    return key;
}

export function listDisplayRows(
    state: TuiAnySettingsPickerState,
): readonly PickerDisplayRow[] {
    const grouped = state.kind === "provider"
        || state.kind === "configure"
        || (state.kind === "model" && state.tab === "defaults")
        || (state.kind === "model_assignment"
            && state.modelAssignment === "subagents");
    const rows: PickerDisplayRow[] = [];
    state.options.forEach((option, index) => {
        if (
            grouped
            && option.action !== true
            && groupLabel(state.options[index - 1]) !== groupLabel(option)
        ) {
            rows.push({ kind: "group", label: groupLabel(option) ?? "Other" });
        }
        rows.push({ kind: "option", option, index });
    });
    return rows;
}

export function groupLabel(
    option: TuiSettingsPickerOption | undefined,
): string | undefined {
    return option?.group ?? option?.provider;
}

export function windowedDisplayRows(
    rows: readonly PickerDisplayRow[],
    selectedIndex: number,
    maxRows: number,
): readonly PickerDisplayRow[] {
    const cursor = rows.findIndex((row) =>
        row.kind === "option" && row.index === selectedIndex
    );
    const window = listWindowSlice(rows, cursor, maxRows);
    if (window.length === rows.length) {
        return rows;
    }
    const start = rows.indexOf(window[0]!);
    const stuck = stickyGroupRow(rows, start);
    if (stuck === undefined) {
        return window;
    }
    const cursorAtEnd = window.at(-1)?.kind === "option"
        && (window.at(-1) as { readonly index: number }).index === selectedIndex;
    return cursorAtEnd
        ? [stuck, ...window.slice(1)]
        : [stuck, ...window.slice(0, -1)];
}

export function isHeadingRow(row: PickerDisplayRow | undefined): boolean {
    return row !== undefined
        && (row.kind === "group" || row.option.section !== undefined);
}

export function stickyGroupRow(
    rows: readonly PickerDisplayRow[],
    start: number,
): PickerDisplayRow | undefined {
    if (start === 0 || isHeadingRow(rows[start])) {
        return undefined;
    }
    for (let index = start - 1; index >= 0; index -= 1) {
        const row = rows[index]!;
        if (isHeadingRow(row)) {
            return row;
        }
    }
    return undefined;
}

export function isCurrentOption(
    state: TuiAnySettingsPickerState,
    option: TuiSettingsPickerOption,
): boolean {
    if (state.kind === "extension") {
        return option.current === true;
    }
    if (state.kind === "provider") return false;
    if (state.kind === "session") {
        return option.current === true;
    }
    return state.kind === "model" && option.value === state.initialModel;
}

export function digitQuickSelect(state: TuiAnySettingsPickerState): boolean {
    return state.kind === "reasoning"
        || state.kind === "permissions"
        || state.kind === "settings"
        || state.kind === "permission_settings";
}

export function optionMarker(
    state: TuiAnySettingsPickerState,
    option: TuiSettingsPickerOption,
): string | undefined {
    if (option.section !== undefined) {
        return option.sectionCollapsed === true ? "▶" : "▼";
    }
    if (state.kind === "provider") {
        return undefined;
    }
    if (option.action === true) {
        return "+";
    }
    return isCurrentOption(state, option) ? "●" : undefined;
}

export function optionLeading(
    state: TuiAnySettingsPickerState,
    option: TuiSettingsPickerOption,
    activityWidth = 0,
    threaded = false,
    shared = false,
): string {
    if (option.section !== undefined || state.kind === "provider") {
        return "";
    }
    if (state.kind !== "session") {
        return "";
    }
    const depth = threaded ? option.depth ?? 0 : 0;
    const thread = shared && option.sharedEdge !== undefined
        ? `${option.sharedEdge === "start" ? "┌" : "└"} `
        : depth === 0 ? "" : `${"  ".repeat(depth - 1)}└ `;
    return `${thread}${(option.activity ?? "").padEnd(activityWidth)}  `;
}

export function emptyPickerMessage(state: TuiAnySettingsPickerState): string {
    if (state.kind === "extension") {
        return "No options available";
    }
    if (
        state.kind === "model"
        && (state.tab === "pool" || state.tab === "all")
    ) {
        return modelEmptyMessage(state);
    }
    if (state.kind === "model_assignment") {
        return "No shortlisted models. Add one to the shortlist to assign it here.";
    }
    if (state.kind !== "session") {
        return "No matches found";
    }
    return state.loading === true
        ? "Loading conversations…"
        : "No conversations found";
}

export const THEME_LABEL_WIDTH = 17;

export function renderThemePickerRows(
    renderer: RenderContext,
    box: BoxRenderable,
    state: TuiSettingsPickerState,
    nodes: Renderable[],
    search: ReturnType<typeof createDialogSearchNode>,
    pointer?: DialogRowPointer,
): void {
    const header = dialogHeaderNode(renderer, "Theme");
    updateDialogSearchNode(
        search,
        state.query,
        "Search",
        true,
        state.queryCursor,
    );
    box.add(header);
    box.add(search);
    nodes.push(header);

    const matches = new Set(state.options.map((option) => option.value));
    const selectableIndex = new Map(
        state.options.map((option, index) => [option.value, index]),
    );
    state.allOptions.forEach((option) => {
        const active = option.value === state.options[state.selectedIndex]?.value;
        const current = option.value === state.initialTheme;
        const matched = matches.has(option.value);
        const row = new TextRenderable(renderer, {
            content: themeRowContent(option, active, current, matched),
            bg: active && TUI_CHROME !== "plain" ? TUI_ACCENT
                : active ? TUI_ELEMENT : TUI_PANEL,
            width: "100%",
            height: 1,
            paddingRight: 1,
        });
        const index = selectableIndex.get(option.value);
        if (index !== undefined) {
            attachDialogRowPointer(row, pointer, index);
        }
        box.add(row);
        nodes.push(row);
    });

    const footer = dialogFooterNode(renderer, "↑↓ move · ⏎ apply · esc cancel");
    box.add(footer);
    nodes.push(footer);
}

export function themeRowContent(
    option: TuiSettingsPickerOption,
    active: boolean,
    current: boolean,
    matched: boolean,
): StyledText {
    const selectedColor = active && TUI_CHROME !== "plain"
        ? TUI_SELECTION_TEXT
        : TUI_ACCENT;
    const labelColor = matched
        ? (active || current ? selectedColor : TUI_TEXT)
        : TUI_MUTED;
    const chunks: TextChunk[] = [
        active ? fg(selectedColor)("› ") : fg(TUI_PANEL)("  "),
        fg(active ? selectedColor : TUI_ACCENT)(current ? "● " : "  "),
        fg(labelColor)(option.label.padEnd(THEME_LABEL_WIDTH)),
        ...themeSwatchChunks(option.value as TuiThemeName, matched),
        fg(active && TUI_CHROME !== "plain"
            ? TUI_SELECTION_TEXT
            : matched ? TUI_MUTED : TUI_PANEL)(`  ${option.description}`),
    ];
    return new StyledText(chunks);
}

export function themeSwatchChunks(name: TuiThemeName, matched: boolean): TextChunk[] {
    const swatch = tuiThemeSwatch(name);
    if (swatch === undefined) {
        return [fg(TUI_MUTED)("░░ ░░ ░░ ░░")];
    }
    return swatch.flatMap((color, index) => [
        ...(index === 0 ? [] : [fg(TUI_PANEL)(" ")]),
        fg(matched ? color : TUI_MUTED)("██"),
    ]);
}

export function pickerTitle(
    kind: TuiSettingsPickerKind | "extension",
    title?: string,
): string {
    if (title !== undefined) return title;
    return kind === "model"
        ? "Select model"
        : kind === "provider"
        ? "Connect a provider"
        : kind === "reasoning"
            ? "Reasoning"
            : kind === "permissions"
                ? "Permission mode"
                : kind === "session"
                    ? "Resume"
                    : kind === "settings"
                        ? "Settings"
                        : kind === "configure"
                            ? "Configure"
                        : kind === "permission_settings"
                            ? "Permissions"
                            : kind === "reviewer_settings"
                                ? "Classifier"
                                : kind === "reviewer"
                                    ? "Select classifier"
                                    : kind === "model_assignment"
                                        ? "Assign a model"
                                        : "Theme";
}
