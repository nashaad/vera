// One flag per optional part of the window, kept in flags.json under the desktop's own directory in the home.
// Core parts (new chat, the session list, the composer, Settings, Feedback) have no flag.
export type FlagChoice = "auto" | "on" | "off";

export type FlagGroup = "window" | "developer";

export interface FlagSpec {
    readonly key: FlagKey;
    readonly group: FlagGroup;
    // False when nothing in the window can say when the part has something to show; it then offers On and Off only.
    readonly auto: boolean;
    readonly packaged: FlagChoice;
    readonly development: FlagChoice;
}

export const FLAG_KEYS = [
    "search",
    "work",
    "customize",
    "review",
    "plan",
    "files",
    "output",
    "browser",
    "contextPill",
    "showReasoning",
    "doctor",
    "devices",
    "tour",
    "coverage",
    "diagnostics",
    "failures",
    "configure",
    "nudges",
    "extensions",
    "buildLine",
] as const;

export type FlagKey = (typeof FLAG_KEYS)[number];

export type DesktopFlags = Readonly<Record<FlagKey, FlagChoice>>;

function windowPart(key: FlagKey, auto: boolean, fallback: FlagChoice): FlagSpec {
    return { key, group: "window", auto, packaged: fallback, development: fallback };
}

function developerPart(key: FlagKey): FlagSpec {
    return { key, group: "developer", auto: false, packaged: "off", development: "on" };
}

export const FLAG_SPECS: readonly FlagSpec[] = [
    windowPart("search", true, "auto"),
    windowPart("work", true, "auto"),
    windowPart("customize", true, "auto"),
    windowPart("review", true, "auto"),
    windowPart("plan", true, "auto"),
    windowPart("files", true, "auto"),
    windowPart("output", true, "auto"),
    windowPart("browser", false, "on"),
    windowPart("contextPill", true, "auto"),
    windowPart("showReasoning", false, "off"),
    windowPart("doctor", true, "auto"),
    developerPart("devices"),
    developerPart("tour"),
    developerPart("coverage"),
    developerPart("diagnostics"),
    developerPart("failures"),
    developerPart("configure"),
    developerPart("nudges"),
    developerPart("extensions"),
    developerPart("buildLine"),
];

export function defaultFlags(packaged: boolean): DesktopFlags {
    const flags = {} as Record<FlagKey, FlagChoice>;
    for (const spec of FLAG_SPECS) flags[spec.key] = packaged ? spec.packaged : spec.development;
    return flags;
}

export const DEFAULT_DESKTOP_FLAGS: DesktopFlags = defaultFlags(true);

export function flagSpec(key: FlagKey): FlagSpec {
    const spec = FLAG_SPECS.find((candidate) => candidate.key === key);
    if (spec === undefined) throw new Error(`No flag named ${key}.`);
    return spec;
}

function isChoice(value: unknown): value is FlagChoice {
    return value === "auto" || value === "on" || value === "off";
}

// "auto" on a part with no auto condition reads as the build default. The first version of the
// file held a boolean for showReasoning; true meant on and false meant off.
function readChoice(spec: FlagSpec, value: unknown, fallback: FlagChoice): FlagChoice {
    if (spec.key === "showReasoning" && typeof value === "boolean") return value ? "on" : "off";
    if (!isChoice(value)) return fallback;
    return value === "auto" && !spec.auto ? fallback : value;
}

// Anything missing, misspelled or mistyped keeps the build default.
export function parseFlags(value: unknown, defaults: DesktopFlags = DEFAULT_DESKTOP_FLAGS): DesktopFlags {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return defaults;
    const fields = value as Record<string, unknown>;
    const flags = {} as Record<FlagKey, FlagChoice>;
    for (const spec of FLAG_SPECS) flags[spec.key] = readChoice(spec, fields[spec.key], defaults[spec.key]);
    return flags;
}

export type FlagPatch = Readonly<Partial<Record<FlagKey, FlagChoice>>>;

// A patch names known flags with values their part offers; one bad entry rejects the whole patch.
export function parseFlagPatch(value: unknown): FlagPatch | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const patch: Partial<Record<FlagKey, FlagChoice>> = {};
    for (const [key, choice] of Object.entries(value)) {
        const spec = FLAG_SPECS.find((candidate) => candidate.key === key);
        if (spec === undefined || !isChoice(choice) || (choice === "auto" && !spec.auto)) return undefined;
        patch[spec.key] = choice;
    }
    return Object.keys(patch).length === 0 ? undefined : patch;
}
