import {
    readFile,
    realpath,
    stat,
} from "node:fs/promises";
import {
    basename,
    isAbsolute,
    join,
    relative,
    sep,
} from "node:path";

export const SKILL_FILENAME = "SKILL.md";

const MAX_SKILL_BYTES = 256 * 1024;
const MAX_NAME_CHARACTERS = 64;
const MAX_DESCRIPTION_CHARACTERS = 1024;

export interface SkillMetadata {
    readonly name: string;
    readonly description: string;
    readonly extra: Readonly<Record<string, unknown>>;
}

export interface LoadedSkillPackage {
    readonly directory: string;
    readonly skillPath: string;
    readonly metadata: SkillMetadata;
    readonly instructions: string;
}

export async function loadSkillPackage(
    configuredDirectory: string,
): Promise<LoadedSkillPackage> {
    const directory = await realpath(configuredDirectory);
    if (!(await stat(directory)).isDirectory()) {
        throw new Error(`Vera skill path is not a directory: ${directory}`);
    }

    const skillPath = await realpath(join(directory, SKILL_FILENAME));
    const details = await stat(skillPath);
    if (
        !details.isFile()
        || basename(skillPath) !== SKILL_FILENAME
        || !isWithin(directory, skillPath)
    ) {
        throw new Error(
            `Vera skill must contain a regular ${SKILL_FILENAME} file`,
        );
    }
    if (details.size > MAX_SKILL_BYTES) {
        throw new Error(
            `Vera skill exceeds the ${MAX_SKILL_BYTES}-byte limit: ${skillPath}`,
        );
    }

    const bytes = await readFile(skillPath);
    if (bytes.byteLength > MAX_SKILL_BYTES) {
        throw new Error(
            `Vera skill grew beyond the ${MAX_SKILL_BYTES}-byte limit while it was being read: ${skillPath}`,
        );
    }

    let source: string;
    try {
        source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
        throw new Error(`Vera skill is not valid UTF-8: ${skillPath}`);
    }

    const parsed = parseSkillSource(source);
    return {
        directory,
        skillPath,
        metadata: parsed.metadata,
        instructions: parsed.instructions,
    };
}

export function parseSkillSource(source: string): {
    readonly metadata: SkillMetadata;
    readonly instructions: string;
} {
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source);
    if (match === null) {
        throw new Error("Vera skill must begin with YAML frontmatter");
    }

    let value: unknown;
    try {
        value = Bun.YAML.parse(match[1] ?? "");
    } catch (error) {
        throw new Error(`Invalid Vera skill frontmatter: ${errorMessage(error)}`);
    }
    if (!isPlainObject(value)) {
        throw new Error("Vera skill frontmatter must be a YAML mapping");
    }

    const name = requiredText(value.name, "name", MAX_NAME_CHARACTERS);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
        throw new Error(
            "Vera skill name must contain lowercase letters, numbers, and single hyphens",
        );
    }
    const description = requiredText(
        value.description,
        "description",
        MAX_DESCRIPTION_CHARACTERS,
    );
    const { name: _name, description: _description, ...extra } = value;

    return {
        metadata: { name, description, extra },
        instructions: source.slice(match[0].length),
    };
}

function requiredText(
    value: unknown,
    field: string,
    maxCharacters: number,
): string {
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new Error(`Vera skill ${field} must be a non-empty string`);
    }
    const text = value.trim();
    if ([...text].length > maxCharacters) {
        throw new Error(
            `Vera skill ${field} exceeds the ${maxCharacters}-character limit`,
        );
    }
    return text;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object"
        && value !== null
        && !Array.isArray(value);
}

function isWithin(directory: string, candidate: string): boolean {
    const path = relative(directory, candidate);
    return path === ""
        || (path !== ".."
            && !path.startsWith(`..${sep}`)
            && !isAbsolute(path));
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
