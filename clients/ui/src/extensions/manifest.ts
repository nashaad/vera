import { whenKeys } from "./when-analysis.ts";
import { isWhenError, parseWhen, type WhenExpression } from "./when.ts";

export const DESKTOP_MANIFEST_FILENAME = "vera.desktop.json";
export const DESKTOP_ENGINE = "vera-gui@^1";

// The keys the desktop window sets in every when-clause context. Any other key must carry the extension id.
export const CORE_WHEN_KEYS: readonly string[] = ["view", "container", "entryKind", "sessionBusy", "hasSession"];

const EXTENSION_ID_PATTERN = /^[a-z0-9-](?:[a-z0-9.-]*[a-z0-9-])?$/;
const MANIFEST_KEYS = ["id", "version", "engine", "main", "contributes"];
const CONTRIBUTION_KINDS = ["commands", "keybindings"];
const MAX_TITLE_LENGTH = 100;
const MAX_CATEGORY_LENGTH = 40;

export interface ParsedWhen {
    readonly source: string;
    readonly expression: WhenExpression;
}

export interface DesktopCommand {
    readonly command: string;
    readonly title: string;
    readonly category?: string;
    readonly when?: ParsedWhen;
}

export interface DesktopKeybinding {
    readonly command: string;
    readonly key: string;
    readonly mac?: string;
    readonly when?: ParsedWhen;
}

export interface DesktopManifest {
    readonly id: string;
    readonly version: string;
    readonly engine: typeof DESKTOP_ENGINE;
    // Relative path of the module the desktop window runs. Required when the manifest contributes commands.
    readonly main?: string;
    readonly commands: readonly DesktopCommand[];
    readonly keybindings: readonly DesktopKeybinding[];
}

export interface ManifestFailure {
    readonly ok: false;
    // Set once the manifest names a valid id.
    readonly extensionId?: string;
    readonly reason: string;
}

export type ManifestResult = { readonly ok: true; readonly manifest: DesktopManifest } | ManifestFailure;

class ManifestProblem extends Error {}

// Reads a parsed vera.desktop.json. Never throws: every refusal comes back as a reason.
export function parseDesktopManifest(value: unknown): ManifestResult {
    let extensionId: string | undefined;
    try {
        if (!isPlainObject(value)) throw new ManifestProblem("The manifest must be a JSON object.");
        const id = value.id;
        if (typeof id !== "string" || !EXTENSION_ID_PATTERN.test(id)) {
            throw new ManifestProblem('"id" must use lowercase letters, digits, "-" and ".", and not start or end with ".".');
        }
        extensionId = id;
        return { ok: true, manifest: readManifest(value, id) };
    } catch (error) {
        if (!(error instanceof ManifestProblem)) throw error;
        return { ok: false, ...(extensionId === undefined ? {} : { extensionId }), reason: error.message };
    }
}

function readManifest(value: Record<string, unknown>, id: string): DesktopManifest {
    for (const key of Object.keys(value)) {
        if (!MANIFEST_KEYS.includes(key)) throw new ManifestProblem(`Unknown manifest key "${key}".`);
    }
    const { version, engine } = value;
    if (typeof version !== "string" || version.trim().length === 0) {
        throw new ManifestProblem('"version" must be a non-empty string.');
    }
    if (typeof engine !== "string") {
        throw new ManifestProblem(`"engine" must be the string "${DESKTOP_ENGINE}".`);
    }
    if (engine !== DESKTOP_ENGINE) {
        throw new ManifestProblem(`Engine "${engine}" is not supported; this Vera runs ${DESKTOP_ENGINE}.`);
    }
    const main = readMain(value.main);

    const contributes = value.contributes ?? {};
    if (!isPlainObject(contributes)) {
        throw new ManifestProblem('"contributes" must be an object keyed by contribution kind.');
    }
    for (const kind of Object.keys(contributes)) {
        if (!CONTRIBUTION_KINDS.includes(kind)) throw new ManifestProblem(`Unknown contribution kind "${kind}".`);
    }
    const commands = readCommands(contributes.commands, id);
    if (commands.length > 0 && main === undefined) {
        throw new ManifestProblem('"main" is required when the manifest contributes commands.');
    }
    return {
        id,
        version: version.trim(),
        engine: DESKTOP_ENGINE,
        ...(main === undefined ? {} : { main }),
        commands,
        keybindings: readKeybindings(contributes.keybindings, commands, id),
    };
}

function readMain(value: unknown): string | undefined {
    if (value === undefined) return undefined;
    if (
        typeof value !== "string"
        || value.trim().length === 0
        || value.startsWith("/")
        || value.startsWith("\\")
        || /^[A-Za-z]:/.test(value)
        || value.split(/[\\/]/).includes("..")
    ) {
        throw new ManifestProblem('"main" must be a relative file path inside the extension.');
    }
    return value.trim();
}

function readCommands(value: unknown, id: string): readonly DesktopCommand[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new ManifestProblem('"contributes.commands" must be an array.');
    const prefix = `${id}.`;
    const commands: DesktopCommand[] = [];
    for (const entry of value) {
        if (!isPlainObject(entry)) throw new ManifestProblem("A command contribution must be an object.");
        const { command, title, category } = entry;
        if (typeof command !== "string" || /\s/.test(command) || command.length === 0) {
            throw new ManifestProblem("A command id must be a non-empty string without whitespace.");
        }
        if (!command.startsWith(prefix) || command.length === prefix.length) {
            throw new ManifestProblem(`Command "${command}" must start with "${prefix}".`);
        }
        if (commands.some((existing) => existing.command === command)) {
            throw new ManifestProblem(`Command "${command}" is declared twice.`);
        }
        if (!isText(title, MAX_TITLE_LENGTH)) {
            throw new ManifestProblem(`Command "${command}" needs a title of 1 to ${MAX_TITLE_LENGTH} characters.`);
        }
        if (category !== undefined && !isText(category, MAX_CATEGORY_LENGTH)) {
            throw new ManifestProblem(`Command "${command}" needs a category of 1 to ${MAX_CATEGORY_LENGTH} characters.`);
        }
        const when = readWhen(entry.when, `command "${command}"`, id);
        commands.push({
            command,
            title: title.trim(),
            ...(category === undefined ? {} : { category: category.trim() }),
            ...(when === undefined ? {} : { when }),
        });
    }
    return commands;
}

function readKeybindings(value: unknown, commands: readonly DesktopCommand[], id: string): readonly DesktopKeybinding[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new ManifestProblem('"contributes.keybindings" must be an array.');
    const keybindings: DesktopKeybinding[] = [];
    for (const entry of value) {
        if (!isPlainObject(entry)) throw new ManifestProblem("A keybinding contribution must be an object.");
        const { command, key, mac } = entry;
        if (typeof command !== "string" || command.length === 0) {
            throw new ManifestProblem("A keybinding must name a command.");
        }
        if (!commands.some((declared) => declared.command === command)) {
            throw new ManifestProblem(`Keybinding names command "${command}", which this manifest does not declare.`);
        }
        if (!isText(key)) {
            throw new ManifestProblem(`Keybinding for "${command}" needs a non-empty key.`);
        }
        if (mac !== undefined && !isText(mac)) {
            throw new ManifestProblem(`Keybinding for "${command}" needs a non-empty mac key when mac is set.`);
        }
        const when = readWhen(entry.when, `keybinding for "${command}"`, id);
        keybindings.push({
            command,
            key,
            ...(mac === undefined ? {} : { mac }),
            ...(when === undefined ? {} : { when }),
        });
    }
    return keybindings;
}

// A condition that fails to parse, or reads a key that is neither core nor the extension's own, fails the manifest.
function readWhen(value: unknown, owner: string, id: string): ParsedWhen | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== "string") throw new ManifestProblem(`The when clause of ${owner} must be a string.`);
    const expression = parseWhen(value);
    if (isWhenError(expression)) {
        throw new ManifestProblem(`The when clause of ${owner} is invalid: ${expression.message} (at character ${expression.offset}).`);
    }
    for (const name of whenKeys(expression)) {
        if (!CORE_WHEN_KEYS.includes(name) && !name.startsWith(`${id}.`)) {
            throw new ManifestProblem(
                `The when clause of ${owner} reads key "${name}", which is neither a core key (${CORE_WHEN_KEYS.join(", ")}) nor prefixed "${id}.".`,
            );
        }
    }
    return { source: value, expression };
}

function isText(value: unknown, max = Number.POSITIVE_INFINITY): value is string {
    return typeof value === "string" && value.trim().length > 0 && value.trim().length <= max;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
