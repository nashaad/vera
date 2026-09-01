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
    DeveloperSettings,
    DeveloperSettingsPatch,
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
import { APP_PADDING_BOTTOM, APP_PADDING_TOP, DIALOG_CARD_Z_INDEX, DIALOG_CARD_PADDING, DIALOG_CHROME_HEIGHT, DIALOG_GUTTER, dialogFooterNode, dialogGroupHeaderNode, dialogHeaderNode, dialogInsetBottomOffset, dialogInsetTop, attachDialogRowPointer, dialogOptionRows, dialogRowPointer, type DialogRowPointer, createDialogSearchNode, updateDialogSearchNode, registerDialogCard } from "./dialog-chrome.ts";
import { tuiThemeSwatch, type TuiThemeName } from "./theme.ts";
import {
    tuiThemeProperties,
    type TuiThemeBinding,
} from "./theme-bindings.ts";
import { tuiBindingId, tuiKeyHint } from "./keymap.ts";
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
    type TuiSettingsPickerKey,
    type TuiSettingsPickerKind,
    type TuiSettingsPickerOption,
    type TuiSettingsPickerState,
    type TuiSettingsPickerTransition,
    type TuiSettingsPickerView,
    tuiModelActionOfValue,
} from "./settings-picker-types.ts";

import {
    INTELLIGENCE_SCALE_LINES,
    MODEL_ALL_MAX_ROWS,
    MODEL_ARROW_HINT,
    MODEL_LIST_RULE_GAP,
    allModelsInfoOption,
    allModelsPriceChromeLines,
    allModelsPriceNode,
    enclosingSection,
    intelligenceScaleLines,
    isPooled,
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
    // Ahead of the modifier bail-out below, and deliberately a modifier key:
    // the model pane sends every bare printable key to its search box, and "-"
    // is a character in most model ids, so no unmodified key is available.
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
    // A name belongs to a pool entry, so the key does nothing on a row the
    // user has not pooled.
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
    // Order belongs to the pool, so like a name this does nothing on a row the
    // user has not pooled. Order is not decoration: the failsafe rung walks
    // the pool in this order too.
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
    // A refresh spends no model call and cannot change a setting, so unlike
    // the probe keys below it asks nothing first: the only question it could
    // ask is which provider, and the cursor has already answered that.
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
    // The sweep asks how much of the collection it covers before it spends
    // anything, so the key is safe to press to find out what it would do.
    if (
        state.kind === "model"
        && tuiBindingId("model_picker", key) === "verify_pool"
    ) {
        return { state, handled: true, poolVerifySweep: true };
    }
    // Verification is on demand and never on the way in: adding a model is
    // instant, and this is the key that spends probe calls deliberately.
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
    // The fold is a default, not a filter: this key is the whole reason the
    // list can open short without the short list claiming the other models do
    // not exist. It only ever adds rows, so it never needs an undo.
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
    // Also ahead of the modifier bail-out, and modified for the same reason as
    // ctrl+s above: every bare key on the model pane belongs to its search box.
    if (
        state.kind === "model"
        && tuiBindingId("model_picker", key) === "open_providers"
    ) {
        return { state, handled: true, openProviders: true };
    }
    // Tab walks right across the strip and Shift+Tab walks left. The model
    // pane's scoped binding overrides the global quickslot chord while open.
    if (
        state.kind === "model"
        && tuiBindingId("model_picker", key) === "switch_tab"
    ) {
        const cycle: readonly TuiModelPickerTab[] = [
            "pool",
            "all",
            "actions",
            "defaults",
            "help",
        ];
        const at = cycle.indexOf(state.tab ?? "all");
        if (key.shift === true) {
            if (at === 0) {
                return {
                    state: switchedModelTab(state, cycle.at(-1)!),
                    handled: true,
                    openProviders: true,
                };
            }
            return {
                state: switchedModelTab(state, cycle[at - 1] ?? cycle.at(-1)!),
                handled: true,
            };
        }
        // Providers is the last stop, and it swaps what the card lists rather
        // than what the model list shows, so the list under it wraps to the
        // first tab. Both ways out of that pane then land on the start of the
        // strip; parking the list on Help would send the next ⇥ straight back
        // into the pane the user just left.
        if (at === cycle.length - 1) {
            return {
                state: switchedModelTab(state, cycle[0]!),
                handled: true,
                openProviders: true,
            };
        }
        return {
            state: switchedModelTab(state, cycle[at + 1] ?? cycle[0]!),
            handled: true,
        };
    }
    // ⇥ off the connect pane and back onto the collections. It resumes the pane
    // that opened it rather than a fixed tab: arriving by ^e from All models
    // and leaving by ⇥ should not silently move the list somewhere else.
    if (
        state.kind === "provider"
        && state.parent?.kind === "model"
        && tuiBindingId("model_picker", key) === "switch_tab"
    ) {
        return {
            state: key.shift === true
                ? switchedModelTab(state.parent, "help")
                : state.parent,
            handled: true,
        };
    }
    // Ahead of the modifier bail-out below, because the chord carries shift.
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
    // Forgetting is a fact about the store, so the pane only names the row and
    // the caller decides whether there is anything there to forget.
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
        // Escape here has a level to give back, so it does that rather than
        // closing the dialog from under a view the user opened on purpose.
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
        if (key.name === "escape") {
            return {
                state: { ...state, modelFocus: "list", selectedIndex: 0 },
                handled: true,
            };
        }
        if (key.name === "down") {
            return {
                state: {
                    ...state,
                    modelFocus: showsIntelligenceCutoff(state)
                        ? "intelligence"
                        : "list",
                    selectedIndex: 0,
                },
                handled: true,
            };
        }
        if (key.name === "up" || key.name === "left") {
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
        if (key.name === "down") {
            return {
                state: { ...state, modelFocus: "list" },
                handled: true,
            };
        }
        if (key.name === "up") {
            return modelPageEntry(state) === undefined
                ? unchanged(state, true)
                : {
                    state: { ...state, modelFocus: "page_entry" },
                    handled: true,
                };
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
    // Fold and unfold everything, ahead of the modifier bail-out below because
    // both chords carry shift. Either one replaces whatever mix of open and
    // closed sections the user had: it is one answer to "show me less" or
    // "show me all of it", not an edit to each section in turn.
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
    // Half-page movement, ahead of the modifier bail-out below. The cursor
    // travels with the jump rather than the window sliding out from under it,
    // so ctrl+d is ↓ held down and nothing new has to be learned about where
    // the highlight went.
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
    if (key.name === "escape") {
        // Leaving a theme pane puts back the theme the user came in with,
        // whether that lands them in the parent menu or out of the pane.
        const preview = state.kind === "theme" && state.initialTheme !== undefined
            ? { previewTheme: state.initialTheme }
            : {};
        // Escape inside a pane opened from another one steps back rather than
        // closing outright, so a wrong turn costs one key instead of reopening
        // whatever led there.
        if (state.parent !== undefined) {
            return { state: state.parent, handled: true, ...preview };
        }
        return { handled: true, ...preview };
    }
    // Digits pick the numbered row directly on the short panes. Only while
    // the search is empty: a query that contains a digit is still a search.
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
    // This short policy list reserves bare p for assignment. It has no search
    // field, so every other printable key is swallowed instead of building an
    // invisible query and moving the cursor away from the row just toggled.
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
    // Left and right open and close a section, the shape a tree has everywhere
    // else. On a row inside a section they act on the heading above it, so
    // closing a long provider does not first mean scrolling back up to it.
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
        if (
            state.kind === "model"
            && state.selectedIndex === 0
            && (state.modelFocus ?? "list") === "list"
            && showsIntelligenceCutoff(state)
        ) {
            return {
                state: { ...state, modelFocus: "intelligence" },
                handled: true,
            };
        }
        if (
            state.kind === "model"
            && state.selectedIndex === 0
            && (state.modelFocus ?? "list") === "list"
            && modelPageEntry(state) !== undefined
        ) {
            return {
                state: { ...state, modelFocus: "page_entry" },
                handled: true,
            };
        }
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
        // The same request ctrl+shift+n makes, from a row anyone can see.
        if (state.kind === "provider" && selected.action === true) {
            return { state, handled: true, declareProvider: true };
        }
        // A declared row carries an endpoint the user wrote, so opening it
        // means opening what they wrote. The form's key field covers the
        // credential, which is the only thing a shipped row has to offer.
        if (state.kind === "provider" && selected.declared === true) {
            return { state, handled: true, editProvider: selected.value };
        }
        // The session's model is shown on the Slots tab but is not changed
        // there: choosing it moves to the list that does change it, which is
        // the same list every other way in reaches.
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

/**
 * The wheel over an open pane.
 *
 * It moves the cursor rather than sliding the window under it, which is the
 * same rule ctrl+d and ctrl+u follow: the pane windows itself around
 * `selectedIndex`, so a window that moved on its own would leave ⏎ pointing at
 * a row that is no longer on screen.
 */
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

/** Apply text already edited by the native search field to the active pane. */
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
        // No borderColor here. OpenTUI's BoxRenderable constructor reads any
        // border styling option as "this box wants a border" and overrides an
        // explicit `border: false`, so passing a color is what draws the box.
        border: false,
        backgroundColor: TUI_PANEL,
        position: "absolute",
        top: dialogInsetTop(renderer),
        left: "10%",
        width: "80%",
        height: 8,
        zIndex: DIALOG_CARD_Z_INDEX,
        paddingLeft: DIALOG_CARD_PADDING,
        paddingRight: DIALOG_CARD_PADDING,
        paddingTop: 2,
        paddingBottom: 1,
        focusable: true,
        visible: false,
    });
    registerDialogCard(box);

    const view: TuiSettingsPickerView = {
        box,
        focus(): void {
            if (searchLive) search.focus();
            else box.focus();
        },
        handleEditorKey(state, key): TuiSettingsPickerTransition {
            if (
                !pickerIsSearchable(state)
                || (state.kind === "model" && state.tab === "help")
                || key.name === "escape" || key.name === "up"
                || key.name === "down" || key.name === "return"
                || key.name === "enter" || key.name === "kpenter"
                || tuiBindingId("picker", key) !== undefined
                || (state.kind === "model"
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
                && !(state.kind === "model" && state.tab === "help");
            box.title = undefined;
            if (state.kind === "theme") {
                box.paddingTop = 2;
                box.paddingBottom = 1;
                box.top = themePickerTop(renderer, state.allOptions.length);
                box.left = "20%";
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
            // A session is recognised by its title, and titles are the one row
            // value with no natural length, so this list gets the whole
            // terminal rather than the inset card the settings panes use. It
            // starts at the top edge too: an inset card is read against the
            // scrimmed transcript around it, but a full-width panel with a
            // strip of transcript over it reads as a row that leaked through.
            box.top = state.kind === "session" ? 0 : dialogInsetTop(renderer);
            box.left = state.kind === "session" ? 0 : "10%";
            box.width = state.kind === "session" ? "100%" : "80%";
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

/**
 * Half-page distance when nobody measured the window. Only callers that have no
 * renderer land here, which today is tests: the TUI always measures.
 */
export const FALLBACK_JUMP = 5;

/**
 * How many rows the card can show without running off the bottom.
 *
 * Group headers cost more than one line, so this is a row budget rather than a
 * line budget and a heavily grouped list can still overrun by a line or two.
 * The alternative is a window whose size changes as you scroll past headers,
 * which is worse to use than an occasional tight fit.
 */
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

// Header, search block, footer with its blank line, and the card's vertical
// padding (or padding plus border on the retro chromes, which add up to the
// same three lines). The theme list never windows, so the card's height is a
// straight function of how many themes it offers.
export const THEME_CARD_CHROME_LINES = 9;

/**
 * Where the theme card starts: the shared picker offset, pulled up only as far
 * as needed for the whole list to fit above the bottom padding row. One
 * formula for every chrome, so the card does not jump when the theme under the
 * cursor changes the chrome out from beneath it.
 */
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

/**
 * How far the half-page keys move, which is half of what is currently on
 * screen. The key handler is a pure function of state and cannot see the
 * terminal, so whoever owns the renderer measures this and passes it in: a
 * second constant here would be free to disagree with the window the user is
 * actually looking at.
 */
export function tuiPickerViewportRows(
    renderer: RenderContext,
    state: TuiAnySettingsPickerState,
    extraChrome = 0,
): number {
    const stripHeight = modelStripStop(state) === undefined
        ? 0
        : modelTabStripHeight(pickerContentWidth(renderer, state));
    const listedHeaderLines = showsListedFactsHeader(state)
            && state.options.length > 0
        ? 1
        : 0;
    const intelligenceLines = showsIntelligenceCutoff(state)
        ? INTELLIGENCE_SCALE_LINES
        : 0;
    const allModelsInfoLines = showsAllModelsPrices(state)
        ? allModelsPriceChromeLines()
        : 0;
    const rows = pickerMaxRows(
        renderer,
        stripHeight
            + (state.kind === "extension" && state.subtitle !== undefined ? 1 : 0)
            + listedHeaderLines
            + intelligenceLines
            + allModelsInfoLines
            + extraChrome,
    );
    return state.kind === "model" && state.tab === "all"
        ? Math.min(rows, MODEL_ALL_MAX_ROWS)
        : rows;
}

export type PickerDisplayRow =
    | { readonly kind: "group"; readonly label: string }
    | {
        readonly kind: "option";
        readonly option: TuiSettingsPickerOption;
        readonly index: number;
    };

export function renderListPickerRows(
    renderer: RenderContext,
    box: BoxRenderable,
    state: TuiAnySettingsPickerState,
    nodes: Renderable[],
    pointer?: DialogRowPointer,
    tip?: string,
    verification?: { readonly subject: string },
    onTab?: (tab: TuiModelPickerTab) => void,
    onConfigure?: () => void,
    search?: ReturnType<typeof createDialogSearchNode>,
    railInset = 0,
): void {
    const tab = state.kind === "model" ? state.tab ?? "all" : undefined;
    const stripPane = modelStripPane(state);
    const stop = modelStripStop(state);
    // The help page keeps the field so that tabbing onto it does not lift the
    // tabs and everything under them by three lines. It draws inert, without
    // the caret, since this page holds nothing to filter.
    // A pane whose whole list is two fixed answers has nothing to filter, and
    // an empty field above them reads as a row the cursor has landed on.
    const searchable = pickerIsSearchable(state);
    const header = dialogHeaderNode(
        renderer,
        pickerTitle(
            state.kind,
            state.kind === "extension"
                ? state.title
                // The connect pane keeps the model pane's name while it draws
                // inside it: one card that changes what it lists, not two.
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
        // A blank line above and below separates this standing explanation
        // from both the title and the rows. Count its margin as well as its
        // two wrapped text lines and trailing blank when sizing the list.
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

    // The list and the facts about the highlighted row sit side by side, so the
    // rows go into a column of their own rather than straight onto the card.
    const split = modelPaneSplit(renderer, state, railInset);
    const detailed = split !== undefined;
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
            // The rows hold off the rule, so a right-aligned mark on one of
            // them does not touch it.
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
    const pageEntryLines = modelPageEntry(state) === undefined ? 0 : 2;
    const listedHeaderLines = showsListedFactsHeader(state)
            && state.options.length > 0
        ? 1
        : 0;
    const intelligenceLines = showsIntelligenceCutoff(state)
        ? INTELLIGENCE_SCALE_LINES
        : 0;
    const allModelsInfoLines = showsAllModelsPrices(state)
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
    // The activity column is padded to the widest value on screen, so the
    // titles beside it start on one column even though "just now" and "3d ago"
    // do not measure the same.
    const activityWidth = Math.max(0, ...rows.map((row) =>
        row.kind === "option" ? row.option.activity?.length ?? 0 : 0));
    // A fork is drawn under its parent only while the parent is on the list.
    // Search filters the threaded order without rebuilding it, so a fork whose
    // parent was filtered out would otherwise appear to hang off whichever
    // unrelated row the search left above it.
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
                // Model and session rows carry no description. A model's
                // marketing line is not what anyone picks on, and at these
                // widths it only ever arrived clipped to a few characters; a
                // session's facts are its own columns.
                ...(state.kind === "model" || state.kind === "session"
                    ? {}
                    : { description: row.option.description }),
                // With the pane beside it, a row keeps only what tells it apart
                // from its neighbours. Everything else is one cursor move away.
                meta: row.option.rowMeta
                    ?? optionMeta(state, row.option, detailed, listedPrefixWidth),
                card: row.option.card,
                active: row.index === state.selectedIndex
                    && (state.kind !== "model"
                        || (state.modelFocus ?? "list") === "list"),
                current: row.option.section !== undefined
                    || isCurrentOption(state, row.option),
                ...dialogRowPointer(pointer, row.index),
            }]
            : []
        ),
    ], rowWidth);
    // With no second column the page has nowhere to sit beside the list, so it
    // takes the list's place the way it takes the inspector's when there is one.
    const stackedPage = split === undefined && state.kind === "model"
        && state.modelFocus === "page";
    const pageEntry = modelPageEntry(state);
    if (pageEntry !== undefined) {
        const entry = new TextRenderable(renderer, {
            content: new StyledText(modelListActionLineChunks(
                {
                    ...pageEntry,
                    label: modelPageEntryLabel(state, rowWidth),
                },
                rowWidth,
                state.kind === "model"
                    && (state.modelFocus === "page_entry"
                        || state.modelFocus === "page"),
            )),
            width: rowWidth,
            height: 1,
        });
        attachDialogRowPointer(entry, pointer, -1);
        listColumn.add(entry);
        nodes.push(entry);
        const rule = new TextRenderable(renderer, {
            content: new StyledText([fg(TUI_ELEMENT)("\u2500".repeat(rowWidth))]),
            width: rowWidth,
            height: 1,
        });
        listColumn.add(rule);
        nodes.push(rule);
        lines += 2;
    }
    if (intelligenceLines > 0) {
        const focused = state.kind === "model"
            && state.modelFocus === "intelligence";
        for (const chunks of intelligenceScaleLines(
            rowWidth,
            state.kind === "model" ? state.intelligenceCutoff ?? "any" : "any",
            focused,
        )) {
            const node = new TextRenderable(renderer, {
                content: new StyledText([...chunks]),
                width: rowWidth,
                height: 1,
            });
            listColumn.add(node);
            nodes.push(node);
            lines += 1;
        }
        const prices = allModelsPriceNode(
            renderer,
            allModelsInfoOption(state),
            rowWidth,
        );
        listColumn.add(prices);
        nodes.push(prices);
        lines += allModelsPriceChromeLines();
    }
    if (rows.length === 0) {
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
    if (listedHeader) {
        const header = optionNodes[0]!;
        listColumn.add(header);
        nodes.push(header);
        lines += 1;
    }
    (stackedPage ? [] : rows).forEach((row, position) => {
        const node = row.kind === "group"
            ? dialogGroupHeaderNode(renderer, row.label, position > 0)
            : optionNodes[optionNodeIndex++]!;
        lines += row.kind === "group" ? (position > 0 ? 2 : 1) : 1;
        listColumn.add(node);
        nodes.push(node);
    });
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
        const action = new TextRenderable(renderer, {
            content: new StyledText(modelListActionLineChunks(
                listAction,
                rowWidth,
                state.kind === "model" && state.modelFocus === "list_action",
            )),
            width: rowWidth,
            height: 1,
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

    // The same block the column would have carried, under the list instead of
    // beside it. The pane keeps what it says at every width and gives up only
    // the second column, which is what the terminal actually ran out of.
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
    } else if (split === undefined) {
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

    // Above the hints, below the rows: the tip is about the pane, so it sits
    // with the pane's other standing text rather than floating over the list.
    if (tip !== undefined && tip.length > 0) {
        const tipNode = new TextRenderable(renderer, {
            content: new StyledText([
                { text: DIALOG_GUTTER } as TextChunk,
                fg(TUI_ACCENT)("Tip "),
                fg(TUI_MUTED)(tip),
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
    if (state.kind === "model") {
        // The chords above are a legend, and a legend is easy to read past.
        // This line says the thing in words instead.
        const arrows = new TextRenderable(renderer, {
            content: `${DIALOG_GUTTER}${MODEL_ARROW_HINT}`,
            fg: TUI_MUTED,
            width: "100%",
            height: 1,
        });
        box.add(arrows);
        nodes.push(arrows);
    }
    box.height = "auto";
}

/** At most this many checks are kept on screen, newest last. */
export const VERIFICATION_CONSOLE_STEPS = 3;

export type VerificationConsole = NonNullable<TuiSettingsPickerView["verification"]>;

/** What the console occupies: the subject line and the checks under it. */
export function verificationConsoleLines(console_: VerificationConsole): number {
    const steps = console_.steps ?? [];
    // The margin above, a padded row on each side of the block, the subject
    // line, and one line per check it is showing.
    return 4 + Math.max(1, Math.min(VERIFICATION_CONSOLE_STEPS, steps.length));
}

/**
 * The live provider check, as a short list of what has happened.
 *
 * One line names what is being checked and stays put; under it each check
 * reports itself once it is done, and the one still running carries the
 * spinner. Nothing is repeated, so the block says only what has changed.
 */
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

/** Each ending a check can have, spelled out for a terminal without colour. */
export const VERIFICATION_STEP_MARKS: Record<string, string> = {
    passed: "✓",
    failed: "✗",
    skipped: "skipped",
    running: "",
};

/**
 * One hint per entry, in reading order, each with the order it is dropped in
 * when the row will not fit: 0 is kept longest. A hint that wrapped would split
 * a chord from its label, so the row sheds whole hints instead.
 */
export interface PickerHint {
    readonly text: string;
    readonly drop: number;
}

/**
 * The text cut to the room there is for it, with an ellipsis where it was cut.
 * A footer line that overflows its card wraps onto the padding line under it,
 * so the pane loses its bottom margin rather than the sentence losing a word.
 */
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

/**
 * The hint line, never wider than the card it sits in. A line that overflows
 * wraps onto the blank line under it and the pane loses its bottom padding, so
 * a branch that cannot shed a hint has its line cut instead.
 */
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
    if (state.kind === "session") {
        // With nothing on screen to leave, opening a row in the background
        // and opening it are the same act, so only one of them is offered.
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
    if (state.kind === "provider") {
        const selected = state.options[state.selectedIndex];
        return [
            "↑↓ move",
            selected?.action === true
                ? "⏎ declare"
                : selected?.declared === true
                ? "⏎ edit"
                : selected?.connected === true
                ? "⏎ reconnect"
                : "⏎ connect",
            ...(selected?.connected === true
                ? [tuiKeyHint("forget_provider")]
                : []),
            // The chord and ⏎ are the same action, so the row that already
            // offers it on ⏎ does not advertise it twice.
            // The chord and ⏎ are the same action on a declared row, which
            // already says "⏎ edit", so only a shipped row advertises it.
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
            ...(state.parent?.kind === "model" ? ["⇥ tabs"] : []),
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
    // The Defaults tab's rows are jobs, and a two-word state cell cannot say
    // what to do about one, so the cursor's row explains itself down here.
    // The Defaults tab's rows explain themselves in the column beside the
    // list, so the footer stays keys.
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
            { text: "esc close", drop: 0 },
        ], width);
    }
    if (state.kind === "model" && state.tab === "help") {
        return "⇥ tabs · esc close";
    }
    if (state.kind === "model") {
        const selected = state.options[state.selectedIndex];
        if (state.modelFocus === "detail") {
            return fittedHints([
                { text: "↑↓ move", drop: 0 },
                { text: "⏎ run", drop: 0 },
                { text: "← list", drop: 0 },
                { text: "⇥ tabs", drop: 2 },
                { text: "esc close", drop: 0 },
            ], width);
        }
        if (state.modelFocus === "intelligence") {
            return fittedHints([
                { text: "←→ cutoff", drop: 0 },
                { text: "↓ list", drop: 0 },
                { text: "⇥ tabs", drop: 1 },
                { text: "esc close", drop: 0 },
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
                { text: "\u2193 list", drop: 0 },
                { text: "\u2192 open", drop: 0 },
                { text: "\u21e5 tabs", drop: 2 },
                { text: "esc close", drop: 0 },
            ], width);
        }
        if (state.modelFocus === "list_action") {
            return fittedHints([
                { text: "↑ list", drop: 0 },
                { text: "⏎ run", drop: 0 },
                ...(modelDetailActions(state, selected).length === 0
                    ? []
                    : [{ text: "→ actions", drop: 1 }]),
                { text: "⇥ tabs", drop: 2 },
                { text: "esc close", drop: 0 },
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
                // Removal is the same key saying the opposite thing, which is
                // the one hint the table cannot hold for us.
                ? tuiKeyHint("toggle_pooled").replace("pin", "unpin")
                : tuiKeyHint("toggle_pooled");
        return fittedHints([
            // The movement entry carries the half-page keys rather than taking
            // a separate assignment: they are the same movement, and this footer is
            // already the longest one in the pane.
            { text: "↑↓ ^d^u move", drop: 0 },
            { text: "⏎ select", drop: 0 },
            ...(pool === undefined ? [] : [{ text: pool, drop: 1 }]),
            ...(state.canUndoPoolChange === true
                ? [{ text: tuiKeyHint("undo_pool_change"), drop: 1 }]
                : []),
            ...(modelOptionCanVerify(state, selected)
                ? [{ text: tuiKeyHint("verify_model"), drop: 2 }]
                : []),
            ...(modelDetailActions(state, selected).length === 0
                ? []
                : [{ text: "→ actions", drop: 2 }]),
            // Only while the cursor is on a heading: the keys do nothing on a
            // model row, and a hint for them there would be a lie.
            // The whole-list keys are worth a slot behind the row's own keys;
            // on a heading, where ← and → do something too, the entry moves up
            // because folding is then what the highlighted row is for.
            // The shortlist never groups, so folding keys would name something
            // that is not on screen.
            ...(state.tab === "pool" ? [] : [
                selected?.section === undefined
                    ? { text: "⇧←→ fold all", drop: 5 }
                    : { text: "←→ ⇧←→ fold", drop: 1 },
            ]),
            // Only where there is something folded to reveal, and it names the
            // direction the key would take you rather than the state you are
            // in, so the hint stays an instruction on both passes.
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
            // Sheds early, because the strip's own chip carries this chord and
            // is on screen whatever the footer had room for.
            { text: tuiKeyHint("open_providers"), drop: 6 },
            { text: "⇥ tabs", drop: 3 },
            { text: "esc close", drop: 0 },
        ], width);
    }
    return "↑↓ move · ⏎ select · esc close";
}

/**
 * Whether the pane is holding rows back, which is what makes the reveal key
 * worth a slot in the footer. A pooled row is shown whatever its mark says, so
 * it does not count as folded.
 */
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
    // The model pane carries its headings as rows of its own, so that the
    // cursor can reach one and fold the section under it. Everything else has
    // its headings derived here.
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
    // A window that opens partway down a group would show provider rows with no
    // provider above them, which is the one thing the grouping exists to say.
    // Reprinting the heading costs the window's first row and is what makes the
    // list readable from anywhere in it rather than only from the top.
    const stuck = stickyGroupRow(rows, start);
    if (stuck === undefined) {
        return window;
    }
    // The heading takes a row from the end unless that is where the cursor is,
    // in which case it takes the top row instead. Either way the highlighted row
    // stays on screen, which is the one row that cannot be spared.
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
    // The extension says which row is in effect. `selectedId` is the cursor
    // and moves with the arrow keys, so reading the marker off it would draw a
    // dot that follows the highlight instead of marking anything.
    if (state.kind === "extension") {
        return option.current === true;
    }
    if (state.kind === "provider") return false;
    if (state.kind === "session") {
        return option.current === true;
    }
    return state.kind === "model" && option.value === state.initialModel;
}

/**
 * The panes short enough that a digit names a row faster than moving to it.
 * The model and session panes stay out: their names carry digits, so a digit
 * there is search input. On the panes below, digits select only while the
 * search is empty, and the numbers hide once a query starts filtering.
 */
export function digitQuickSelect(state: TuiAnySettingsPickerState): boolean {
    return state.kind === "reasoning"
        || state.kind === "permissions"
        || state.kind === "settings"
        || state.kind === "permission_settings";
}

/** The mark that hangs left of a row's label, if the row has one. */
export function optionMarker(
    state: TuiAnySettingsPickerState,
    option: TuiSettingsPickerOption,
): string | undefined {
    if (option.section !== undefined) {
        return option.sectionCollapsed === true ? "▶" : "▼";
    }
    if (option.action === true) {
        return "+";
    }
    if (state.kind === "provider") {
        return undefined;
    }
    // A filled dot, at the weight of the fold arrows it shares a column with.
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
    // The session list turns the marker column into a marker, a fork gutter and
    // a time column, so the facts a row is worth reading for sit left of the
    // title rather than after it. A fork indents under its parent, which is
    // what makes the list read as a history rather than a pile.
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

    // Show the curated catalog even while filtering: unmatched rows dim rather
    // than vanish, so the list keeps its stable palette-card shape.
    const matches = new Set(state.options.map((option) => option.value));
    // The theme list is filtered but never shortened, so a row's position in
    // `allOptions` is not its cursor index: only matched rows are selectable,
    // and their index is the one the filtered list uses.
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
        // System inherits the terminal palette, unknown until applied.
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
