import {
  bg,
  BoxRenderable,
  fg,
  italic,
  type RenderContext,
  StyledText,
  TextareaRenderable,
  type TextChunk,
  TextRenderable,
} from "@opentui/core";

import {
  loadStandingNudges,
  MAX_STANDING_NUDGE_TEXT_CODE_UNITS,
  MAX_STANDING_NUDGE_TEXT_LINES,
  MAX_STANDING_NUDGE_TURNS_APART,
  MAX_STANDING_NUDGES,
  saveStandingNudges,
  STANDING_NUDGE_ID_PATTERN,
  type StandingNudge,
  type StandingNudgeMatch,
  standingNudgeMatches,
  StandingNudgesError,
  standingNudgesPath,
  type StandingNudgeTrigger,
} from "../../src/standing-nudges.ts";
import {
  APP_PADDING_TOP,
  centeredDialogSurface,
  DIALOG_CARD_PADDING,
  dialogFooterNode,
  dialogHeaderNode,
  dialogInsetBottomOffset,
} from "./dialog-chrome.ts";
import {
  LIST_MIN_ROWS,
  listWindowSlice,
  wheelCursor,
} from "./list-window.ts";
import {
  TUI_ACCENT,
  TUI_ELEMENT,
  TUI_INPUT,
  TUI_MUTED,
  TUI_NOTICE,
  TUI_PANEL,
  TUI_SELECTION_TEXT,
  TUI_TEXT,
} from "./state.ts";
import { type TuiThemeBinding, tuiThemeProperties } from "./theme-bindings.ts";

export interface TuiStandingNudgesKey {
  readonly name: string;
  readonly sequence?: string;
  readonly ctrl?: boolean;
  readonly meta?: boolean;
  readonly shift?: boolean;
  readonly super?: boolean;
  readonly hyper?: boolean;
}

interface TuiStandingNudgesBase {
  readonly profileDirectory: string;
  readonly workspace: string;
}

export interface TuiStandingNudgesListState extends TuiStandingNudgesBase {
  readonly screen: "list";
  readonly nudges: readonly StandingNudge[];
  readonly selectedIndex: number;
}

export type TuiStandingNudgeFormField =
  | "id"
  | "text"
  | "enabled"
  | "trigger"
  | "equals"
  | "turnsApart"
  | "save";

interface TuiStandingNudgeDraft {
  readonly id: string;
  readonly text: string;
  readonly enabled: boolean;
  readonly trigger: StandingNudgeTrigger["type"];
  readonly equals: string;
  readonly turnsApart: number;
}

export interface TuiStandingNudgesFormState extends TuiStandingNudgesBase {
  readonly screen: "create" | "edit";
  readonly nudges: readonly StandingNudge[];
  readonly selectedIndex: number;
  readonly draft: TuiStandingNudgeDraft;
  readonly field: TuiStandingNudgeFormField;
  readonly editing: boolean;
  readonly error?: string;
}

export interface TuiStandingNudgesDeleteState extends TuiStandingNudgesBase {
  readonly screen: "delete_confirm";
  readonly nudges: readonly StandingNudge[];
  readonly selectedIndex: number;
  readonly target: StandingNudge;
}

type TuiStandingNudgesRecoverableState =
  | TuiStandingNudgesListState
  | TuiStandingNudgesFormState
  | TuiStandingNudgesDeleteState;

interface TuiStandingNudgesLoadRetry {
  readonly kind: "load";
}

interface TuiStandingNudgesSaveRetry {
  readonly kind: "save";
  readonly nudges: readonly StandingNudge[];
  readonly selectedIndex: number;
}

type TuiStandingNudgesRetry =
  | TuiStandingNudgesLoadRetry
  | TuiStandingNudgesSaveRetry;

export interface TuiStandingNudgesErrorState extends TuiStandingNudgesBase {
  readonly screen: "error";
  readonly path: string;
  readonly message: string;
  readonly retry: TuiStandingNudgesRetry;
  readonly back?: TuiStandingNudgesRecoverableState;
}

export type TuiStandingNudgesState =
  | TuiStandingNudgesListState
  | TuiStandingNudgesFormState
  | TuiStandingNudgesDeleteState
  | TuiStandingNudgesErrorState;

export interface TuiStandingNudgesTransition {
  readonly state?: TuiStandingNudgesState;
  readonly handled: boolean;
}

export interface TuiStandingNudgesView {
  readonly box: BoxRenderable;
  readonly surface: BoxRenderable;
  readonly themeBindings: readonly TuiThemeBinding[];
  focus(): void;
  handleEditorKey(
    state: TuiStandingNudgesState,
    key: TuiStandingNudgesKey,
  ): TuiStandingNudgesTransition;
  handleEditorPaste(
    state: TuiStandingNudgesState,
    text: string,
  ): TuiStandingNudgesTransition;
  handleViewportKey(name: string): boolean;
  scroll(scroll: {
    readonly direction: "up" | "down" | "left" | "right";
    readonly delta: number;
  }): boolean;
  update(state: TuiStandingNudgesState): void;
}

export function openTuiStandingNudges(
  profileDirectory: string,
  workspace: string,
): TuiStandingNudgesState {
  try {
    return listState(
      profileDirectory,
      workspace,
      loadStandingNudges(profileDirectory),
      0,
    );
  } catch (error) {
    return errorState(profileDirectory, workspace, error, { kind: "load" });
  }
}

export function handleTuiStandingNudgesKey(
  state: TuiStandingNudgesState,
  key: TuiStandingNudgesKey,
): TuiStandingNudgesTransition {
  switch (state.screen) {
    case "list":
      return handleListKey(state, key);
    case "create":
    case "edit":
      return handleFormKey(state, key);
    case "delete_confirm":
      return handleDeleteKey(state, key);
    case "error":
      return handleErrorKey(state, key);
  }
}

export function handleTuiStandingNudgesPaste(
  state: TuiStandingNudgesState,
  text: string,
): TuiStandingNudgesState {
  if (state.screen !== "create" && state.screen !== "edit") return state;
  if (!state.editing || !formTextField(state.field)) return state;
  const pasted = sanitizeFormPaste(state.field, text);
  if (pasted.length === 0) return state;
  return editDraft(state, fieldValue(state, state.field) + pasted);
}

export function renderTuiStandingNudges(state: TuiStandingNudgesState): string {
  const content = screenContent(state);
  return [content.title, "", content.body, "", content.footer].join("\n");
}

export function createTuiStandingNudgesView(
  renderer: RenderContext,
): TuiStandingNudgesView {
  const headerSlot = new BoxRenderable(renderer, {
    width: "100%",
    height: "auto",
    flexShrink: 0,
  });
  let header = dialogHeaderNode(renderer, "Standing nudges");
  let headerTitle = "Standing nudges";
  headerSlot.add(header);
  const hint = new TextRenderable(renderer, {
    content: "",
    fg: TUI_MUTED,
    width: "100%",
    height: "auto",
    wrapMode: "word",
    visible: false,
  });
  const editor = new TextareaRenderable(renderer, {
    id: "standing-nudge-editor",
    width: "100%",
    height: 1,
    wrapMode: "word",
    textColor: TUI_TEXT,
    focusedTextColor: TUI_TEXT,
    backgroundColor: TUI_INPUT,
    focusedBackgroundColor: TUI_INPUT,
    cursorColor: TUI_ACCENT,
    placeholderColor: TUI_MUTED,
  });
  const editorBox = new BoxRenderable(renderer, {
    width: "100%",
    height: "auto",
    backgroundColor: TUI_INPUT,
    paddingLeft: 1,
    paddingRight: 1,
    marginTop: 1,
    visible: false,
  });
  editorBox.add(editor);
  const body = new TextRenderable(renderer, {
    content: "",
    fg: TUI_TEXT,
    width: "100%",
    height: "auto",
    wrapMode: "word",
    marginTop: 1,
  });
  const empty = new TextRenderable(renderer, {
    content: "No standing nudges",
    fg: TUI_MUTED,
    width: "100%",
    height: "auto",
    wrapMode: "word",
    marginTop: 1,
    visible: false,
  });
  const footer = dialogFooterNode(renderer, "");
  const box = new BoxRenderable(renderer, {
    id: "standing-nudges",
    border: false,
    backgroundColor: TUI_PANEL,
    width: "80%",
    height: "auto",
    maxHeight: standingNudgesCardRows(renderer),
    flexDirection: "column",
    paddingLeft: DIALOG_CARD_PADDING,
    paddingRight: DIALOG_CARD_PADDING,
    paddingTop: 1,
    paddingBottom: 1,
    focusable: true,
  });
  box.add(headerSlot);
  box.add(hint);
  box.add(editorBox);
  box.add(body);
  box.add(empty);
  box.add(footer);
  const surface = centeredDialogSurface(
    renderer,
    "standing-nudges-surface",
    box,
  );
  let shownState: TuiStandingNudgesState | undefined;
  let shownField: TuiStandingNudgeFormField | undefined;
  let shownEquals: string | undefined;
  let shownEditing = false;
  let equalsScrollTop = 0;
  let equalsScrollMaximum = 0;
  let equalsPageRows = 1;
  let equalsOverflow = false;

  const update = (
    state: TuiStandingNudgesState,
    viewportOnly = false,
  ): void => {
    const compact = standingNudgesCompact(renderer);
    const formWidth = Math.max(
      20,
      Math.floor(renderer.width * 0.8) -
        DIALOG_CARD_PADDING * 2,
    );
    const dense = compact || formNeedsDenseChrome(state, formWidth);
    const form = state.screen === "create" || state.screen === "edit";
    const editing = form && state.editing && formTextField(state.field);
    body.marginTop = dense ? 0 : 1;
    empty.marginTop = dense ? 0 : 1;
    editorBox.marginTop = dense ? 0 : 1;
    footer.marginTop = dense ? 0 : 1;
    footer.height = dense ? 1 : 2;
    box.paddingBottom = dense ? 0 : 1;
    box.maxHeight = standingNudgesCardRows(renderer);
    const content = state.screen === "list"
      ? listScreenContent(state, visibleListIndices(renderer, state))
      : screenContent(state);
    const title = editing ? editorTitle(state) : content.title;
    if (title !== headerTitle) {
      header.destroyRecursively();
      header = dialogHeaderNode(renderer, title);
      headerTitle = title;
      headerSlot.add(header);
    }
    const emptyList = state.screen === "list" &&
      state.nudges.length === 0;
    hint.visible = form && !dense && !editing;
    const hintContent = state.screen === "create"
      ? "A profile preference applied to matching turns."
      : state.screen === "edit"
      ? "Change the instruction, status, or where it applies."
      : "";
    hint.content = hintContent;
    editorBox.visible = editing;
    body.visible = !emptyList && !editing;
    empty.visible = emptyList;
    body.wrapMode = form ? "char" : "word";
    const maxBodyRows = standingNudgeBodyViewportRows(
      renderer,
      dense,
      hint.visible ? wrapFormValue(hintContent, formWidth).length : 0,
    );
    if (editing) {
      const editorChanged = !shownEditing ||
        shownState?.screen !== state.screen ||
        shownField !== state.field;
      if (editorChanged) {
        editor.setText(fieldValue(state, state.field));
        editor.cursorOffset = editor.plainText.length;
      }
      editor.wrapMode = state.field === "id" ? "none" : "word";
      const editorRows = Math.max(1, maxBodyRows - (dense ? 0 : 1));
      editor.height = state.field === "id"
        ? 1
        : state.field === "text"
        ? Math.max(
          2,
          Math.min(MAX_STANDING_NUDGE_TEXT_LINES, editorRows),
        )
        : Math.max(3, Math.min(8, editorRows));
      editor.placeholder = formPlaceholder(state, state.field);
    }
    let equalsWindow: FormValueWindow | undefined;
    equalsOverflow = false;
    if (
      form && !editing && !compact &&
      state.draft.trigger !== "always"
    ) {
      const fixedFormRows = formFields(state)
        .filter((field) => field !== "equals")
        .reduce(
          (rows, field) =>
            rows +
            formValueLines(state, field, formWidth, false).length +
            (field === "save" ? 1 : 0),
          state.error === undefined
            ? 0
            : 2 + wrapFormValue(state.error, formWidth).length,
        );
      const allEqualsLines = formValueLines(
        state,
        "equals",
        formWidth,
        false,
      );
      const equalsRows = Math.max(1, maxBodyRows - fixedFormRows);
      equalsOverflow = allEqualsLines.length > equalsRows;
      equalsPageRows = Math.max(1, equalsRows - 2);
      const finalPageValueRows = equalsRows <= 2 ? equalsRows : equalsRows - 1;
      equalsScrollMaximum = Math.max(
        0,
        allEqualsLines.length - Math.max(1, finalPageValueRows),
      );
      const fieldChanged = shownState?.screen !== state.screen ||
        shownField !== state.field;
      const equalsChanged = shownEquals !== state.draft.equals;
      if (!viewportOnly) {
        if (
          state.field === "equals" &&
          (fieldChanged || equalsChanged)
        ) {
          equalsScrollTop = equalsScrollMaximum;
        } else if (shownState?.screen !== state.screen) {
          equalsScrollTop = 0;
        }
      }
      equalsScrollTop = Math.max(
        0,
        Math.min(equalsScrollTop, equalsScrollMaximum),
      );
      if (equalsOverflow) {
        equalsWindow = {
          first: equalsScrollTop,
          rows: equalsRows,
        };
      }
    } else {
      equalsScrollTop = 0;
      equalsScrollMaximum = 0;
      equalsPageRows = 1;
    }
    const bodyContent = form
      ? tuiStandingNudgeFormContent(
        state,
        formWidth,
        compact,
        equalsWindow,
      )
      : content.body;
    body.content = bodyContent;
    const overflowChoiceHint = form ? formNavigationActionHint(state) : "";
    footer.content = equalsOverflow
      ? `${overflowChoiceHint}pgup/pgdn match · ↑↓/tab field · esc back`
      : content.footer;
    shownState = state;
    shownField = form ? state.field : undefined;
    shownEquals = form ? state.draft.equals : undefined;
    shownEditing = editing;
  };

  const scrollEquals = (step: number): boolean => {
    if (!equalsOverflow || shownState === undefined) return false;
    const next = Math.max(
      0,
      Math.min(equalsScrollTop + step, equalsScrollMaximum),
    );
    if (next === equalsScrollTop) return true;
    equalsScrollTop = next;
    update(shownState, true);
    return true;
  };

  return {
    box,
    surface,
    themeBindings: [
      tuiThemeProperties(body, { fg: "text" }),
      tuiThemeProperties(editor, {
        textColor: "text",
        focusedTextColor: "text",
        backgroundColor: "input",
        focusedBackgroundColor: "input",
        cursorColor: "accent",
        placeholderColor: "muted",
      }),
      tuiThemeProperties(editorBox, { backgroundColor: "input" }),
      tuiThemeProperties(hint, { fg: "muted" }),
      tuiThemeProperties(empty, { fg: "muted" }),
      tuiThemeProperties(footer, { fg: "muted" }),
      tuiThemeProperties(box, { backgroundColor: "panel" }),
    ],
    focus(): void {
      if (shownEditing) editor.focus();
      else box.focus();
    },
    handleEditorKey(state, key): TuiStandingNudgesTransition {
      if (!formStateEditingText(state)) {
        return { state, handled: false };
      }
      if (key.name === "escape") {
        return {
          state: {
            ...editDraft(state, editor.plainText),
            editing: false,
          },
          handled: true,
        };
      }
      if (
        (key.name === "return" || key.name === "enter") &&
        state.field !== "text"
      ) {
        return {
          state: {
            ...editDraft(state, editor.plainText),
            editing: false,
          },
          handled: true,
        };
      }
      const tabStep = formTabStep(key);
      if (tabStep !== undefined) {
        return {
          state: moveField(editDraft(state, editor.plainText), tabStep),
          handled: true,
        };
      }
      editor.handleKeyPress(textareaKey(key));
      return {
        state: editDraft(state, editor.plainText),
        handled: true,
      };
    },
    handleEditorPaste(state, text): TuiStandingNudgesTransition {
      if (!formStateEditingText(state)) {
        return { state, handled: false };
      }
      const pasted = sanitizeFormPaste(state.field, text);
      if (pasted.length > 0) editor.insertText(pasted);
      return {
        state: editDraft(state, editor.plainText),
        handled: true,
      };
    },
    handleViewportKey(name): boolean {
      if (name !== "pageup" && name !== "pagedown") return false;
      return scrollEquals(
        (name === "pageup" ? -1 : 1) * equalsPageRows,
      );
    },
    scroll(scroll): boolean {
      if (scroll.direction !== "up" && scroll.direction !== "down") {
        return false;
      }
      return scrollEquals(
        (scroll.direction === "up" ? -1 : 1) *
          Math.max(1, Math.ceil(Math.abs(scroll.delta))),
      );
    },
    update,
  };
}

export function handleTuiStandingNudgesScroll(
  state: TuiStandingNudgesState,
  scroll: {
    readonly direction: "up" | "down" | "left" | "right";
    readonly delta: number;
  },
): TuiStandingNudgesTransition {
  if (state.screen !== "list") return { state, handled: false };
  const selectedIndex = wheelCursor(
    state.selectedIndex,
    state.nudges.length,
    scroll,
  );
  return selectedIndex === undefined
    ? { state, handled: false }
    : { state: { ...state, selectedIndex }, handled: true };
}

function handleListKey(
  state: TuiStandingNudgesListState,
  key: TuiStandingNudgesKey,
): TuiStandingNudgesTransition {
  if (modified(key)) return { state, handled: false };
  if (key.name === "escape") return { handled: true };
  if (key.name === "up" || key.name === "down") {
    const step = key.name === "up" ? -1 : 1;
    return {
      state: {
        ...state,
        selectedIndex: clampIndex(
          state.selectedIndex + step,
          state.nudges.length,
        ),
      },
      handled: true,
    };
  }
  if (key.name === "n") {
    return {
      state: {
        ...state,
        screen: "create",
        draft: EMPTY_STANDING_NUDGE_DRAFT,
        field: "id",
        editing: false,
      },
      handled: true,
    };
  }
  const selected = state.nudges[state.selectedIndex];
  if (key.name === "space" || key.sequence === " ") {
    if (selected === undefined) return { state, handled: true };
    const changed = state.nudges.map((nudge, index) =>
      index === state.selectedIndex
        ? { ...nudge, enabled: !nudge.enabled }
        : nudge
    );
    return persistFromList(state, changed, state.selectedIndex);
  }
  if (key.name === "return" || key.name === "enter") {
    if (selected === undefined) return { state, handled: true };
    return {
      state: {
        ...state,
        screen: "edit",
        draft: {
          id: selected.id,
          text: selected.text,
          enabled: selected.enabled,
          trigger: selected.trigger.type,
          equals: selected.trigger.type === "always"
            ? ""
            : selected.trigger.equals,
          turnsApart: selected.turnsApart,
        },
        field: "text",
        editing: false,
      },
      handled: true,
    };
  }
  if (key.name === "d") {
    return selected === undefined ? { state, handled: true } : {
      state: { ...state, screen: "delete_confirm", target: selected },
      handled: true,
    };
  }
  return { state, handled: false };
}

function handleFormKey(
  state: TuiStandingNudgesFormState,
  key: TuiStandingNudgesKey,
): TuiStandingNudgesTransition {
  if (state.editing) return handleFallbackEditorKey(state, key);
  if (key.name === "escape") {
    return { state: parentList(state), handled: true };
  }
  if (commandModified(key)) return { state, handled: true };
  if (key.name === "up" || key.name === "down") {
    return {
      state: moveField(state, key.name === "up" ? -1 : 1),
      handled: true,
    };
  }
  const tabStep = formTabStep(key);
  if (tabStep !== undefined) {
    return { state: moveField(state, tabStep), handled: true };
  }
  if (
    (state.field === "enabled" || state.field === "trigger" ||
      state.field === "turnsApart") &&
    (key.name === "space" || key.sequence === " ")
  ) {
    return {
      state: state.field === "enabled"
        ? toggleDraftEnabled(state)
        : state.field === "turnsApart"
        ? cycleTurnsApart(state)
        : cycleTrigger(state, 1),
      handled: true,
    };
  }
  if (key.name === "return" || key.name === "enter") {
    if (formTextField(state.field)) {
      return { state: { ...state, editing: true }, handled: true };
    }
    if (state.field === "save") return submitForm(state);
    return { state, handled: true };
  }
  if (
    state.field === "enabled" || state.field === "trigger" ||
    state.field === "turnsApart"
  ) {
    return { state, handled: true };
  }
  return { state, handled: true };
}

/** Keep the state reducer usable without a renderer. The OpenTUI view replaces this append-only seam with its real cursor editor in the running client. */
function handleFallbackEditorKey(
  state: TuiStandingNudgesFormState,
  key: TuiStandingNudgesKey,
): TuiStandingNudgesTransition {
  if (key.name === "escape") {
    return { state: { ...state, editing: false }, handled: true };
  }
  const tabStep = formTabStep(key);
  if (tabStep !== undefined) {
    return { state: moveField(state, tabStep), handled: true };
  }
  if (
    (key.name === "return" || key.name === "enter") &&
    state.field !== "text"
  ) {
    return { state: { ...state, editing: false }, handled: true };
  }
  if (commandModified(key)) return { state, handled: true };
  if (key.name === "backspace") {
    return {
      state: editDraft(
        state,
        fieldValue(state, state.field).slice(0, -1),
      ),
      handled: true,
    };
  }
  if (key.name === "return" || key.name === "enter") {
    return {
      state: editDraft(state, `${fieldValue(state, state.field)}\n`),
      handled: true,
    };
  }
  const typed = key.sequence !== undefined && key.sequence.length > 0
    ? key.sequence
    : key.name.length === 1
    ? key.name
    : undefined;
  if (typed === undefined || /[\u0000-\u001f\u007f]/.test(typed)) {
    return { state, handled: true };
  }
  return {
    state: editDraft(state, fieldValue(state, state.field) + typed),
    handled: true,
  };
}

function handleDeleteKey(
  state: TuiStandingNudgesDeleteState,
  key: TuiStandingNudgesKey,
): TuiStandingNudgesTransition {
  if (key.name === "escape") {
    return { state: parentList(state), handled: true };
  }
  if (!modified(key) && (key.name === "return" || key.name === "enter")) {
    const changed = state.nudges.filter(
      (nudge) => nudge.id !== state.target.id,
    );
    return persistFromList(
      parentList(state),
      changed,
      clampIndex(state.selectedIndex, changed.length),
      state,
    );
  }
  return { state, handled: true };
}

function handleErrorKey(
  state: TuiStandingNudgesErrorState,
  key: TuiStandingNudgesKey,
): TuiStandingNudgesTransition {
  if (key.name === "escape") {
    return state.back === undefined
      ? { handled: true }
      : { state: state.back, handled: true };
  }
  if (
    !modified(key) &&
    (key.name === "return" || key.name === "enter" || key.name === "r")
  ) {
    if (state.retry.kind === "load") {
      return {
        state: openTuiStandingNudges(
          state.profileDirectory,
          state.workspace,
        ),
        handled: true,
      };
    }
    try {
      const saved = saveStandingNudges(
        state.profileDirectory,
        state.retry.nudges,
      );
      return {
        state: listState(
          state.profileDirectory,
          state.workspace,
          saved,
          state.retry.selectedIndex,
        ),
        handled: true,
      };
    } catch (error) {
      return {
        state: errorState(
          state.profileDirectory,
          state.workspace,
          error,
          state.retry,
          state.back,
        ),
        handled: true,
      };
    }
  }
  return { state, handled: true };
}

function submitForm(
  state: TuiStandingNudgesFormState,
): TuiStandingNudgesTransition {
  const validationError = formValidationError(state);
  if (validationError !== undefined) {
    return {
      state: { ...state, error: validationError },
      handled: true,
    };
  }
  const nudge: StandingNudge = {
    id: state.draft.id,
    enabled: state.draft.enabled,
    text: state.draft.text,
    trigger: state.draft.trigger === "always"
      ? { type: "always" }
      : { type: state.draft.trigger, equals: state.draft.equals },
    turnsApart: state.draft.turnsApart,
  };
  const changed = state.screen === "create"
    ? [...state.nudges, nudge]
    : state.nudges.map((existing, index) =>
      index === state.selectedIndex ? nudge : existing
    );
  try {
    const saved = saveStandingNudges(state.profileDirectory, changed);
    const selectedIndex = saved.findIndex((entry) => entry.id === nudge.id);
    return {
      state: listState(
        state.profileDirectory,
        state.workspace,
        saved,
        selectedIndex,
      ),
      handled: true,
    };
  } catch (error) {
    return {
      state: {
        ...state,
        error: formSaveError(error),
      },
      handled: true,
    };
  }
}

function formValidationError(
  state: TuiStandingNudgesFormState,
): string | undefined {
  const id = state.draft.id;
  if (id.length === 0) return "Name the nudge before saving.";
  if (!STANDING_NUDGE_ID_PATTERN.test(id)) {
    return "Use a lowercase name with letters, numbers, or hyphens.";
  }
  if (
    state.screen === "create" &&
    state.nudges.some((nudge) => nudge.id === id)
  ) {
    return `A nudge named “${id}” already exists.`;
  }
  if (
    state.screen === "create" &&
    state.nudges.length >= MAX_STANDING_NUDGES
  ) {
    return `You can save up to ${MAX_STANDING_NUDGES} standing nudges.`;
  }
  const text = normalizedInstruction(state.draft.text);
  if (text.length === 0) return "Add an instruction before saving.";
  if (text.split("\n").length > MAX_STANDING_NUDGE_TEXT_LINES) {
    return `Keep the instruction to ${MAX_STANDING_NUDGE_TEXT_LINES} lines or fewer.`;
  }
  if (text.length > MAX_STANDING_NUDGE_TEXT_CODE_UNITS) {
    return `Keep the instruction under ${
      MAX_STANDING_NUDGE_TEXT_CODE_UNITS.toLocaleString("en-US")
    } characters.`;
  }
  if (
    state.draft.trigger !== "always" &&
    state.draft.equals.trim().length === 0
  ) {
    return state.draft.trigger === "agent"
      ? "Enter the exact agent name before saving."
      : "Enter the exact workspace path before saving.";
  }
  return undefined;
}

function normalizedInstruction(text: string): string {
  return text.trim().replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

function formSaveError(error: unknown): string {
  if (error instanceof StandingNudgesError) {
    if (error.problem.startsWith("assembled content is ")) {
      return "These active nudges are too long together. Shorten or disable one.";
    }
    if (error.problem.startsWith("it is not valid JSON")) {
      return "The profile file changed and is no longer valid JSON. Reopen Standing nudges to repair it.";
    }
    return `Could not save changes. ${
      friendlyStorageProblem(error.problem, error.path)
    }`;
  }
  return "Could not save changes. Check that the profile directory is writable and try again.";
}

function loadErrorMessage(error: unknown): string {
  return error instanceof StandingNudgesError
    ? friendlyStorageProblem(error.problem, error.path)
    : "Vera could not access the profile file. Check its permissions and try again.";
}

function friendlyStorageProblem(problem: string, path?: string): string {
  if (problem.startsWith("it is not valid JSON")) {
    return "The file is not valid JSON.";
  }
  if (problem.startsWith("ENOTDIR")) {
    return "A parent of this path is a file instead of a directory.";
  }
  if (problem.startsWith("EISDIR")) {
    return "This path is a directory instead of a file.";
  }
  if (problem.startsWith("EACCES") || problem.startsWith("EPERM")) {
    return "Vera does not have permission to access this file.";
  }
  const rule = /^nudges\[(\d+)\]\.(.+)$/.exec(problem);
  if (rule !== null) {
    const number = Number(rule[1]) + 1;
    const detail = rule[2] ?? "";
    if (detail === "text must not be empty") {
      return `Rule ${number} needs an instruction.`;
    }
    if (detail.startsWith("text exceeds 4 lines")) {
      return `Rule ${number} has more than 4 instruction lines.`;
    }
    if (detail.startsWith("text exceeds ")) {
      return `Rule ${number}'s instruction is too long.`;
    }
    if (detail.startsWith("id must match ")) {
      return `Rule ${number} has an invalid name. Use lowercase letters, numbers, or hyphens.`;
    }
    if (detail === "trigger.equals must be a non-empty string") {
      return `Rule ${number} needs an agent name or workspace path.`;
    }
  }
  const duplicate = /^duplicate id "(.+)"$/.exec(problem);
  if (duplicate !== null) {
    return `The name “${duplicate[1]}” is used more than once.`;
  }
  if (problem.startsWith("assembled content is ")) {
    return "The active nudges are too long together. Shorten or disable one.";
  }
  const detail = path === undefined
    ? problem
    : problem.replaceAll(path, "this file");
  return `The file is invalid: ${detail}.`;
}

function persistFromList(
  state: TuiStandingNudgesListState,
  nudges: readonly StandingNudge[],
  selectedIndex: number,
  back: TuiStandingNudgesRecoverableState = state,
): TuiStandingNudgesTransition {
  try {
    const saved = saveStandingNudges(state.profileDirectory, nudges);
    return {
      state: listState(
        state.profileDirectory,
        state.workspace,
        saved,
        selectedIndex,
      ),
      handled: true,
    };
  } catch (error) {
    return {
      state: errorState(
        state.profileDirectory,
        state.workspace,
        error,
        { kind: "save", nudges, selectedIndex },
        back,
      ),
      handled: true,
    };
  }
}

function listState(
  profileDirectory: string,
  workspace: string,
  nudges: readonly StandingNudge[],
  selectedIndex: number,
): TuiStandingNudgesListState {
  return {
    screen: "list",
    profileDirectory,
    workspace,
    nudges,
    selectedIndex: clampIndex(selectedIndex, nudges.length),
  };
}

function parentList(
  state: TuiStandingNudgesRecoverableState,
): TuiStandingNudgesListState {
  return listState(
    state.profileDirectory,
    state.workspace,
    state.nudges,
    state.selectedIndex,
  );
}

function errorState(
  profileDirectory: string,
  workspace: string,
  error: unknown,
  retry: TuiStandingNudgesRetry,
  back?: TuiStandingNudgesRecoverableState,
): TuiStandingNudgesErrorState {
  return {
    screen: "error",
    profileDirectory,
    workspace,
    path: standingNudgesPath(profileDirectory),
    message: loadErrorMessage(error),
    retry,
    ...(back === undefined ? {} : { back }),
  };
}

function formFields(
  state: TuiStandingNudgesFormState,
): readonly TuiStandingNudgeFormField[] {
  const fields: TuiStandingNudgeFormField[] = state.screen === "create"
    ? ["id", "text", "enabled", "trigger"]
    : ["text", "enabled", "trigger"];
  if (state.draft.trigger !== "always") fields.push("equals");
  fields.push("turnsApart");
  fields.push("save");
  return fields;
}

function moveField(
  state: TuiStandingNudgesFormState,
  step: -1 | 1,
): TuiStandingNudgesFormState {
  const fields = formFields(state);
  const at = Math.max(0, fields.indexOf(state.field));
  return {
    ...state,
    field: fields[(at + step + fields.length) % fields.length]!,
    editing: false,
  };
}

function cycleTrigger(
  state: TuiStandingNudgesFormState,
  step: -1 | 1,
): TuiStandingNudgesFormState {
  const choices = ["always", "agent", "workspace"] as const;
  const at = choices.indexOf(state.draft.trigger);
  const trigger = choices[(at + step + choices.length) % choices.length]!;
  const equals = trigger === "workspace"
    ? state.draft.trigger === "workspace" ? state.draft.equals : state.workspace
    : trigger === "agent"
    ? state.draft.trigger === "agent" ? state.draft.equals : ""
    : "";
  const { error: _error, ...rest } = state;
  return { ...rest, draft: { ...state.draft, trigger, equals } };
}

function toggleDraftEnabled(
  state: TuiStandingNudgesFormState,
): TuiStandingNudgesFormState {
  const { error: _error, ...rest } = state;
  return {
    ...rest,
    draft: { ...state.draft, enabled: !state.draft.enabled },
  };
}

function cycleTurnsApart(
  state: TuiStandingNudgesFormState,
): TuiStandingNudgesFormState {
  const choices = [
    0,
    ...Array.from(
      { length: MAX_STANDING_NUDGE_TURNS_APART - 1 },
      (_unused, index) => index + 2,
    ),
  ];
  const at = Math.max(0, choices.indexOf(state.draft.turnsApart));
  const turnsApart = choices[(at + 1) % choices.length]!;
  const { error: _error, ...rest } = state;
  return { ...rest, draft: { ...state.draft, turnsApart } };
}

function fieldValue(
  state: TuiStandingNudgesFormState,
  field: TuiStandingNudgeFormField,
): string {
  switch (field) {
    case "id":
      return state.draft.id;
    case "text":
      return state.draft.text;
    case "enabled":
      return state.draft.enabled ? "Active" : "Inactive";
    case "trigger":
      return triggerTypeLabel(state.draft.trigger);
    case "equals":
      return state.draft.equals;
    case "turnsApart":
      return turnsApartLabel(state.draft.turnsApart);
    case "save":
      return "Save changes";
  }
}

function editDraft(
  state: TuiStandingNudgesFormState,
  value: string,
): TuiStandingNudgesFormState {
  const { error: _error, ...rest } = state;
  switch (state.field) {
    case "id":
      return { ...rest, draft: { ...state.draft, id: value } };
    case "text":
      return { ...rest, draft: { ...state.draft, text: value } };
    case "equals":
      return { ...rest, draft: { ...state.draft, equals: value } };
    case "enabled":
    case "trigger":
    case "turnsApart":
    case "save":
      return rest;
  }
}

function screenContent(
  state: TuiStandingNudgesState,
): {
  readonly title: string;
  readonly body: string;
  readonly footer: string;
} {
  switch (state.screen) {
    case "list":
      return listScreenContent(
        state,
        state.nudges.map((_nudge, index) => index),
      );
    case "create":
    case "edit":
      return {
        title: state.screen === "create"
          ? "New standing nudge"
          : `Edit ${state.draft.id}`,
        body: [
          ...plainFormRows(state),
          ...(state.error === undefined ? [] : ["", state.error]),
        ].join("\n"),
        footer: state.editing && state.field === "text"
          ? "4 lines max · ↑↓ move · ⏎ newline · tab next · esc done"
          : state.editing
          ? "←→ move · ⏎ done · tab next · esc done"
          : state.field === "enabled"
          ? "Space toggle · ↑↓/tab field · esc back"
          : state.field === "trigger" ||
              state.field === "turnsApart"
          ? "Space change · ↑↓/tab field · esc back"
          : state.field === "save"
          ? "⏎ save · ↑↓/tab field · esc back"
          : "⏎ edit · ↑↓/tab field · esc back",
      };
    case "delete_confirm":
      return {
        title: `Delete ${state.target.id}?`,
        body: "This cannot be undone.",
        footer: "⏎ delete · esc back",
      };
    case "error":
      return {
        title: state.retry.kind === "load"
          ? "Standing nudges could not be loaded"
          : "Standing nudges could not be saved",
        body: `${state.path}\n${state.message}`,
        footer: `⏎ retry · esc ${state.back === undefined ? "close" : "back"}`,
      };
  }
}

function listScreenContent(
  state: TuiStandingNudgesListState,
  indices: readonly number[],
): { readonly title: string; readonly body: string; readonly footer: string } {
  return {
    title: "Standing nudges",
    body: state.nudges.length === 0
      ? "No standing nudges"
      : listRows(state, indices).join("\n"),
    footer: state.nudges.length === 0
      ? "n new · esc close"
      : "Space toggle · Enter edit · n new · d delete · esc close",
  };
}

function listRows(
  state: TuiStandingNudgesListState,
  indices: readonly number[],
): readonly string[] {
  const width = Math.max(...state.nudges.map((nudge) => nudge.id.length));
  return indices.map((index) => {
    const nudge = state.nudges[index]!;
    return (
      `${index === state.selectedIndex ? "›" : " "} ${
        nudge.enabled ? "●" : "○"
      } ${nudge.id.padEnd(width)}  ${triggerLabel(nudge.trigger)}${
        nudge.turnsApart === 0 ? "" : ` · every ${nudge.turnsApart} turns`
      }`
    );
  });
}

function visibleListIndices(
  renderer: RenderContext,
  state: TuiStandingNudgesListState,
): readonly number[] {
  const indices = state.nudges.map((_nudge, index) => index);
  return listWindowSlice(
    indices,
    state.selectedIndex,
    Math.max(
      LIST_MIN_ROWS,
      standingNudgeBodyViewportRows(
        renderer,
        standingNudgesCompact(renderer),
        0,
      ),
    ),
  );
}

function standingNudgesCompact(renderer: RenderContext): boolean {
  return renderer.height <= 16;
}

function standingNudgesCardRows(renderer: RenderContext): number {
  return Math.max(
    1,
    renderer.height -
      (renderer.height <= 16 ? 0 : APP_PADDING_TOP) -
      (renderer.height <= 18 ? 0 : dialogInsetBottomOffset(renderer)),
  );
}

const FORM_LABEL_WIDTH = 12;
const MAX_FORM_VALUE_LINES = 4;

interface FormValueLine {
  readonly text: string;
  readonly tone: "value" | "placeholder" | "continuation";
}

interface FormValueWindow {
  readonly first: number;
  readonly rows: number;
}

function plainFormRows(
  state: TuiStandingNudgesFormState,
): readonly string[] {
  return formFields(state).flatMap((field) => {
    const selected = field === state.field;
    if (field === "save") {
      return ["", `${selected ? "›" : " "} ${saveButtonLabel(state)}`];
    }
    const value = fieldValue(state, field);
    return [`${selected ? "›" : " "} ${
      formLabel(state, field).padEnd(FORM_LABEL_WIDTH)
    } ${value}`];
  });
}

export function tuiStandingNudgeFormContent(
  state: TuiStandingNudgesFormState,
  lineWidth: number,
  compact: boolean,
  equalsWindow?: FormValueWindow,
): StyledText {
  const chunks: TextChunk[] = [];
  const prefixWidth = 2 + FORM_LABEL_WIDTH + 1;
  formFields(state).forEach((field, index) => {
    if (index > 0) chunks.push(fg(TUI_TEXT)("\n"));
    const focused = field === state.field;
    if (field === "save") {
      if (!compact) chunks.push(fg(TUI_TEXT)("\n"));
      chunks.push(
        fg(focused ? TUI_ACCENT : TUI_MUTED)(focused ? "›" : " "),
        focused
          ? fg(TUI_SELECTION_TEXT)(bg(TUI_ACCENT)(SAVE_BUTTON_FACE))
          : fg(TUI_TEXT)(bg(TUI_ELEMENT)(SAVE_BUTTON_FACE)),
      );
      if (formHasUnsavedChanges(state)) {
        chunks.push(fg(TUI_NOTICE)(`  ${UNSAVED_CHANGES_LABEL}`));
      }
      return;
    }
    const allLines = formValueLines(state, field, lineWidth, compact);
    const lines = field === "equals" && equalsWindow !== undefined
      ? windowFormValueLines(allLines, equalsWindow)
      : allLines;
    chunks.push(
      fg(focused ? TUI_ACCENT : TUI_MUTED)(focused ? "› " : "  "),
      fg(TUI_MUTED)(
        `${formLabel(state, field).padEnd(FORM_LABEL_WIDTH)} `,
      ),
    );
    appendFormValue(chunks, lines[0] ?? { text: "", tone: "value" });
    for (const line of lines.slice(1)) {
      chunks.push(
        fg(TUI_TEXT)("\n"),
        fg(TUI_MUTED)(" ".repeat(prefixWidth)),
      );
      appendFormValue(chunks, line);
    }
  });
  if (state.error !== undefined) {
    chunks.push(
      fg(TUI_TEXT)(compact ? "\n" : "\n\n"),
      fg(TUI_ACCENT)(
        compact ? compactFormValue(state.error, lineWidth) : state.error,
      ),
    );
  }
  return new StyledText(chunks);
}

function formValueLines(
  state: TuiStandingNudgesFormState,
  field: TuiStandingNudgeFormField,
  lineWidth: number,
  compact: boolean,
): readonly FormValueLine[] {
  const prefixWidth = 2 + FORM_LABEL_WIDTH + 1;
  const valueWidth = Math.max(8, lineWidth - prefixWidth);
  const value = fieldValue(state, field);
  const empty = formTextField(field) && value.length === 0;
  const shown = empty ? formPlaceholder(state, field) : value;
  const wrapped = compact
    ? [compactFormValue(shown, valueWidth)]
    : wrapFormValue(shown, valueWidth);
  return boundedFormValueLines(
    wrapped,
    empty,
    field === state.field,
    field === "text",
  );
}

function windowFormValueLines(
  lines: readonly FormValueLine[],
  window: FormValueWindow,
): readonly FormValueLine[] {
  const rows = Math.max(1, Math.floor(window.rows));
  if (lines.length <= rows) return lines;
  const first = Math.max(
    0,
    Math.min(Math.floor(window.first), lines.length - 1),
  );
  if (rows <= 2) {
    const last = Math.min(lines.length, first + rows);
    return lines.slice(first, last).map((line, index, visible) => ({
      text: `${index === 0 && first > 0 ? "↑ " : ""}${line.text}${
        index === visible.length - 1 && last < lines.length ? " ↓" : ""
      }`,
      tone: line.tone,
    }));
  }
  const hasEarlier = first > 0;
  let valueRows = rows - (hasEarlier ? 1 : 0);
  let last = Math.min(lines.length, first + valueRows);
  const hasMore = last < lines.length;
  if (hasMore) {
    valueRows -= 1;
    last = Math.max(first, Math.min(lines.length, first + valueRows));
  }
  return [
    ...(hasEarlier
      ? [{
        text: `↑ ${first} earlier lines`,
        tone: "continuation" as const,
      }]
      : []),
    ...lines.slice(first, last),
    ...(hasMore
      ? [{
        text: `↓ ${lines.length - last} more lines`,
        tone: "continuation" as const,
      }]
      : []),
  ];
}

function standingNudgeBodyViewportRows(
  renderer: RenderContext,
  dense: boolean,
  hintRows: number,
): number {
  const maxCardRows = standingNudgesCardRows(renderer);
  const fixedRows = 1 + // top padding
    (dense ? 0 : 1) + // bottom padding
    (renderer.height <= 10 ? 1 : 3) + // header
    hintRows +
    (dense ? 0 : 1) + // gap before body
    (dense ? 1 : 2) + // footer node
    (dense ? 0 : 1); // gap before footer
  return Math.max(1, Math.floor(maxCardRows - fixedRows));
}

function appendFormValue(
  chunks: TextChunk[],
  line: FormValueLine,
): void {
  chunks.push(
    line.tone === "placeholder"
      ? italic(fg(TUI_MUTED)(line.text))
      : line.tone === "continuation"
      ? fg(TUI_MUTED)(line.text)
      : fg(TUI_TEXT)(line.text),
  );
}

function boundedFormValueLines(
  lines: readonly string[],
  placeholder: boolean,
  focused: boolean,
  bounded: boolean,
): readonly FormValueLine[] {
  if (!bounded || lines.length <= MAX_FORM_VALUE_LINES) {
    return lines.map((text) => ({
      text,
      tone: placeholder ? "placeholder" : "value",
    }));
  }
  const visibleValues = MAX_FORM_VALUE_LINES - 1;
  const hidden = lines.length - visibleValues;
  if (focused) {
    return [
      { text: `… ${hidden} earlier lines`, tone: "continuation" },
      ...lines.slice(-visibleValues).map((text) => ({
        text,
        tone: "value" as const,
      })),
    ];
  }
  return [
    ...lines.slice(0, visibleValues).map((text) => ({
      text,
      tone: "value" as const,
    })),
    { text: `… ${hidden} more lines`, tone: "continuation" },
  ];
}

function wrapFormValue(value: string, width: number): readonly string[] {
  const lines: string[] = [];
  for (const paragraph of value.split("\n")) {
    if (paragraph.length === 0) {
      lines.push("");
      continue;
    }
    let remaining = paragraph;
    while (remaining.length > width) {
      const breakAfter = Math.max(
        remaining.lastIndexOf("/", width - 1) + 1,
        remaining.lastIndexOf("-", width - 1) + 1,
      );
      const atSpace = remaining.lastIndexOf(" ", width);
      const cut = Math.max(atSpace, breakAfter, 0) || width;
      lines.push(remaining.slice(0, cut).trimEnd());
      remaining = remaining.slice(cut).trimStart();
    }
    lines.push(remaining);
  }
  return lines.length === 0 ? [""] : lines;
}

function compactFormValue(value: string, limit: number): string {
  const oneLine = value.replaceAll("\n", " ↵ ");
  return oneLine.length <= limit
    ? oneLine
    : `${oneLine.slice(0, Math.max(1, limit - 1))}…`;
}

const SAVE_BUTTON_FACE = " Save changes ";
const UNSAVED_CHANGES_LABEL = "Unsaved changes";

function saveButtonLabel(state: TuiStandingNudgesFormState): string {
  const button = SAVE_BUTTON_FACE.trim();
  return formHasUnsavedChanges(state)
    ? `${button}  ${UNSAVED_CHANGES_LABEL}`
    : button;
}

const EMPTY_STANDING_NUDGE_DRAFT: TuiStandingNudgeDraft = {
  id: "",
  text: "",
  enabled: true,
  trigger: "always",
  equals: "",
  turnsApart: 0,
};

function savedDraft(
  state: TuiStandingNudgesFormState,
): TuiStandingNudgeDraft {
  if (state.screen === "create") return EMPTY_STANDING_NUDGE_DRAFT;
  const saved = state.nudges[state.selectedIndex];
  if (saved === undefined) return state.draft;
  return {
    id: saved.id,
    text: saved.text,
    enabled: saved.enabled,
    trigger: saved.trigger.type,
    equals: saved.trigger.type === "always" ? "" : saved.trigger.equals,
    turnsApart: saved.turnsApart,
  };
}

export function formHasUnsavedChanges(
  state: TuiStandingNudgesFormState,
): boolean {
  const saved = savedDraft(state);
  return saved.id !== state.draft.id ||
    saved.text !== state.draft.text ||
    saved.enabled !== state.draft.enabled ||
    saved.trigger !== state.draft.trigger ||
    saved.equals !== state.draft.equals ||
    saved.turnsApart !== state.draft.turnsApart;
}

function formTextField(field: TuiStandingNudgeFormField): boolean {
  return field === "id" || field === "text" || field === "equals";
}

function formStateEditingText(
  state: TuiStandingNudgesState,
): state is TuiStandingNudgesFormState {
  return (state.screen === "create" || state.screen === "edit") &&
    state.editing && formTextField(state.field);
}

function editorTitle(state: TuiStandingNudgesFormState): string {
  return `Edit ${formLabel(state, state.field).toLowerCase()}`;
}

function formNavigationActionHint(
  state: TuiStandingNudgesFormState,
): string {
  if (state.field === "enabled") return "Space toggle · ";
  if (
    state.field === "trigger" || state.field === "turnsApart"
  ) return "Space change · ";
  if (state.field === "save") return "⏎ save · ";
  return "⏎ edit · ";
}

function sanitizeFormPaste(
  field: TuiStandingNudgeFormField,
  text: string,
): string {
  return field === "text"
    ? text.replaceAll("\r\n", "\n").replaceAll("\r", "\n")
      .replaceAll(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    : text.replaceAll(/[\u0000-\u001f\u007f]/g, "");
}

function textareaKey(
  key: TuiStandingNudgesKey,
): Parameters<TextareaRenderable["handleKeyPress"]>[0] {
  return {
    ...key,
    name: key.name === "enter" ? "return" : key.name,
    sequence: key.sequence ?? "",
    ctrl: key.ctrl ?? false,
    meta: key.meta ?? false,
    shift: key.shift ?? false,
    option: false,
    number: false,
    raw: key.sequence ?? "",
    eventType: "press",
    source: "raw",
  } as Parameters<TextareaRenderable["handleKeyPress"]>[0];
}

function formNeedsDenseChrome(
  state: TuiStandingNudgesState,
  lineWidth: number,
): boolean {
  if (state.screen !== "create" && state.screen !== "edit") return false;
  const prefixWidth = 2 + FORM_LABEL_WIDTH + 1;
  const valueWidth = Math.max(8, lineWidth - prefixWidth);
  if (
    wrapFormValue(state.draft.text, valueWidth).length >
      MAX_FORM_VALUE_LINES
  ) {
    return true;
  }
  if (state.draft.trigger === "always") return false;
  return wrapFormValue(state.draft.equals, valueWidth).length >
    MAX_FORM_VALUE_LINES;
}

function formLabel(
  state: TuiStandingNudgesFormState,
  field: TuiStandingNudgeFormField,
): string {
  if (field === "id") return "Name";
  if (field === "text") return "Instruction";
  if (field === "enabled") return "Status";
  if (field === "trigger") return "Apply when";
  if (field === "turnsApart") return "Frequency";
  if (field === "save") return "";
  return state.draft.trigger === "workspace" ? "Workspace" : "Agent";
}

function formPlaceholder(
  state: TuiStandingNudgesFormState,
  field: TuiStandingNudgeFormField,
): string {
  if (field === "id") return "lowercase-name";
  if (field === "text") return "What should Vera keep in mind?";
  if (field === "equals" && state.draft.trigger === "agent") {
    return "exact agent name";
  }
  return "exact workspace path";
}

function triggerTypeLabel(type: StandingNudgeTrigger["type"]): string {
  return type === "always"
    ? "Always"
    : type === "agent"
    ? "Agent"
    : "Workspace";
}

function turnsApartLabel(turnsApart: number): string {
  return turnsApart === 0 ? "Every turn" : `Every ${turnsApart} turns`;
}

function triggerLabel(trigger: StandingNudgeTrigger): string {
  if (trigger.type === "always") return "always";
  if (trigger.type === "agent") return `agent · ${trigger.equals}`;
  return `workspace · ${workspaceLabel(trigger.equals)}`;
}

export interface TuiStandingNudgeIndicatorRow {
  readonly status: string;
  readonly gap: string;
  readonly detail: string;
}

export function standingNudgeIndicatorRow(
  nudges: readonly StandingNudge[],
  match: StandingNudgeMatch,
  width: number,
): TuiStandingNudgeIndicatorRow | undefined {
  const matching = standingNudgeMatches(nudges, match);
  if (matching.length === 0) return undefined;
  let status = matching.length === 1
    ? "Nudge on"
    : `Nudges on · ${matching.length}`;
  const command = "/nudges";
  let separator = " · ";
  let leftWidth = 2 + status.length; // `● ` plus the status label.
  let nameWidth = width - leftWidth - 1 - separator.length - command.length;
  if (nameWidth < 1 && matching.length > 1) {
    status = "Nudges on";
    separator = " ";
    leftWidth = 2 + status.length;
    nameWidth = width - leftWidth - 1 - separator.length - command.length;
  }
  if (nameWidth < 1) {
    status = "On";
    separator = " ";
    leftWidth = 2 + status.length;
    nameWidth = width - leftWidth - 1 - separator.length - command.length;
  }
  if (nameWidth < 1) {
    return {
      status,
      gap: " ".repeat(Math.max(0, width - leftWidth - command.length)),
      detail: command,
    };
  }
  const names = truncateNudgeNames(
    matching.map((nudge) => nudge.id).join(", "),
    nameWidth,
  );
  const detail = `${names}${separator}${command}`;
  return {
    status,
    gap: " ".repeat(Math.max(1, width - leftWidth - detail.length)),
    detail,
  };
}

function truncateNudgeNames(names: string, width: number): string {
  if (names.length <= width) return names;
  if (width <= 1) return "…";
  return `${names.slice(0, width - 1)}…`;
}

export function workspaceStandingNudgeLabel(workspace: string): string {
  const segments = workspace.split(/[\\/]/).filter((segment) =>
    segment.length > 0
  );
  return segments.at(-1) ?? workspace;
}

function workspaceLabel(workspace: string): string {
  return workspaceStandingNudgeLabel(workspace);
}

function clampIndex(index: number, length: number): number {
  return Math.max(0, Math.min(index, length - 1));
}

function modified(key: TuiStandingNudgesKey): boolean {
  return key.ctrl === true || key.meta === true || key.super === true ||
    key.hyper === true || key.shift === true;
}

function formTabStep(key: TuiStandingNudgesKey): -1 | 1 | undefined {
  if (key.name === "backtab") return -1;
  if (key.name !== "tab") return undefined;
  return key.shift === true ? -1 : 1;
}

function commandModified(key: TuiStandingNudgesKey): boolean {
  return key.ctrl === true || key.meta === true || key.super === true ||
    key.hyper === true;
}
