import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { PromptContribution } from "./engine/prompt-contributions.ts";
import { readRegularFileTextSync } from "./store/regular-file.ts";

export const STANDING_NUDGES_SCHEMA_VERSION = 1;
export const MAX_STANDING_NUDGES = 32;
export const MAX_STANDING_NUDGE_TEXT_LINES = 4;
export const MAX_STANDING_NUDGE_TEXT_CODE_UNITS = 2_000;
export const MAX_STANDING_NUDGE_CONTENT_BYTES = 8_192;
export const MAX_STANDING_NUDGE_TURNS_APART = 10;
export const STANDING_NUDGE_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

const FILE_NAME = "standing-nudges.json";
const WRAPPER =
  "These are profile preferences. The current user message overrides them when they conflict. They do not override safety, permissions, tool scope, or project instructions.";

export type StandingNudgeTrigger =
  | { readonly type: "always" }
  | { readonly type: "agent"; readonly equals: string }
  | { readonly type: "workspace"; readonly equals: string };

export interface StandingNudge {
  readonly id: string;
  readonly enabled: boolean;
  readonly text: string;
  readonly trigger: StandingNudgeTrigger;
  /** 0 means every matching turn; otherwise only 2 through 10 are valid. */
  readonly turnsApart: number;
}

/** Mutable session-local cadence state, kept outside the persisted profile. */
export interface StandingNudgeCadence {
  readonly matchingTurns: Map<string, number>;
}

interface StandingNudgesFile {
  readonly schema_version: typeof STANDING_NUDGES_SCHEMA_VERSION;
  readonly nudges: readonly StandingNudge[];
}

export interface StandingNudgeMatch {
  readonly agent: string;
  readonly workspace: string;
}

export class StandingNudgesError extends Error {
  readonly path: string;
  readonly problem: string;

  constructor(path: string, problem: string) {
    super(`Standing nudges at ${path} could not be read: ${problem}`);
    this.name = "StandingNudgesError";
    this.path = path;
    this.problem = problem;
  }
}

export function standingNudgesPath(profileDirectory: string): string {
  return join(profileDirectory, FILE_NAME);
}

export function loadStandingNudges(
  profileDirectory: string,
): readonly StandingNudge[] {
  const path = standingNudgesPath(profileDirectory);
  let source: string;
  try {
    source = readRegularFileTextSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new StandingNudgesError(path, errorMessage(error));
  }

  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new StandingNudgesError(
      path,
      `it is not valid JSON (${errorMessage(error)})`,
    );
  }
  return parseStandingNudgesFile(path, value).nudges;
}

export function saveStandingNudges(
  profileDirectory: string,
  nudges: readonly StandingNudge[],
): readonly StandingNudge[] {
  const path = standingNudgesPath(profileDirectory);
  // Refuse to erase hand-edited data this parser cannot understand. The
  // caller can fix the named file and retry without losing its only copy.
  loadStandingNudges(profileDirectory);
  const file = parseStandingNudgesFile(path, {
    schema_version: STANDING_NUDGES_SCHEMA_VERSION,
    nudges,
  });
  const temporaryPath = join(
    profileDirectory,
    `.standing-nudges-${randomUUID()}.tmp`,
  );
  mkdirSync(profileDirectory, { recursive: true, mode: 0o700 });
  writeFileSync(
    temporaryPath,
    `${JSON.stringify(file, null, 2)}\n`,
    { mode: 0o600 },
  );
  renameSync(temporaryPath, path);
  return file.nudges;
}

export function standingNudgeContribution(
  nudges: readonly StandingNudge[],
  match: StandingNudgeMatch,
  cadence?: StandingNudgeCadence,
): PromptContribution | undefined {
  const matching = standingNudgeMatches(nudges, match)
    .filter((nudge) => firesAtCadence(nudge, cadence));
  if (matching.length === 0) return undefined;
  const content = assembleContent(matching);
  assertContentCap(standingNudgesPath("<profile>"), content);
  return {
    id: "host.standing-instructions",
    owner: "host",
    target: "contextual",
    title: "Standing instructions",
    content,
  };
}

/** Enabled rules whose trigger applies to a conversation, before cadence. */
export function standingNudgeMatches(
  nudges: readonly StandingNudge[],
  match: StandingNudgeMatch,
): readonly StandingNudge[] {
  return nudges
    .filter((nudge) => nudge.enabled && matches(nudge, match))
    .sort(compareById);
}

/** Number of rules shown by a conversation's ambient nudge indicator. */
export function standingNudgeMatchCount(
  nudges: readonly StandingNudge[],
  match: StandingNudgeMatch,
): number {
  return standingNudgeMatches(nudges, match).length;
}

function parseStandingNudgesFile(
  path: string,
  value: unknown,
): StandingNudgesFile {
  const root = recordAt(path, "the root", value);
  exactFields(path, "the root", root, ["schema_version", "nudges"]);
  if (root.schema_version !== STANDING_NUDGES_SCHEMA_VERSION) {
    throw new StandingNudgesError(
      path,
      `schema_version must be ${STANDING_NUDGES_SCHEMA_VERSION}`,
    );
  }
  if (!Array.isArray(root.nudges)) {
    throw new StandingNudgesError(path, "nudges must be an array");
  }
  if (root.nudges.length > MAX_STANDING_NUDGES) {
    throw new StandingNudgesError(
      path,
      `nudges has ${root.nudges.length} rules; maximum is ${MAX_STANDING_NUDGES}`,
    );
  }

  const ids = new Set<string>();
  const nudges = root.nudges.map((entry, index) => {
    const nudge = parseNudge(path, entry, index);
    if (ids.has(nudge.id)) {
      throw new StandingNudgesError(path, `duplicate id "${nudge.id}"`);
    }
    ids.add(nudge.id);
    return nudge;
  });
  assertAllPossibleContentFits(path, nudges);
  return {
    schema_version: STANDING_NUDGES_SCHEMA_VERSION,
    nudges,
  };
}

function parseNudge(
  path: string,
  value: unknown,
  index: number,
): StandingNudge {
  const at = `nudges[${index}]`;
  const entry = recordAt(path, at, value);
  exactFields(
    path,
    at,
    entry,
    ["id", "enabled", "text", "trigger"],
    ["turnsApart"],
  );
  if (
    typeof entry.id !== "string" ||
    !STANDING_NUDGE_ID_PATTERN.test(entry.id)
  ) {
    throw new StandingNudgesError(
      path,
      `${at}.id must match ${STANDING_NUDGE_ID_PATTERN.source}`,
    );
  }
  if (typeof entry.enabled !== "boolean") {
    throw new StandingNudgesError(path, `${at}.enabled must be boolean`);
  }
  if (typeof entry.text !== "string") {
    throw new StandingNudgesError(path, `${at}.text must be a string`);
  }
  const text = entry.text.trim()
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n");
  if (text.length === 0) {
    throw new StandingNudgesError(path, `${at}.text must not be empty`);
  }
  if (text.split("\n").length > MAX_STANDING_NUDGE_TEXT_LINES) {
    throw new StandingNudgesError(
      path,
      `${at}.text exceeds ${MAX_STANDING_NUDGE_TEXT_LINES} lines`,
    );
  }
  if (text.length > MAX_STANDING_NUDGE_TEXT_CODE_UNITS) {
    throw new StandingNudgesError(
      path,
      `${at}.text exceeds ${MAX_STANDING_NUDGE_TEXT_CODE_UNITS} UTF-16 code units`,
    );
  }
  const turnsApart = entry.turnsApart ?? 0;
  if (
    typeof turnsApart !== "number" ||
    !Number.isInteger(turnsApart) ||
    (turnsApart !== 0 &&
      (turnsApart < 2 ||
        turnsApart > MAX_STANDING_NUDGE_TURNS_APART))
  ) {
    throw new StandingNudgesError(
      path,
      `${at}.turnsApart must be 0 or an integer from 2 through ${MAX_STANDING_NUDGE_TURNS_APART}`,
    );
  }
  return {
    id: entry.id,
    enabled: entry.enabled,
    text,
    trigger: parseTrigger(path, entry.trigger, at),
    turnsApart,
  };
}

function parseTrigger(
  path: string,
  value: unknown,
  parent: string,
): StandingNudgeTrigger {
  const at = `${parent}.trigger`;
  const trigger = recordAt(path, at, value);
  if (trigger.type === "always") {
    exactFields(path, at, trigger, ["type"]);
    return { type: "always" };
  }
  if (trigger.type !== "agent" && trigger.type !== "workspace") {
    throw new StandingNudgesError(
      path,
      `${at}.type must be always, agent, or workspace`,
    );
  }
  exactFields(path, at, trigger, ["type", "equals"]);
  if (
    typeof trigger.equals !== "string" || trigger.equals.trim().length === 0
  ) {
    throw new StandingNudgesError(
      path,
      `${at}.equals must be a non-empty string`,
    );
  }
  return { type: trigger.type, equals: trigger.equals.trim() };
}

function matches(nudge: StandingNudge, match: StandingNudgeMatch): boolean {
  switch (nudge.trigger.type) {
    case "always":
      return true;
    case "agent":
      return nudge.trigger.equals === match.agent;
    case "workspace":
      return nudge.trigger.equals === match.workspace;
  }
}

function firesAtCadence(
  nudge: StandingNudge,
  cadence: StandingNudgeCadence | undefined,
): boolean {
  if (cadence === undefined) return true;
  const matchingTurn = (cadence.matchingTurns.get(nudge.id) ?? 0) + 1;
  cadence.matchingTurns.set(nudge.id, matchingTurn);
  return nudge.turnsApart === 0 ||
    (matchingTurn - 1) % nudge.turnsApart === 0;
}

function assembleContent(nudges: readonly StandingNudge[]): string {
  return `${WRAPPER}\n\n${
    nudges
      .map((nudge) => `[${nudge.id}]\n${nudge.text}`)
      .join("\n\n")
  }`;
}

function assertAllPossibleContentFits(
  path: string,
  nudges: readonly StandingNudge[],
): void {
  const enabled = nudges.filter((nudge) => nudge.enabled === true);
  if (enabled.length === 0) return;
  const agents = uniqueTriggerValues(enabled, "agent");
  const workspaces = uniqueTriggerValues(enabled, "workspace");
  for (const agent of ["", ...agents]) {
    for (const workspace of ["", ...workspaces]) {
      const matching = enabled
        .filter((nudge) => matches(nudge, { agent, workspace }))
        .sort(compareById);
      if (matching.length > 0) {
        assertContentCap(path, assembleContent(matching));
      }
    }
  }
}

function uniqueTriggerValues(
  nudges: readonly StandingNudge[],
  type: "agent" | "workspace",
): readonly string[] {
  return [
    ...new Set(
      nudges.flatMap((nudge) =>
        nudge.trigger.type === type ? [nudge.trigger.equals] : []
      ),
    ),
  ];
}

function assertContentCap(path: string, content: string): void {
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > MAX_STANDING_NUDGE_CONTENT_BYTES) {
    throw new StandingNudgesError(
      path,
      `assembled content is ${bytes} UTF-8 bytes; maximum is ${MAX_STANDING_NUDGE_CONTENT_BYTES}`,
    );
  }
}

function compareById(a: StandingNudge, b: StandingNudge): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function recordAt(
  path: string,
  at: string,
  value: unknown,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new StandingNudgesError(path, `${at} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactFields(
  path: string,
  at: string,
  value: Record<string, unknown>,
  expected: readonly string[],
  optional: readonly string[] = [],
): void {
  const keys = Object.keys(value);
  const extra = keys.find((key) =>
    !expected.includes(key) && !optional.includes(key)
  );
  if (extra !== undefined) {
    throw new StandingNudgesError(
      path,
      `${at} has unknown field "${extra}"`,
    );
  }
  const missing = expected.find((key) => !Object.hasOwn(value, key));
  if (missing !== undefined) {
    throw new StandingNudgesError(
      path,
      `${at} is missing field "${missing}"`,
    );
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
