import { stepIntelligenceCutoff } from "../../src/model/intelligence-cutoff.ts";
import { isTuiDialTabKey, tuiBindingId } from "./keymap.ts";
import {
    isSessionSpaceKey,
    sessionPickerOwnsKey,
    startSessionPreview,
} from "./session-preview.ts";
import {
    MODEL_ASSIGNMENT_BROWSE_VALUE,
    MODEL_ASSIGNMENT_SELF_VALUE,
    REVIEWER_CLEAR_VALUE,
    SESSION_LEAVE_OPTIONS,
    type TuiSettingsPickerKey,
    type TuiSettingsPickerState,
    type TuiSettingsPickerTransition,
} from "./settings-picker-types.ts";
import {
    isPooled,
    modelActionCursor,
    modelActionTransition,
    modelDetailActionTransition,
    modelDetailActions,
    modelListAction,
    modelListActionTransition,
    modelListFor,
    modelPageActions,
    pickerSelection,
    restoredCursor,
    sectionLabels,
    unchanged,
} from "./settings-picker-model.ts";

/** Keys one screen owns before the shared list keys. Undefined falls through to those. */
export function screenPickerKey(
    state: TuiSettingsPickerState,
    key: TuiSettingsPickerKey,
): TuiSettingsPickerTransition | undefined {
    switch (state.kind) {
        case "session":
            return sessionPickerKey(state, key);
        case "session_leave":
        case "session_create_leave":
            return leaveConfirmKey(state, key);
        case "session_import":
            return tuiBindingId("import_picker", key) === "import_scope"
                ? {
                    state,
                    importScope: state.importScope === "all" ? "folder" : "all",
                    handled: true,
                }
                : undefined;
        case "model_assignment":
            return subagentAssignmentKey(state, key);
        case "model":
            return modelPickerKey(state, key);
        case "provider":
            return providerPickerKey(state, key);
        default:
            return undefined;
    }
}

function sessionPickerKey(
    state: TuiSettingsPickerState,
    key: TuiSettingsPickerKey,
): TuiSettingsPickerTransition | undefined {
    const binding = tuiBindingId("session_picker", key);
    if (binding === "rename_session") {
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
    if (binding === "trash_session") {
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
    if (isTuiDialTabKey(key)) {
        return unchanged(state, true);
    }
    if (
        (key.name === "return" || key.name === "enter")
        && !key.ctrl && !key.meta
        && state.nothingToLeave !== true
        && state.enterDisposition !== "keep_running"
    ) {
        const selected = state.options[state.selectedIndex];
        if (
            selected !== undefined
            && selected.section === undefined
            && selected.current !== true
        ) {
            return {
                state: {
                    kind: "session_leave",
                    title: `Switch to ${selected.label}`,
                    allOptions: SESSION_LEAVE_OPTIONS,
                    options: SESSION_LEAVE_OPTIONS,
                    selectedIndex: 0,
                    query: "",
                    parent: state,
                },
                handled: true,
            };
        }
    }
    if (sessionPickerOwnsKey(state, key) && isSessionSpaceKey(key)) {
        const selected = state.options[state.selectedIndex];
        return selected?.sessionId === undefined
            ? unchanged(state, true)
            : startSessionPreview(state, selected);
    }
    return undefined;
}

/** Keep running or stop the session being left, for a switch or for a new session. */
function leaveConfirmKey(
    state: TuiSettingsPickerState,
    key: TuiSettingsPickerKey,
): TuiSettingsPickerTransition {
    const creating = state.kind === "session_create_leave";
    if (key.ctrl || key.meta || key.super || key.hyper) {
        return unchanged(state, false);
    }
    if (key.name === "escape") {
        return creating
            ? { handled: true }
            : { state: state.parent, handled: true };
    }
    if (key.name === "up" || key.name === "down") {
        return {
            state: {
                ...state,
                ...(creating ? { ignoreEnter: false } : {}),
                selectedIndex: Math.max(0, Math.min(
                    state.options.length - 1,
                    state.selectedIndex + (key.name === "up" ? -1 : 1),
                )),
            },
            handled: true,
        };
    }
    const choice = state.options[state.selectedIndex];
    if ((key.name !== "return" && key.name !== "enter") || choice === undefined) {
        return unchanged(state, true);
    }
    const sourceDisposition = choice.value === "keep_running"
        ? "keep_running"
        : "stop";
    if (creating) {
        return state.ignoreEnter === true
            ? { state: { ...state, ignoreEnter: false }, handled: true }
            : {
                selection: { kind: "session_create_leave", sourceDisposition },
                handled: true,
            };
    }
    const target = state.parent?.options[state.parent.selectedIndex];
    if (target === undefined) {
        return unchanged(state, true);
    }
    return {
        selection: {
            kind: "session",
            sessionPath: target.value,
            sourceDisposition,
            ...(target.sessionId === undefined
                ? {}
                : { sessionId: target.sessionId }),
        },
        handled: true,
    };
}

function subagentAssignmentKey(
    state: TuiSettingsPickerState,
    key: TuiSettingsPickerKey,
): TuiSettingsPickerTransition | undefined {
    if (
        state.modelAssignment !== "subagents"
        || tuiBindingId("model_assignment_picker", key)
            !== "toggle_subagent_assignment"
    ) {
        return undefined;
    }
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

function modelPickerKey(
    state: TuiSettingsPickerState,
    key: TuiSettingsPickerKey,
): TuiSettingsPickerTransition | undefined {
    const binding = tuiBindingId("model_picker", key);
    const selected = state.options[state.selectedIndex];
    if (binding === "toggle_pooled") {
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
    if (binding === "undo_pool_change") {
        return state.canUndoPoolChange === true
            ? { state, handled: true, undoPoolChange: true }
            : unchanged(state, true);
    }
    if (binding === "name_pooled") {
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
    if (binding === "move_pooled_up" || binding === "move_pooled_down") {
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
                delta: binding === "move_pooled_up" ? -1 : 1,
            },
        };
    }
    if (binding === "refresh_catalog") {
        return refreshCatalogKey(state, selected?.provider);
    }
    if (binding === "verify_pool") {
        return { state, handled: true, poolVerifySweep: true };
    }
    if (binding === "verify_model") {
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
    if (binding === "reveal_all_models") {
        const revealAll = state.revealAll !== true;
        const options = modelListFor(state, { revealAll });
        return {
            state: {
                ...state,
                revealAll,
                options,
                selectedIndex: restoredCursor(
                    options,
                    selected?.value,
                    state.initialModel,
                ),
            },
            handled: true,
        };
    }
    if (binding === "open_providers") {
        return { state, handled: true, openProviders: true };
    }
    const focused = modelFocusKey(state, key);
    if (focused !== undefined) {
        return focused;
    }
    if (binding === "collapse_all" || binding === "expand_all") {
        const collapsed = binding === "collapse_all"
            ? sectionLabels(state)
            : [];
        const options = modelListFor(state, { collapsed });
        return {
            state: {
                ...state,
                collapsed,
                options,
                selectedIndex: restoredCursor(
                    options,
                    selected?.value,
                    state.initialModel,
                ),
            },
            handled: true,
        };
    }
    return undefined;
}

/** Keys for the model pane's sections other than the list itself. */
function modelFocusKey(
    state: TuiSettingsPickerState,
    key: TuiSettingsPickerKey,
): TuiSettingsPickerTransition | undefined {
    const typed = (key.name.length === 1 || key.name === "space") && !key.ctrl;
    if (state.modelFocus === "page") {
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
        if (key.name === "right" || typed) {
            return unchanged(state, true);
        }
        return undefined;
    }
    if (state.modelFocus === "page_entry") {
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
        return undefined;
    }
    if (state.modelFocus === "intelligence") {
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
        return undefined;
    }
    if (state.modelFocus === "detail") {
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
        if (key.name === "right" || typed) {
            return unchanged(state, true);
        }
        return undefined;
    }
    if (state.modelFocus === "list_action") {
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
        if (typed) {
            return unchanged(state, true);
        }
    }
    return undefined;
}

function providerPickerKey(
    state: TuiSettingsPickerState,
    key: TuiSettingsPickerKey,
): TuiSettingsPickerTransition | undefined {
    const binding = tuiBindingId("model_picker", key);
    const selected = state.options[state.selectedIndex];
    if (binding === "refresh_catalog") {
        return refreshCatalogKey(
            state,
            selected?.action === true ? undefined : selected?.value,
        );
    }
    if (binding === "declare_provider") {
        return { state, handled: true, declareProvider: true };
    }
    if (binding === "edit_endpoint") {
        if (selected?.endpointEditable !== true) {
            return unchanged(state, true);
        }
        return selected.declared === true
            ? { state, handled: true, editProvider: selected.value }
            : { state, handled: true, editEndpoint: selected.value };
    }
    if (binding === "forget_provider") {
        if (selected === undefined || selected.action === true) {
            return unchanged(state, true);
        }
        return { state, handled: true, forgetProvider: selected.value };
    }
    return undefined;
}

function refreshCatalogKey(
    state: TuiSettingsPickerState,
    provider: string | undefined,
): TuiSettingsPickerTransition {
    const selected = state.options[state.selectedIndex];
    if (provider === undefined || selected?.refreshable !== true) {
        return unchanged(state, true);
    }
    return { state, handled: true, refreshCatalog: provider };
}
