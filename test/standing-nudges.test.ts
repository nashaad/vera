import { afterAll, expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadStandingNudges,
  MAX_STANDING_NUDGE_TEXT_LINES,
  MAX_STANDING_NUDGES,
  saveStandingNudges,
  type StandingNudge,
  standingNudgeContribution,
  standingNudgeMatchCount,
  StandingNudgesError,
  standingNudgesPath,
} from "../src/standing-nudges.ts";

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function profile(): string {
  const root = mkdtempSync(join(tmpdir(), "vera-standing-nudges-"));
  roots.push(root);
  return root;
}

function always(
  id: string,
  text = `Text for ${id}`,
  enabled = true,
): StandingNudge {
  return { id, enabled, text, trigger: { type: "always" }, turnsApart: 0 };
}

test("a missing profile file is empty and profiles stay isolated", () => {
  const profileA = profile();
  const profileB = profile();
  expect(loadStandingNudges(profileA)).toEqual([]);
  expect(loadStandingNudges(profileB)).toEqual([]);

  saveStandingNudges(profileA, [always("concise", "Be concise.")]);
  expect(loadStandingNudges(profileA)).toHaveLength(1);
  expect(loadStandingNudges(profileB)).toEqual([]);
  expect(standingNudgeContribution(loadStandingNudges(profileB), {
    agent: "default",
    workspace: "/work",
  })).toBeUndefined();
});

test("save normalizes text and equals, writes schema 1 atomically at mode 0600", () => {
  const directory = profile();
  const saved = saveStandingNudges(directory, [{
    id: "teach-go",
    enabled: true,
    text: "  Compare Go with Python.  ",
    trigger: { type: "workspace", equals: "  /work/vera  " },
    turnsApart: 2,
  }]);
  expect(saved).toEqual([{
    id: "teach-go",
    enabled: true,
    text: "Compare Go with Python.",
    trigger: { type: "workspace", equals: "/work/vera" },
    turnsApart: 2,
  }]);
  const path = standingNudgesPath(directory);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
    schema_version: 1,
    nudges: saved,
  });
  expect(loadStandingNudges(directory)).toEqual(saved);
});

test("load and save normalize CRLF and bare CR to LF-only contribution bytes", () => {
  const savedDirectory = profile();
  const saved = saveStandingNudges(savedDirectory, [
    always("line-endings", "  one\r\ntwo\rthree  "),
  ]);
  expect(saved[0]?.text).toBe("one\ntwo\nthree");

  const loadedDirectory = profile();
  writeFileSync(
    standingNudgesPath(loadedDirectory),
    JSON.stringify({
      schema_version: 1,
      nudges: [always("line-endings", "one\r\ntwo\rthree")],
    }),
  );
  const loaded = loadStandingNudges(loadedDirectory);
  expect(loaded[0]?.text).toBe("one\ntwo\nthree");
  const content = standingNudgeContribution(loaded, {
    agent: "default",
    workspace: "/work",
  })?.content;
  expect(content).toContain("[line-endings]\none\ntwo\nthree");
  expect(content).not.toContain("\r");
});

test("files without turnsApart load as every matching turn", () => {
  const directory = profile();
  writeFileSync(
    standingNudgesPath(directory),
    JSON.stringify({
      schema_version: 1,
      nudges: [{
        id: "legacy",
        enabled: true,
        text: "Keep working.",
        trigger: { type: "always" },
      }],
    }),
  );

  expect(loadStandingNudges(directory)).toEqual([{
    id: "legacy",
    enabled: true,
    text: "Keep working.",
    trigger: { type: "always" },
    turnsApart: 0,
  }]);
});

test("matching is exact, disabled rules are omitted, and blocks sort by id", () => {
  const nudges: readonly StandingNudge[] = [
    {
      id: "teach-go",
      enabled: true,
      text: "Explain important Go idioms with concise Python comparisons.",
      trigger: {
        type: "workspace",
        equals: "/Users/nash/Projects/vera",
      },
      turnsApart: 0,
    },
    {
      id: "strict-review",
      enabled: false,
      text: "Review strictly.",
      trigger: { type: "agent", equals: "reviewer" },
      turnsApart: 0,
    },
    always(
      "concise",
      "Answer directly and concisely. Preserve necessary detail.",
    ),
  ];
  const contribution = standingNudgeContribution(nudges, {
    agent: "reviewer",
    workspace: "/Users/nash/Projects/vera",
  });
  expect(contribution).toEqual({
    id: "host.standing-instructions",
    owner: "host",
    target: "contextual",
    title: "Standing instructions",
    content:
      "These are profile preferences. The current user message overrides them when they conflict. They do not override safety, permissions, tool scope, or project instructions.\n\n" +
      "[concise]\nAnswer directly and concisely. Preserve necessary detail.\n\n" +
      "[teach-go]\nExplain important Go idioms with concise Python comparisons.",
  });
  expect(contribution?.content.endsWith("\n")).toBe(false);

  const relatedWorkspace = standingNudgeContribution(nudges, {
    agent: "frosty-frost:9f3a",
    workspace: "/Users/nash/Projects/vera-hq",
  });
  expect(relatedWorkspace?.content).toContain("[concise]");
  expect(relatedWorkspace?.content).not.toContain("[teach-go]");
  expect(relatedWorkspace?.content).not.toContain("[strict-review]");
  expect(standingNudgeMatchCount(nudges, {
    agent: "reviewer",
    workspace: "/Users/nash/Projects/vera",
  })).toBe(2);
  expect(standingNudgeMatchCount(nudges, {
    agent: "reviewer",
    workspace: "/Users/nash/Projects/vera-hq",
  })).toBe(1);
});

test("agent triggers use the supplied worn agent name", () => {
  const nudges: readonly StandingNudge[] = [{
    id: "explore-child",
    enabled: true,
    text: "Explore carefully.",
    trigger: { type: "agent", equals: "explore" },
    turnsApart: 0,
  }];
  expect(
    standingNudgeContribution(nudges, {
      agent: "explore",
      workspace: "/work",
    })?.content,
  ).toContain("[explore-child]");
  expect(standingNudgeContribution(nudges, {
    agent: "frosty-frost:9f3a",
    workspace: "/work",
  })).toBeUndefined();
});

test("turn cadence counts matching turns independently within each session", () => {
  const nudges: readonly StandingNudge[] = [{
    ...always("periodic", "Check the plan."),
    turnsApart: 3,
  }];
  const firstSession = { matchingTurns: new Map<string, number>() };
  const secondSession = { matchingTurns: new Map<string, number>() };
  const match = { agent: "default", workspace: "/work" };

  const fires = (cadence: typeof firstSession): boolean =>
    standingNudgeContribution(nudges, match, cadence) !== undefined;

  expect([
    fires(firstSession),
    fires(firstSession),
    fires(firstSession),
    fires(firstSession),
    fires(firstSession),
    fires(firstSession),
    fires(firstSession),
  ]).toEqual([true, false, false, true, false, false, true]);
  expect(fires(secondSession)).toBe(true);
});

test("cadence advances only while an enabled rule's trigger matches", () => {
  const nudge: StandingNudge = {
    id: "review",
    enabled: true,
    text: "Review the risks.",
    trigger: { type: "agent", equals: "reviewer" },
    turnsApart: 2,
  };
  const cadence = { matchingTurns: new Map<string, number>() };
  const contribution = (agent: string): boolean =>
    standingNudgeContribution(
      [nudge],
      { agent, workspace: "/work" },
      cadence,
    ) !== undefined;

  expect(contribution("reviewer")).toBe(true);
  expect(contribution("default")).toBe(false);
  expect(contribution("reviewer")).toBe(false);
  expect(contribution("reviewer")).toBe(true);
});

test("bad files fail closed with their path and no partial result", () => {
  const invalid: readonly [string, string][] = [
    ["bad-json", "{"],
    ["schema", JSON.stringify({ schema_version: 2, nudges: [] })],
    ["non-array", JSON.stringify({ schema_version: 1, nudges: {} })],
    [
      "duplicate",
      JSON.stringify({
        schema_version: 1,
        nudges: [always("same"), always("same")],
      }),
    ],
    [
      "empty",
      JSON.stringify({
        schema_version: 1,
        nudges: [always("empty", "   ")],
      }),
    ],
    [
      "extra-root",
      JSON.stringify({
        schema_version: 1,
        nudges: [],
        surprise: true,
      }),
    ],
    [
      "extra-rule",
      JSON.stringify({
        schema_version: 1,
        nudges: [{ ...always("extra"), surprise: true }],
      }),
    ],
    [
      "always-equals",
      JSON.stringify({
        schema_version: 1,
        nudges: [{
          ...always("always-equals"),
          trigger: { type: "always", equals: "no" },
        }],
      }),
    ],
    ...[1, -1, 1.5, 11, "2"].map((turnsApart) =>
      [
        `turns-apart-${turnsApart}`,
        JSON.stringify({
          schema_version: 1,
          nudges: [{ ...always("cadence"), turnsApart }],
        }),
      ] as [string, string]
    ),
  ];
  for (const [name, source] of invalid) {
    const directory = profile();
    const path = standingNudgesPath(directory);
    writeFileSync(path, source);
    try {
      loadStandingNudges(directory);
      throw new Error(`${name} unexpectedly loaded`);
    } catch (error) {
      expect(error).toBeInstanceOf(StandingNudgesError);
      expect((error as Error).message).toContain(path);
    }
  }
});

test("save refuses to overwrite a corrupt profile file", () => {
  const directory = profile();
  const path = standingNudgesPath(directory);
  const corrupt = "{ hand edited";
  writeFileSync(path, corrupt);

  expect(() => saveStandingNudges(directory, [always("replacement")]))
    .toThrow(StandingNudgesError);
  expect(readFileSync(path, "utf8")).toBe(corrupt);
});

test("rule, text, and assembled-content caps reject on save and load", () => {
  const tooMany = Array.from(
    { length: MAX_STANDING_NUDGES + 1 },
    (_, index) => always(`n-${index}`),
  );
  expect(() => saveStandingNudges(profile(), tooMany)).toThrow(
    StandingNudgesError,
  );
  expect(() =>
    saveStandingNudges(profile(), [always("long", "x".repeat(2_001))])
  )
    .toThrow(StandingNudgesError);
  const fourLines = Array.from(
    { length: MAX_STANDING_NUDGE_TEXT_LINES },
    (_, index) => `line ${index + 1}`,
  ).join("\n");
  expect(saveStandingNudges(profile(), [always("four-lines", fourLines)]))
    .toHaveLength(1);
  const fiveLines = `${fourLines}\nline 5`;
  expect(() => saveStandingNudges(profile(), [always("five-lines", fiveLines)]))
    .toThrow(StandingNudgesError);
  expect(() =>
    saveStandingNudges(
      profile(),
      Array.from({ length: 5 }, (_, index) =>
        always(`large-${index}`, "é".repeat(1_000))),
    )
  ).toThrow(StandingNudgesError);

  const directory = profile();
  const path = standingNudgesPath(directory);
  writeFileSync(
    path,
    JSON.stringify({
      schema_version: 1,
      nudges: Array.from(
        { length: 5 },
        (_, index) => always(`large-${index}`, "é".repeat(1_000)),
      ),
    }),
  );
  expect(() => loadStandingNudges(directory)).toThrow(StandingNudgesError);

  const tooManyLinesDirectory = profile();
  writeFileSync(
    standingNudgesPath(tooManyLinesDirectory),
    JSON.stringify({
      schema_version: 1,
      nudges: [always("five-lines", fiveLines)],
    }),
  );
  try {
    loadStandingNudges(tooManyLinesDirectory);
    throw new Error("five-line instruction unexpectedly loaded");
  } catch (error) {
    expect(error).toBeInstanceOf(StandingNudgesError);
    expect((error as StandingNudgesError).problem).toContain(
      "text exceeds 4 lines",
    );
  }
});
