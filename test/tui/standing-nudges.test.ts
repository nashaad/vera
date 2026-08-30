import { afterEach, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createTuiStandingNudgesView,
  handleTuiStandingNudgesKey,
  handleTuiStandingNudgesPaste,
  openTuiStandingNudges,
  renderTuiStandingNudges,
  standingNudgeIndicatorRow,
  tuiStandingNudgeFormContent,
  type TuiStandingNudgesState,
  workspaceStandingNudgeLabel,
} from "../../clients/tui/standing-nudges.ts";
import {
  dialogInsetBottomOffset,
  dialogInsetTop,
} from "../../clients/tui/dialog-chrome.ts";
import {
  loadStandingNudges,
  saveStandingNudges,
  type StandingNudge,
  standingNudgesPath,
} from "../../src/standing-nudges.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function profile(): string {
  const directory = mkdtempSync(join(tmpdir(), "vera-standing-nudges-ui-"));
  temporaryDirectories.push(directory);
  return directory;
}

function nudge(
  id: string,
  trigger: StandingNudge["trigger"] = { type: "always" },
  enabled = true,
  turnsApart = 0,
): StandingNudge {
  return { id, enabled, text: `${id} text`, trigger, turnsApart };
}

function listState(state: TuiStandingNudgesState) {
  expect(state.screen).toBe("list");
  if (state.screen !== "list") throw new Error("expected list state");
  return state;
}

function key(
  state: TuiStandingNudgesState,
  name: string,
  sequence?: string,
): TuiStandingNudgesState {
  const transition = handleTuiStandingNudgesKey(state, {
    name,
    ...(sequence === undefined ? {} : { sequence }),
  });
  expect(transition.handled).toBe(true);
  if (transition.state === undefined) throw new Error("overlay closed");
  return transition.state;
}

function beginEdit(state: TuiStandingNudgesState): TuiStandingNudgesState {
  const editing = key(state, "enter");
  expect(
    (editing.screen === "create" || editing.screen === "edit") &&
      editing.editing,
  ).toBe(true);
  return editing;
}

function finishEdit(state: TuiStandingNudgesState): TuiStandingNudgesState {
  return key(state, "escape");
}

function saveForm(state: TuiStandingNudgesState): TuiStandingNudgesState {
  for (let remaining = 0; remaining < 8; remaining += 1) {
    if (
      (state.screen === "create" || state.screen === "edit") &&
      state.field === "save"
    ) {
      return key(state, "enter");
    }
    state = key(state, "down");
  }
  throw new Error("Save changes row not found");
}

test("the monochrome list carries selection, enabled state, and trigger labels", () => {
  const directory = profile();
  saveStandingNudges(directory, [
    nudge("concise"),
    nudge("teach-go", {
      type: "workspace",
      equals: "/Users/nash/Projects/vera",
    }),
    nudge("strict-review", { type: "agent", equals: "reviewer" }, false),
  ]);
  let state = openTuiStandingNudges(directory, "/Users/nash/Projects/vera");
  state = key(state, "down");
  expect(renderTuiStandingNudges(state)).toBe([
    "Standing nudges",
    "",
    "  ● concise        always",
    "› ● teach-go       workspace · vera",
    "  ○ strict-review  agent · reviewer",
    "",
    "Space toggle · Enter edit · n new · d delete · esc close",
  ].join("\n"));
});

test("the empty list is explicit and still offers creation", () => {
  const state = openTuiStandingNudges(profile(), "/workspace");
  expect(renderTuiStandingNudges(state)).toBe([
    "Standing nudges",
    "",
    "No standing nudges",
    "",
    "n new · esc close",
  ].join("\n"));
});

test("the composer indicator counts enabled rules matching this conversation", () => {
  const nudges = [
    nudge("always"),
    nudge("here", { type: "workspace", equals: "/workspace" }),
    nudge("elsewhere", { type: "workspace", equals: "/elsewhere" }),
    nudge("disabled", { type: "always" }, false),
  ];
  expect(standingNudgeIndicatorRow(nudges, {
    agent: "default",
    workspace: "/workspace",
  }, 50)).toEqual({
    status: "Nudges on · 2",
    gap: " ".repeat(13),
    detail: "always, here · /nudges",
  });
  expect(standingNudgeIndicatorRow([nudge("always")], {
    agent: "default",
    workspace: "/workspace",
  }, 40)).toEqual({
    status: "Nudge on",
    gap: " ".repeat(14),
    detail: "always · /nudges",
  });
  expect(standingNudgeIndicatorRow([
    nudge("elsewhere", { type: "workspace", equals: "/elsewhere" }),
  ], {
    agent: "default",
    workspace: "/workspace",
  }, 40)).toBeUndefined();
  expect(standingNudgeIndicatorRow(nudges, {
    agent: "default",
    workspace: "/workspace",
  }, 32)).toEqual({
    status: "Nudges on · 2",
    gap: " ",
    detail: "alway… · /nudges",
  });
  expect(standingNudgeIndicatorRow(nudges, {
    agent: "default",
    workspace: "/workspace",
  }, 22)).toEqual({
    status: "Nudges on",
    gap: " ",
    detail: "a… /nudges",
  });
});

test("Space saves before returning the toggled list", () => {
  const directory = profile();
  saveStandingNudges(directory, [nudge("concise")]);
  const opened = listState(openTuiStandingNudges(directory, "/workspace"));
  const toggled = listState(key(opened, "space"));
  expect(toggled.nudges[0]?.enabled).toBe(false);
  expect(loadStandingNudges(directory)[0]?.enabled).toBe(false);
  expect(renderTuiStandingNudges(toggled)).toContain("› ○ concise");
});

test("create collects each field and a workspace trigger defaults to the full path", () => {
  const directory = profile();
  const workspace = "/Users/nash/Projects/vera";
  let state = key(openTuiStandingNudges(directory, workspace), "n");
  state = beginEdit(state);
  for (const character of "teach-go") state = key(state, character);
  state = key(state, "enter");
  state = key(state, "down");
  state = beginEdit(state);
  state = handleTuiStandingNudgesPaste(
    state,
    "Explain Go idioms.\nKeep it brief.",
  );
  state = finishEdit(state);
  state = key(state, "down");
  expect(renderTuiStandingNudges(state)).toContain("Status       Active");
  state = key(state, "down");
  // Space cycles Always → Agent → Workspace and seeds the session realpath.
  state = key(state, "space");
  state = key(state, "space");
  expect(renderTuiStandingNudges(state)).toContain(workspace);
  state = saveForm(state);

  const saved = loadStandingNudges(directory);
  expect(saved).toEqual([{
    id: "teach-go",
    enabled: true,
    text: "Explain Go idioms.\nKeep it brief.",
    trigger: { type: "workspace", equals: workspace },
    turnsApart: 0,
  }]);
  expect(listState(state).selectedIndex).toBe(0);
});

test("arrow keys move both directions through a form", () => {
  let state = key(openTuiStandingNudges(profile(), "/workspace"), "n");
  expect(state.screen).toBe("create");
  if (state.screen !== "create") throw new Error("expected create state");
  expect(state.field).toBe("id");
  state = key(state, "down");
  expect(state.screen).toBe("create");
  if (state.screen !== "create") throw new Error("expected create state");
  expect(state.field).toBe("text");
  const transition = handleTuiStandingNudgesKey(state, { name: "up" });
  expect(transition.handled).toBe(true);
  expect(transition.state?.screen).toBe("create");
  if (transition.state?.screen !== "create") {
    throw new Error("expected create state");
  }
  expect(transition.state.field).toBe("id");
});

test("the form exposes Active and Inactive status on create and edit", () => {
  const directory = profile();
  let state = key(openTuiStandingNudges(directory, "/workspace"), "n");
  state = beginEdit(state);
  for (const character of "quiet") state = key(state, character);
  state = key(state, "enter");
  state = key(state, "down");
  state = beginEdit(state);
  state = handleTuiStandingNudgesPaste(state, "Keep the response quiet.");
  state = finishEdit(state);
  state = key(state, "down");
  expect(renderTuiStandingNudges(state)).toContain("Status       Active");
  state = key(state, "space");
  expect(renderTuiStandingNudges(state)).toContain("Status       Inactive");
  state = saveForm(state);
  expect(loadStandingNudges(directory)[0]?.enabled).toBe(false);

  state = key(openTuiStandingNudges(directory, "/workspace"), "enter");
  state = key(state, "down");
  expect(renderTuiStandingNudges(state)).toContain("Status       Inactive");
  state = key(state, "space");
  state = saveForm(state);
  expect(loadStandingNudges(directory)[0]?.enabled).toBe(true);
});

test("choice rows use Space while horizontal arrows leave values alone", () => {
  let state = key(openTuiStandingNudges(profile(), "/workspace"), "n");
  state = key(state, "down");
  state = key(state, "down");
  expect(renderTuiStandingNudges(state)).toContain(
    "Space toggle · ↑↓ field · esc back",
  );
  state = key(state, "left");
  state = key(state, "right");
  expect(renderTuiStandingNudges(state)).toContain("Status       Active");
  state = key(state, "space");
  expect(renderTuiStandingNudges(state)).toContain("Status       Inactive");

  state = key(state, "down");
  expect(renderTuiStandingNudges(state)).toContain(
    "Space change · ↑↓ field · esc back",
  );
  state = key(state, "left");
  state = key(state, "right");
  expect(renderTuiStandingNudges(state)).toContain("Apply when   Always");
  state = key(state, "space");
  expect(renderTuiStandingNudges(state)).toContain("Apply when   Agent");
});

test("frequency cycles from every turn through two to ten turns", () => {
  const directory = profile();
  saveStandingNudges(directory, [nudge("cadence")]);
  let state = key(openTuiStandingNudges(directory, "/workspace"), "enter");
  for (let step = 0; step < 3; step += 1) state = key(state, "down");
  expect(renderTuiStandingNudges(state)).toContain(
    "Frequency    Every turn",
  );
  expect(renderTuiStandingNudges(state)).toContain(
    "Space change · ↑↓ field · esc back",
  );
  state = key(state, "space");
  expect(renderTuiStandingNudges(state)).toContain(
    "Frequency    Every 2 turns",
  );
  state = key(state, "space");
  expect(renderTuiStandingNudges(state)).toContain(
    "Frequency    Every 3 turns",
  );
  for (let turnsApart = 4; turnsApart <= 10; turnsApart += 1) {
    state = key(state, "space");
  }
  expect(renderTuiStandingNudges(state)).toContain(
    "Frequency    Every 10 turns",
  );
  state = saveForm(state);
  expect(loadStandingNudges(directory)[0]?.turnsApart).toBe(10);
  expect(renderTuiStandingNudges(state)).toContain("every 10 turns");
});

test("typing in navigation mode does not change a text field", () => {
  let state = key(openTuiStandingNudges(profile(), "/workspace"), "n");
  state = key(state, "p", "p");
  expect(state.screen === "create" ? state.draft.id : undefined).toBe("");
  expect(renderTuiStandingNudges(state)).toContain(
    "⏎ edit · ↑↓ field · esc back",
  );
});

test("empty examples are styled placeholders and never become hidden input", () => {
  let state = key(openTuiStandingNudges(profile(), "/workspace"), "n");
  expect(renderTuiStandingNudges(state)).not.toContain("concise");
  state = beginEdit(state);
  state = key(state, "backspace");
  for (const character of "pirate") state = key(state, character);
  expect(renderTuiStandingNudges(state)).toContain("Name         pirate");
  expect(renderTuiStandingNudges(state)).toContain("←→ move · ⏎ done");
  expect(renderTuiStandingNudges(state)).not.toContain("concise");

  if (state.screen !== "create") throw new Error("expected create state");
  const styled = tuiStandingNudgeFormContent(state, 60, false);
  const value = styled.chunks.find((chunk) => chunk.text.includes("pirate"));
  expect(value?.attributes ?? 0).toBe(0);
  state = key(state, "backspace");
  expect(renderTuiStandingNudges(state)).toContain("Name         pirat");

  const empty = key(openTuiStandingNudges(profile(), "/workspace"), "n");
  if (empty.screen !== "create") throw new Error("expected create state");
  const placeholder = tuiStandingNudgeFormContent(empty, 60, false).chunks
    .find((chunk) => chunk.text.includes("lowercase-name"));
  expect(placeholder?.attributes ?? 0).not.toBe(0);
});

test("shifted characters type into text fields", () => {
  let state = key(openTuiStandingNudges(profile(), "/workspace"), "n");
  state = key(state, "down");
  state = beginEdit(state);
  const transition = handleTuiStandingNudgesKey(state, {
    name: "S",
    sequence: "S",
    shift: true,
  });
  expect(transition.handled).toBe(true);
  expect(
    transition.state === undefined
      ? ""
      : renderTuiStandingNudges(transition.state),
  ).toContain(
    "Instruction  S",
  );
});

test("editing never offers or changes the id and shows a full workspace path", () => {
  const directory = profile();
  const workspace = "/Users/nash/Projects/vera";
  saveStandingNudges(directory, [
    nudge("teach-go", { type: "workspace", equals: workspace }),
  ]);
  let state = key(openTuiStandingNudges(directory, workspace), "enter");
  const rendered = renderTuiStandingNudges(state);
  expect(rendered).toContain("Edit teach-go");
  expect(rendered).toContain(workspace);
  expect(rendered).not.toContain("  Name");
  state = beginEdit(state);
  state = handleTuiStandingNudgesPaste(state, " plus Python comparisons");
  state = finishEdit(state);
  state = saveForm(state);
  expect(loadStandingNudges(directory)[0]).toMatchObject({
    id: "teach-go",
    text: "teach-go text plus Python comparisons",
  });
});

test("delete uses a second screen, Enter confirms, and Escape only goes back", () => {
  const directory = profile();
  saveStandingNudges(directory, [nudge("concise")]);
  const list = openTuiStandingNudges(directory, "/workspace");
  let confirmation = key(list, "d");
  expect(renderTuiStandingNudges(confirmation)).toBe([
    "Delete concise?",
    "",
    "This cannot be undone.",
    "",
    "⏎ delete · esc back",
  ].join("\n"));
  expect(listState(key(confirmation, "escape")).nudges).toHaveLength(1);

  confirmation = key(list, "d");
  expect(listState(key(confirmation, "enter")).nudges).toEqual([]);
  expect(loadStandingNudges(directory)).toEqual([]);
});

test("a malformed profile is an error screen and can retry after repair", () => {
  const directory = profile();
  writeFileSync(standingNudgesPath(directory), "not json");
  let state = openTuiStandingNudges(directory, "/workspace");
  expect(state.screen).toBe("error");
  const rendered = renderTuiStandingNudges(state);
  expect(rendered).toContain(standingNudgesPath(directory));
  expect(rendered).toContain("not valid JSON");
  expect(rendered.split(standingNudgesPath(directory))).toHaveLength(2);
  expect(rendered).not.toContain("No standing nudges");
  expect(rendered).toContain("⏎ retry · esc close");

  writeFileSync(
    standingNudgesPath(directory),
    '{"schema_version":1,"nudges":[]}',
  );
  state = key(state, "enter");
  expect(state.screen).toBe("list");
});

test("a failed immediate save stays unapplied and can retry", () => {
  const directory = profile();
  saveStandingNudges(directory, [nudge("concise")]);
  let state = openTuiStandingNudges(directory, "/workspace");
  rmSync(directory, { recursive: true });
  writeFileSync(directory, "blocks the profile directory");

  state = key(state, "space");
  expect(state.screen).toBe("error");
  const failed = renderTuiStandingNudges(state);
  expect(failed).toContain(
    "Standing nudges could not be saved",
  );
  expect(failed.split(standingNudgesPath(directory))).toHaveLength(2);
  expect(
    state.screen === "error" && state.back?.screen === "list"
      ? state.back.nudges[0]?.enabled
      : undefined,
  ).toBe(true);

  rmSync(directory);
  mkdirSync(directory);
  state = key(state, "enter");
  expect(listState(state).nudges[0]?.enabled).toBe(false);
  expect(loadStandingNudges(directory)[0]?.enabled).toBe(false);
});

test("a filesystem save failure never leaks a path into the form", () => {
  const directory = profile();
  saveStandingNudges(directory, [nudge("concise")]);
  let state = key(
    openTuiStandingNudges(directory, "/workspace"),
    "enter",
  );
  for (let step = 0; step < 4; step += 1) state = key(state, "down");
  expect(state.screen === "edit" && state.field).toBe("save");

  const backup = `${directory}-saved`;
  renameSync(directory, backup);
  writeFileSync(directory, "blocks the profile directory");
  state = key(state, "enter");
  const failed = renderTuiStandingNudges(state);
  expect(state.screen).toBe("edit");
  expect(failed).toContain("Could not save changes.");
  expect(failed).not.toContain(directory);
  expect(failed).not.toContain("standing-nudges.json");

  rmSync(directory);
  renameSync(backup, directory);
  expect(loadStandingNudges(directory)[0]?.text).toBe("concise text");
});

test("a refused create remains editable with a local actionable error", () => {
  const directory = profile();
  let state = key(openTuiStandingNudges(directory, "/workspace"), "n");
  state = saveForm(state);
  expect(state.screen).toBe("create");
  expect(renderTuiStandingNudges(state)).toContain(
    "Name the nudge before saving.",
  );
  expect(renderTuiStandingNudges(state)).not.toContain(
    standingNudgesPath(directory),
  );

  state = key(state, "down");
  state = beginEdit(state);
  for (const character of "concise") state = key(state, character);
  state = key(state, "enter");
  state = key(state, "down");
  state = beginEdit(state);
  state = handleTuiStandingNudgesPaste(state, "Answer concisely.");
  state = finishEdit(state);
  state = saveForm(state);
  expect(listState(state).nudges[0]?.id).toBe("concise");
});

test("blank and five-line instructions get short form errors", () => {
  const directory = profile();
  saveStandingNudges(directory, [nudge("concise")]);
  let state = key(
    openTuiStandingNudges(directory, "/workspace"),
    "enter",
  );
  state = beginEdit(state);
  for (const _character of "concise text") state = key(state, "backspace");
  state = finishEdit(state);
  state = saveForm(state);
  const blank = renderTuiStandingNudges(state);
  expect(blank).toContain("Add an instruction before saving.");
  expect(blank).not.toContain(standingNudgesPath(directory));
  expect(blank).not.toContain("nudges[0]");

  state = key(state, "down");
  state = beginEdit(state);
  state = handleTuiStandingNudgesPaste(
    state,
    "one\ntwo\nthree\nfour\nfive",
  );
  state = finishEdit(state);
  state = saveForm(state);
  expect(renderTuiStandingNudges(state)).toContain(
    "Keep the instruction to 4 lines or fewer.",
  );
  expect(loadStandingNudges(directory)[0]?.text).toBe("concise text");
});

test("workspace labels use only the last non-empty segment", () => {
  expect(workspaceStandingNudgeLabel("/Users/nash/Projects/vera/")).toBe(
    "vera",
  );
  expect(workspaceStandingNudgeLabel("C:\\Projects\\vera")).toBe("vera");
});

test("the OpenTUI view preserves the plain selection and status markers", async () => {
  const directory = profile();
  saveStandingNudges(directory, [
    nudge("concise"),
    nudge("disabled", { type: "always" }, false),
  ]);
  const setup = await createTestRenderer({ width: 80, height: 24 });
  const view = createTuiStandingNudgesView(setup.renderer);
  setup.renderer.root.add(view.box);
  view.box.visible = true;
  try {
    view.update(openTuiStandingNudges(directory, "/workspace"));
    await setup.flush();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("Standing nudges");
    expect(frame).toContain("› ● concise");
    expect(frame).toContain("○ disabled");
    expect(frame).toContain("Space toggle · Enter edit");
  } finally {
    setup.renderer.destroy();
  }
});

test("the OpenTUI view uses the shared inset dialog geometry", async () => {
  const setup = await createTestRenderer({ width: 80, height: 32 });
  const view = createTuiStandingNudgesView(setup.renderer);
  try {
    expect(view.surface).toBe(view.box);
    expect(view.box.top).toBe(dialogInsetTop(setup.renderer));
    expect(dialogInsetBottomOffset(setup.renderer)).toBeGreaterThan(1);
  } finally {
    setup.renderer.destroy();
  }
});

test("Enter opens a real cursor editor and Save changes commits it", async () => {
  const directory = profile();
  saveStandingNudges(directory, [{
    id: "cursor-edit",
    enabled: true,
    text: "abcdef",
    trigger: { type: "always" },
    turnsApart: 0,
  }]);
  let state = beginEdit(
    key(openTuiStandingNudges(directory, "/workspace"), "enter"),
  );
  const setup = await createTestRenderer({ width: 80, height: 24 });
  const view = createTuiStandingNudgesView(setup.renderer);
  setup.renderer.root.add(view.box);
  view.box.visible = true;
  try {
    view.update(state);
    view.focus();
    await setup.flush();
    const editingFrame = setup.captureCharFrame();
    expect(editingFrame).toContain("Edit instruction");
    expect(editingFrame).toContain("4 lines max");

    for (
      const editorKey of [
        { name: "left" },
        { name: "left" },
        { name: "backspace" },
        { name: "X", sequence: "X", shift: true },
      ]
    ) {
      const transition = view.handleEditorKey(state, editorKey);
      expect(transition.handled).toBe(true);
      if (transition.state === undefined) {
        throw new Error("editor unexpectedly closed");
      }
      state = transition.state;
      view.update(state);
    }
    expect(
      state.screen === "edit" ? state.draft.text : undefined,
    ).toBe("abcXef");

    const done = view.handleEditorKey(state, { name: "escape" });
    expect(done.state?.screen).toBe("edit");
    if (done.state === undefined) {
      throw new Error("form unexpectedly closed");
    }
    state = done.state;
    expect(state.screen === "edit" && state.editing).toBe(false);
    state = saveForm(state);
    expect(loadStandingNudges(directory)[0]?.text).toBe("abcXef");
  } finally {
    setup.renderer.destroy();
  }
});

test("a short-terminal form keeps every field and its footer visible", async () => {
  let state = key(openTuiStandingNudges(profile(), "/workspace"), "n");
  state = beginEdit(state);
  for (const character of "compact") state = key(state, character);
  state = key(state, "enter");
  state = key(state, "down");
  state = beginEdit(state);
  state = handleTuiStandingNudgesPaste(
    state,
    "first line\nsecond line\nthird line\nfourth line",
  );
  state = finishEdit(state);
  const setup = await createTestRenderer({ width: 60, height: 12 });
  const view = createTuiStandingNudgesView(setup.renderer);
  setup.renderer.root.add(view.box);
  view.box.visible = true;
  try {
    view.update(state);
    await setup.flush();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("Name");
    expect(frame).toContain("Instruction");
    expect(frame).toContain("↵");
    expect(frame).toContain("Status");
    expect(frame).toContain("Apply when");
    expect(frame).toContain("Frequency");
    expect(frame).toContain("Save changes");
    expect(frame).toContain("⏎ edit · ↑↓ field");
    expect(frame).toContain("back");
  } finally {
    setup.renderer.destroy();
  }
});

test("a long instruction stays bounded while Status and Apply when remain visible", async () => {
  let state = key(openTuiStandingNudges(profile(), "/workspace"), "n");
  state = beginEdit(state);
  for (const character of "long-form") state = key(state, character);
  state = key(state, "enter");
  state = key(state, "down");
  state = beginEdit(state);
  state = handleTuiStandingNudgesPaste(
    state,
    Array.from({ length: 20 }, (_unused, index) => `line ${index + 1}`)
      .join("\n"),
  );
  state = finishEdit(state);
  const setup = await createTestRenderer({ width: 80, height: 24 });
  const view = createTuiStandingNudgesView(setup.renderer);
  setup.renderer.root.add(view.box);
  view.box.visible = true;
  try {
    view.update(state);
    await setup.flush();
    let frame = setup.captureCharFrame();
    expect(frame).toContain("earlier lines");
    expect(frame).toContain("line 20");
    expect(frame).toContain("Status       Active");
    expect(frame).toContain("Apply when   Always");
    expect(frame).toContain("Save changes");
    expect(frame).toContain("⏎ edit · ↑↓ field · esc back");

    state = key(state, "down");
    view.update(state);
    await setup.flush();
    frame = setup.captureCharFrame();
    expect(frame).toContain("more lines");
    expect(frame).toContain("› Status       Active");
    expect(frame).toContain("Apply when   Always");
  } finally {
    setup.renderer.destroy();
  }
});

test("a 17-row form keeps Apply when below a long instruction", async () => {
  let state = key(openTuiStandingNudges(profile(), "/workspace"), "n");
  state = beginEdit(state);
  for (const character of "long-form") state = key(state, character);
  state = key(state, "enter");
  state = key(state, "down");
  state = beginEdit(state);
  state = handleTuiStandingNudgesPaste(
    state,
    Array.from({ length: 20 }, (_unused, index) => `line ${index + 1}`)
      .join("\n"),
  );
  state = finishEdit(state);
  const setup = await createTestRenderer({ width: 80, height: 17 });
  const view = createTuiStandingNudgesView(setup.renderer);
  setup.renderer.root.add(view.box);
  view.box.visible = true;
  try {
    view.update(state);
    await setup.flush();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("earlier lines");
    expect(frame).toContain("Status       Active");
    expect(frame).toContain("Apply when   Always");
    expect(frame).toContain("Save changes");
    expect(frame).toContain("⏎ edit · ↑↓ field · esc back");
  } finally {
    setup.renderer.destroy();
  }
});

test("a normal-height OpenTUI edit view shows the complete workspace path", async () => {
  const directory = profile();
  const workspace =
    "/Users/nash/Projects/a-very-long-workspace-directory-name-that-must-remain-visible";
  saveStandingNudges(directory, [
    nudge("workspace-rule", { type: "workspace", equals: workspace }),
  ]);
  const state = key(openTuiStandingNudges(directory, workspace), "enter");
  const setup = await createTestRenderer({ width: 80, height: 24 });
  const view = createTuiStandingNudgesView(setup.renderer);
  setup.renderer.root.add(view.box);
  view.box.visible = true;
  try {
    view.update(state);
    await setup.flush();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("/Users/nash/Projects/a-very-long-");
    expect(frame).toContain("workspace-directory-name-that-must-");
    expect(frame).toContain("remain-visible");
    expect(frame).not.toContain("…");
  } finally {
    setup.renderer.destroy();
  }
});

test("a workspace path longer than four wrapped lines remains complete", async () => {
  const directory = profile();
  const workspace = "/Users/nash/Projects/" + Array.from(
    { length: 12 },
    (_unused, index) => `segment${String(index + 1).padStart(2, "0")}abcdefgh`,
  ).join("/");
  saveStandingNudges(directory, [
    nudge(
      "deep-workspace",
      { type: "workspace", equals: workspace },
      false,
    ),
  ]);
  const state = key(openTuiStandingNudges(directory, workspace), "enter");
  const setup = await createTestRenderer({ width: 80, height: 24 });
  const view = createTuiStandingNudgesView(setup.renderer);
  setup.renderer.root.add(view.box);
  view.box.visible = true;
  try {
    view.update(state);
    await setup.flush();
    const frame = setup.captureCharFrame();
    expect(frame.replaceAll(/\s+/g, "")).toContain(workspace);
    expect(frame).toContain("Status       Inactive");
    expect(frame).toContain("Apply when   Workspace");
    expect(frame).toContain("Save changes");
    expect(frame).toContain("⏎ edit · ↑↓ field · esc back");
    expect(frame).not.toContain("earlier lines");
    expect(frame).not.toContain("more lines");
  } finally {
    setup.renderer.destroy();
  }
});

test("an exceptionally deep workspace match scrolls without hiding controls", async () => {
  const directory = profile();
  const workspace = "/Users/nash/Projects/" + Array.from(
    { length: 30 },
    (_unused, index) => `segment${String(index + 1).padStart(2, "0")}abcdefgh`,
  ).join("/");
  saveStandingNudges(directory, [
    nudge(
      "deep-workspace",
      { type: "workspace", equals: workspace },
      false,
    ),
  ]);
  let state = key(openTuiStandingNudges(directory, workspace), "enter");
  const setup = await createTestRenderer({ width: 80, height: 24 });
  const view = createTuiStandingNudgesView(setup.renderer);
  setup.renderer.root.add(view.box);
  view.box.visible = true;
  try {
    view.update(state);
    await setup.flush();
    let frame = setup.captureCharFrame();
    expect(frame).toContain("segment01abcdefgh");
    expect(frame).toContain("more lines");
    expect(frame).toContain("Status       Inactive");
    expect(frame).toContain("Apply when   Workspace");
    expect(frame).toContain("pgup/pgdn match");
    expect(frame).toContain("Save changes");
    expect(frame).toContain("⏎ edit · pgup/pgdn match");

    state = key(state, "down");
    view.update(state);
    await setup.flush();
    frame = setup.captureCharFrame();
    expect(frame).toContain("Space toggle · pgup/pgdn match");

    state = key(state, "down");
    view.update(state);
    await setup.flush();
    frame = setup.captureCharFrame();
    expect(frame).toContain("Space change · pgup/pgdn match");

    for (let page = 0; page < 100; page += 1) {
      expect(view.handleViewportKey("pagedown")).toBe(true);
    }
    await setup.flush();
    frame = setup.captureCharFrame();
    expect(frame).toContain("earlier lines");
    expect(frame).toContain("segment30abcdefgh");
    expect(frame).toContain("Status       Inactive");
    expect(frame).toContain("Apply when   Workspace");
    expect(frame).toContain("Save changes");
    expect(frame).toContain("Space change · pgup/pgdn match");
    expect(frame).toContain("esc back");
  } finally {
    setup.renderer.destroy();
  }
});

test("intermediate terminal heights page deep matches in whole rows", async () => {
  const directory = profile();
  const workspace = "/Users/nash/Projects/" + Array.from(
    { length: 60 },
    (_unused, index) => `segment${String(index + 1).padStart(2, "0")}abcdefgh`,
  ).join("/");
  saveStandingNudges(directory, [
    nudge(
      "deep-workspace",
      { type: "workspace", equals: workspace },
      false,
    ),
  ]);
  const state = key(openTuiStandingNudges(directory, workspace), "enter");

  for (const height of [17, 18]) {
    const setup = await createTestRenderer({ width: 80, height });
    const view = createTuiStandingNudgesView(setup.renderer);
    setup.renderer.root.add(view.box);
    view.box.visible = true;
    try {
      view.update(state);
      await setup.flush();
      let frame = setup.captureCharFrame();
      expect(frame).toContain("segment01abcdefgh");
      expect(frame).toMatch(/↓ \d+ more lines/);
      expect(frame).not.toMatch(/[↑↓] \d+\.\d+/);
      expect(frame).toContain("Status       Inactive");
      expect(frame).toContain("Apply when   Workspace");
      expect(frame).toContain("pgup/pgdn match");
      expect(frame).toContain("Save changes");
      expect(frame).toContain("⏎ edit · pgup/pgdn match");

      for (let page = 0; page < 100; page += 1) {
        expect(view.handleViewportKey("pagedown")).toBe(true);
      }
      await setup.flush();
      frame = setup.captureCharFrame();
      expect(frame).toMatch(/↑ \d+ earlier lines/);
      expect(frame).not.toMatch(/[↑↓] \d+\.\d+/);
      expect(frame).toContain("segment60abcdefgh");
      expect(frame).toContain("Status       Inactive");
      expect(frame).toContain("Apply when   Workspace");
      expect(frame).toContain("pgup/pgdn match");
      expect(frame).toContain("Save changes");
      expect(frame).toContain("⏎ edit · pgup/pgdn match");
    } finally {
      setup.renderer.destroy();
    }
  }
});

test("a two-row match viewport always shows editable match text", async () => {
  const directory = profile();
  const workspace = "/Users/nash/Projects/" + Array.from(
    { length: 100 },
    (_unused, index) => `segment${String(index + 1).padStart(2, "0")}abcdefgh`,
  ).join("/");
  saveStandingNudges(directory, [{
    id: "combined-overflow",
    enabled: false,
    text: Array.from(
      { length: 4 },
      (_unused, index) => `line ${index + 1} ${"instruction ".repeat(20)}`,
    ).join("\n"),
    trigger: { type: "workspace", equals: workspace },
    turnsApart: 0,
  }]);
  let state = key(openTuiStandingNudges(directory, workspace), "enter");
  const setup = await createTestRenderer({ width: 80, height: 17 });
  const view = createTuiStandingNudgesView(setup.renderer);
  setup.renderer.root.add(view.box);
  view.box.visible = true;
  try {
    view.update(state);
    await setup.flush();
    expect(view.handleViewportKey("pagedown")).toBe(true);
    await setup.flush();
    let frame = setup.captureCharFrame();
    expect(frame).toContain("segment02abcdefgh");
    expect(frame).not.toMatch(/Workspace\s+↑ \d+ earlier lines/);
    expect(frame).not.toContain("more lines▏");
    expect(frame).toContain("Status       Inactive");
    expect(frame).toContain("Apply when   Workspace");
    expect(frame).toContain("Save changes");
    expect(frame).toContain("⏎ edit · pgup/pgdn match");

    state = key(state, "down");
    state = key(state, "down");
    state = key(state, "down");
    view.update(state);
    await setup.flush();
    frame = setup.captureCharFrame();
    expect(frame).toContain("segment100abcdefgh");
    expect(frame).not.toContain("more lines▏");
    expect(frame).toContain("Status       Inactive");
    expect(frame).toContain("Apply when   Workspace");
    expect(frame).toContain("Save changes");
    expect(frame).toContain("⏎ edit · pgup/pgdn match");
  } finally {
    setup.renderer.destroy();
  }
});

test("a long rendered list windows around the cursor and keeps its footer", async () => {
  const directory = profile();
  saveStandingNudges(
    directory,
    Array.from({ length: 32 }, (_unused, index) => nudge(`rule-${index}`)),
  );
  let state = openTuiStandingNudges(directory, "/workspace");
  for (let index = 1; index < 32; index += 1) state = key(state, "down");
  const setup = await createTestRenderer({ width: 80, height: 18 });
  const view = createTuiStandingNudgesView(setup.renderer);
  setup.renderer.root.add(view.box);
  view.box.visible = true;
  try {
    view.update(state);
    await setup.flush();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("› ● rule-31");
    expect(frame).not.toContain("rule-0 ");
    expect(frame).toContain("Space toggle · Enter edit");
  } finally {
    setup.renderer.destroy();
  }
});
