import { whenKeys } from "./when-analysis.ts";
import { isWhenError, parseWhen, type WhenExpression } from "./when.ts";

export const DESKTOP_MANIFEST_FILENAME = "vera.desktop.json";
export const DESKTOP_ENGINE = "vera-gui@^1";

// The keys the desktop window sets in every when-clause context. Any other key must carry the extension id.
export const CORE_WHEN_KEYS: readonly string[] = ["view", "container", "entryKind", "sessionBusy", "hasSession"];

export const EXTENSION_ID_PATTERN = /^[a-z0-9-](?:[a-z0-9.-]*[a-z0-9-])?$/;
const MANIFEST_KEYS = ["id", "version", "engine", "main", "contributes"];
const CONTRIBUTION_KINDS = ["commands", "keybindings", "themes", "tasks", "menus"];
const TASK_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const MAX_TITLE_LENGTH = 100;
const MENU_ENTRY_KEYS = ["command", "title", "description", "button"];
export const MAX_PAGE_PATH_LENGTH = 256;
export const DESKTOP_BROWSER_ICONS = ["pointer"] as const;
export type DesktopBrowserIcon = (typeof DESKTOP_BROWSER_ICONS)[number];
const MAX_CATEGORY_LENGTH = 40;
// Long enough for `imported.` and a 64-character saved-theme slug.
export const MAX_ID_LENGTH = 80;
export const MAX_THEMES_PER_EXTENSION = 32;
const MAX_THEME_LABEL_LENGTH = 120;
export const MAX_TASKS_PER_EXTENSION = 8;
// Menu places are rendered by the window, not by extension code.
export const DESKTOP_MENU_PLACES = ["appearance", "theme", "browser"] as const;
export type DesktopMenuPlace = (typeof DESKTOP_MENU_PLACES)[number];
export const MAX_MENU_ENTRIES_PER_PLACE = 8;
const MAX_DESCRIPTION_LENGTH = 300;
const MAX_BUTTON_LENGTH = 30;
const MAX_FILE_LABEL_LENGTH = 60;
const MAX_FILE_EXTENSIONS = 8;
const FILE_EXTENSION_PATTERN = /^[A-Za-z0-9]{1,16}$/;

export interface ParsedWhen {
    readonly source: string;
    readonly expression: WhenExpression;
}

// The open-file dialog shown before a command's task runs. `extensions` are written without the dot.
export interface DesktopFileFilter {
    readonly label: string;
    readonly extensions: readonly string[];
}

export interface DesktopCommand {
    readonly command: string;
    readonly title: string;
    readonly category?: string;
    // The id of a task this extension contributes. Running the command runs that task, not the main module.
    readonly task?: string;
    readonly page?: string;
    // Only with a task: the person picks a file first, and the task receives its path. Cancelling runs nothing.
    readonly file?: DesktopFileFilter;
    readonly when?: ParsedWhen;
}

// A command shown in one place. Each text left out falls back to the command's own title, or to the place's default.
export interface DesktopMenuEntry {
    readonly command: string;
    readonly title?: string;
    readonly description?: string;
    readonly button?: string;
    readonly icon?: DesktopBrowserIcon;
}

export type DesktopMenus = Readonly<Record<DesktopMenuPlace, readonly DesktopMenuEntry[]>>;

export interface DesktopKeybinding {
    readonly command: string;
    readonly key: string;
    readonly mac?: string;
    readonly when?: ParsedWhen;
}

export interface DesktopTheme {
    readonly label: string;
    // Relative path of a saved-theme file (version 1) inside the extension folder.
    readonly path: string;
}

export interface DesktopTask {
    readonly id: string;
    // Shown as the task's name in progress and failure text.
    readonly title: string;
    // Relative path of the bundled worker file inside the extension folder.
    readonly main: string;
}

export interface DesktopManifest {
    readonly id: string;
    readonly version: string;
    readonly engine: typeof DESKTOP_ENGINE;
    // Relative path of the module the desktop window runs. Required for a command that names no task.
    readonly main?: string;
    readonly commands: readonly DesktopCommand[];
    readonly keybindings: readonly DesktopKeybinding[];
    readonly themes: readonly DesktopTheme[];
    readonly tasks: readonly DesktopTask[];
    readonly menus: DesktopMenus;
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
        if (id.length > MAX_ID_LENGTH) throw new ManifestProblem(`"id" must be at most ${MAX_ID_LENGTH} characters.`);
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
    const tasks = readTasks(contributes.tasks);
    const commands = readCommands(contributes.commands, id, tasks);
    if (main === undefined && commands.some((command) => command.task === undefined && command.page === undefined)) {
        throw new ManifestProblem('"main" is required for a command that names no task.');
    }
    return {
        id,
        version: version.trim(),
        engine: DESKTOP_ENGINE,
        ...(main === undefined ? {} : { main }),
        commands,
        keybindings: readKeybindings(contributes.keybindings, commands, id),
        themes: readThemes(contributes.themes),
        tasks,
        menus: readMenus(contributes.menus, commands),
    };
}

function readMain(value: unknown): string | undefined {
    if (value === undefined) return undefined;
    if (!isRelativePath(value)) throw new ManifestProblem('"main" must be a relative file path inside the extension.');
    return value.trim();
}

function isRelativePath(value: unknown): value is string {
    return typeof value === "string"
        && value.trim().length > 0
        && !value.startsWith("/")
        && !value.startsWith("\\")
        && !/^[A-Za-z]:/.test(value)
        && !value.split(/[\\/]/).includes("..");
}

function readThemes(value: unknown): readonly DesktopTheme[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new ManifestProblem('"contributes.themes" must be an array.');
    if (value.length > MAX_THEMES_PER_EXTENSION) {
        throw new ManifestProblem(`"contributes.themes" holds at most ${MAX_THEMES_PER_EXTENSION} themes.`);
    }
    const themes: DesktopTheme[] = [];
    for (const entry of value) {
        if (!isPlainObject(entry)) throw new ManifestProblem("A theme contribution must be an object.");
        const { label, path } = entry;
        if (!isText(label, MAX_THEME_LABEL_LENGTH)) {
            throw new ManifestProblem(`A theme needs a label of 1 to ${MAX_THEME_LABEL_LENGTH} characters.`);
        }
        if (!isRelativePath(path)) {
            throw new ManifestProblem(`Theme "${label.trim()}" needs a "path" that is a relative file path inside the extension.`);
        }
        if (themes.some((existing) => existing.label === label.trim())) {
            throw new ManifestProblem(`Theme "${label.trim()}" is declared twice.`);
        }
        themes.push({ label: label.trim(), path: path.trim() });
    }
    return themes;
}

function readTasks(value: unknown): readonly DesktopTask[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new ManifestProblem('"contributes.tasks" must be an array.');
    if (value.length > MAX_TASKS_PER_EXTENSION) {
        throw new ManifestProblem(`"contributes.tasks" holds at most ${MAX_TASKS_PER_EXTENSION} tasks.`);
    }
    const tasks: DesktopTask[] = [];
    for (const entry of value) {
        if (!isPlainObject(entry)) throw new ManifestProblem("A task contribution must be an object.");
        const { id, title, main } = entry;
        if (typeof id !== "string" || !TASK_ID_PATTERN.test(id)) {
            throw new ManifestProblem('A task id must use lowercase letters, digits and "-", and be at most 40 characters.');
        }
        if (tasks.some((existing) => existing.id === id)) throw new ManifestProblem(`Task "${id}" is declared twice.`);
        if (!isText(title, MAX_TITLE_LENGTH)) {
            throw new ManifestProblem(`Task "${id}" needs a title of 1 to ${MAX_TITLE_LENGTH} characters.`);
        }
        if (!isRelativePath(main)) {
            throw new ManifestProblem(`Task "${id}" needs a "main" that is a relative file path inside the extension.`);
        }
        tasks.push({ id, title: title.trim(), main: main.trim() });
    }
    return tasks;
}

function readCommands(value: unknown, id: string, tasks: readonly DesktopTask[]): readonly DesktopCommand[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new ManifestProblem('"contributes.commands" must be an array.');
    const prefix = `${id}.`;
    const commands: DesktopCommand[] = [];
    for (const entry of value) {
        if (!isPlainObject(entry)) throw new ManifestProblem("A command contribution must be an object.");
        const { command, title, category, task } = entry;
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
        if (task !== undefined && (typeof task !== "string" || !tasks.some((declared) => declared.id === task))) {
            throw new ManifestProblem(`Command "${command}" names a task that this manifest does not declare.`);
        }
        const page = entry.page;
        if (page !== undefined && (!isRelativePath(page) || page.length > MAX_PAGE_PATH_LENGTH || page.trim() !== page || page.includes("\0"))) {
            throw new ManifestProblem(`Command "${command}" needs a "page" path inside the extension of 1 to ${MAX_PAGE_PATH_LENGTH} characters.`);
        }
        if (page !== undefined && (task !== undefined || entry.file !== undefined)) {
            throw new ManifestProblem(`Command "${command}" cannot combine "page" with "task" or "file".`);
        }
        const file = readFileFilter(entry.file, command, task !== undefined);
        const when = readWhen(entry.when, `command "${command}"`, id);
        commands.push({
            command,
            title: title.trim(),
            ...(category === undefined ? {} : { category: category.trim() }),
            ...(task === undefined ? {} : { task }),
            ...(page === undefined ? {} : { page: page as string }),
            ...(file === undefined ? {} : { file }),
            ...(when === undefined ? {} : { when }),
        });
    }
    return commands;
}

function readFileFilter(value: unknown, command: string, hasTask: boolean): DesktopFileFilter | undefined {
    if (value === undefined) return undefined;
    if (!hasTask) throw new ManifestProblem(`Command "${command}" sets "file" but names no task.`);
    if (!isPlainObject(value)) throw new ManifestProblem(`The "file" of command "${command}" must be an object.`);
    for (const key of Object.keys(value)) {
        if (key !== "label" && key !== "extensions") throw new ManifestProblem(`The "file" of command "${command}" has an unknown key "${key}".`);
    }
    const { label, extensions } = value;
    if (!isText(label, MAX_FILE_LABEL_LENGTH)) {
        throw new ManifestProblem(`The "file" of command "${command}" needs a label of 1 to ${MAX_FILE_LABEL_LENGTH} characters.`);
    }
    if (!Array.isArray(extensions) || extensions.length === 0 || extensions.length > MAX_FILE_EXTENSIONS) {
        throw new ManifestProblem(`The "file" of command "${command}" needs 1 to ${MAX_FILE_EXTENSIONS} extensions.`);
    }
    const names: string[] = [];
    for (const name of extensions) {
        if (typeof name !== "string" || !FILE_EXTENSION_PATTERN.test(name)) {
            throw new ManifestProblem(`The "file" of command "${command}" lists an extension that is not letters and digits without a dot.`);
        }
        if (!names.includes(name)) names.push(name);
    }
    return { label: label.trim(), extensions: names };
}

function readMenus(value: unknown, commands: readonly DesktopCommand[]): DesktopMenus {
    const menus: Record<DesktopMenuPlace, DesktopMenuEntry[]> = { appearance: [], theme: [], browser: [] };
    if (value === undefined) return menus;
    if (!isPlainObject(value)) throw new ManifestProblem('"contributes.menus" must be an object keyed by place.');
    for (const place of Object.keys(value)) {
        if (!isMenuPlace(place)) {
            throw new ManifestProblem(`Unknown menu place "${place}". The places are ${DESKTOP_MENU_PLACES.join(" and ")}.`);
        }
        menus[place] = readMenuEntries(value[place], place, commands);
    }
    return menus;
}

function isMenuPlace(value: string): value is DesktopMenuPlace {
    return (DESKTOP_MENU_PLACES as readonly string[]).includes(value);
}

function readMenuEntries(value: unknown, place: DesktopMenuPlace, commands: readonly DesktopCommand[]): DesktopMenuEntry[] {
    if (!Array.isArray(value)) throw new ManifestProblem(`"contributes.menus.${place}" must be an array.`);
    if (value.length > MAX_MENU_ENTRIES_PER_PLACE) {
        throw new ManifestProblem(`"contributes.menus.${place}" holds at most ${MAX_MENU_ENTRIES_PER_PLACE} entries.`);
    }
    const entries: DesktopMenuEntry[] = [];
    for (const entry of value) {
        if (!isPlainObject(entry)) throw new ManifestProblem(`A menu entry in "${place}" must be an object.`);
        for (const key of Object.keys(entry)) {
            if (!MENU_ENTRY_KEYS.includes(key) && !(place === "browser" && key === "icon")) throw new ManifestProblem(`A menu entry in "${place}" has an unknown key "${key}".`);
        }
        const { command, title, description, button, icon } = entry;
        if (place === "browser" && !(DESKTOP_BROWSER_ICONS as readonly unknown[]).includes(icon)) {
            throw new ManifestProblem(`A browser menu entry needs an "icon" from: ${DESKTOP_BROWSER_ICONS.join(", ")}.`);
        }
        if (typeof command !== "string" || !commands.some((declared) => declared.command === command)) {
            throw new ManifestProblem(`A menu entry in "${place}" names a command that this manifest does not declare.`);
        }
        if (entries.some((existing) => existing.command === command)) {
            throw new ManifestProblem(`Command "${command}" is listed twice in "${place}".`);
        }
        if (title !== undefined && !isText(title, MAX_TITLE_LENGTH)) {
            throw new ManifestProblem(`The menu entry for "${command}" needs a title of 1 to ${MAX_TITLE_LENGTH} characters.`);
        }
        if (description !== undefined && !isText(description, MAX_DESCRIPTION_LENGTH)) {
            throw new ManifestProblem(`The menu entry for "${command}" needs a description of 1 to ${MAX_DESCRIPTION_LENGTH} characters.`);
        }
        if (button !== undefined && !isText(button, MAX_BUTTON_LENGTH)) {
            throw new ManifestProblem(`The menu entry for "${command}" needs a button of 1 to ${MAX_BUTTON_LENGTH} characters.`);
        }
        entries.push({
            command,
            ...(title === undefined ? {} : { title: title.trim() }),
            ...(description === undefined ? {} : { description: description.trim() }),
            ...(button === undefined ? {} : { button: button.trim() }),
            ...(icon === undefined ? {} : { icon: icon as DesktopBrowserIcon }),
        });
    }
    return entries;
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
