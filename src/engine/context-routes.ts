import { readFile, realpath, stat } from "node:fs/promises";
import {
    extname,
    isAbsolute,
    join,
    relative,
    sep,
} from "node:path";

export const CONTEXT_ROUTES_YAML_NAME = "context-routes.yaml";
export const CONTEXT_ROUTES_DIR_NAME = "context-routes";
const MAX_PAYLOAD_BYTES = 128 * 1024;

export interface ContextRoute {
    readonly readGlob: string;
    readonly injectRelative: string;
}

export interface ContextRoutePayload {
    readonly injectPath: string;
    readonly displayPath: string;
    readonly content: string;
}

export function formatContextRouteReminder(
    payloads: readonly ContextRoutePayload[],
): string {
    // Trailing newlines on the file are stripped so two payloads join as one blank line.
    return payloads.map((payload) =>
        `Contents of ${payload.displayPath}:\n\n${payload.content.replace(/\n+$/, "")}`
    ).join("\n\n");
}

export function globMatches(glob: string, relativePath: string): boolean {
    const pattern = posixPath(glob);
    const value = posixPath(relativePath);
    if (pattern.length === 0 || value.length === 0) {
        return false;
    }
    return globRegExp(pattern).test(value);
}

export function workspaceRelativePath(
    workspace: string,
    path: string,
): string | undefined {
    const resolved = isAbsolute(path) ? path : join(workspace, path);
    const rel = relative(workspace, resolved);
    if (rel.length === 0 || rel.startsWith("..") || isAbsolute(rel)) {
        return undefined;
    }
    return posixPath(rel);
}

export async function loadContextRoutes(
    workspace: string,
): Promise<readonly ContextRoute[] | undefined> {
    const yamlPath = join(workspace, ".vera", CONTEXT_ROUTES_YAML_NAME);
    let text: string;
    try {
        text = await readFile(yamlPath, "utf8");
    } catch (error) {
        if (isMissingFile(error)) {
            return [];
        }
        return undefined;
    }
    let parsed: unknown;
    try {
        parsed = Bun.YAML.parse(text);
    } catch {
        return undefined;
    }
    return parseRoutes(parsed);
}

export async function payloadsForSuccessfulReads(
    workspace: string,
    readPaths: readonly string[],
    alreadyInjected: ReadonlySet<string>,
): Promise<readonly ContextRoutePayload[] | undefined> {
    const routes = await loadContextRoutes(workspace);
    if (routes === undefined) {
        return undefined;
    }
    if (routes.length === 0 || readPaths.length === 0) {
        return [];
    }
    const queued = new Map<string, ContextRoute>();
    for (const route of routes) {
        if (alreadyInjected.has(route.injectRelative) || queued.has(route.injectRelative)) {
            continue;
        }
        const matched = readPaths.some((path) => {
            const relativePath = workspaceRelativePath(workspace, path);
            return relativePath !== undefined
                && globMatches(route.readGlob, relativePath);
        });
        if (matched) {
            queued.set(route.injectRelative, route);
        }
    }
    const payloads: ContextRoutePayload[] = [];
    for (const route of queued.values()) {
        const payload = await readInjectPayload(workspace, route.injectRelative);
        if (payload !== undefined) {
            payloads.push(payload);
        }
    }
    return payloads;
}

function parseRoutes(value: unknown): readonly ContextRoute[] | undefined {
    if (value === null || value === undefined) {
        return [];
    }
    if (typeof value !== "object" || Array.isArray(value)) {
        return undefined;
    }
    const routes = (value as { readonly routes?: unknown }).routes;
    if (routes === undefined) {
        return [];
    }
    if (!Array.isArray(routes)) {
        return undefined;
    }
    const parsed: ContextRoute[] = [];
    for (const item of routes) {
        const route = parseRoute(item);
        if (route === undefined) {
            return undefined;
        }
        if (route !== null) {
            parsed.push(route);
        }
    }
    return parsed;
}

function parseRoute(
    value: unknown,
): ContextRoute | null | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return undefined;
    }
    const row = value as {
        readonly trigger?: unknown;
        readonly consequence?: unknown;
    };
    if (
        typeof row.trigger !== "object"
        || row.trigger === null
        || Array.isArray(row.trigger)
        || typeof row.consequence !== "object"
        || row.consequence === null
        || Array.isArray(row.consequence)
    ) {
        return undefined;
    }
    const trigger = row.trigger as {
        readonly read?: unknown;
        readonly about_to_run?: unknown;
    };
    const consequence = row.consequence as { readonly inject?: unknown };
    if (typeof consequence.inject !== "string" || consequence.inject.trim() === "") {
        return undefined;
    }
    const injectRelative = posixPath(consequence.inject.trim());
    if (!isJailedInjectPath(injectRelative)) {
        return null;
    }
    if (typeof trigger.read === "string" && trigger.read.trim().length > 0) {
        return {
            readGlob: trigger.read.trim(),
            injectRelative,
        };
    }
    if (typeof trigger.about_to_run === "string") {
        return null;
    }
    return undefined;
}

function isJailedInjectPath(injectRelative: string): boolean {
    const prefix = `${CONTEXT_ROUTES_DIR_NAME}/`;
    if (!injectRelative.startsWith(prefix)) {
        return false;
    }
    if (extname(injectRelative).toLowerCase() !== ".md") {
        return false;
    }
    const rest = injectRelative.slice(prefix.length);
    if (rest.length === 0) {
        return false;
    }
    return rest.split("/").every((part) =>
        part.length > 0 && part !== "." && part !== ".."
    );
}

async function readInjectPayload(
    workspace: string,
    injectRelative: string,
): Promise<ContextRoutePayload | undefined> {
    const routesRoot = join(workspace, ".vera", CONTEXT_ROUTES_DIR_NAME);
    const candidate = join(workspace, ".vera", injectRelative);
    let resolved: string;
    let root: string;
    try {
        root = await realpath(routesRoot);
        resolved = await realpath(candidate);
    } catch {
        return undefined;
    }
    if (!isWithin(root, resolved) || extname(resolved).toLowerCase() !== ".md") {
        return undefined;
    }
    try {
        const details = await stat(resolved);
        if (!details.isFile() || details.size > MAX_PAYLOAD_BYTES) {
            return undefined;
        }
        const bytes = await readFile(resolved);
        if (bytes.byteLength > MAX_PAYLOAD_BYTES) {
            return undefined;
        }
        const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        return {
            injectPath: injectRelative,
            displayPath: `.vera/${injectRelative}`,
            content,
        };
    } catch {
        return undefined;
    }
}

function globRegExp(glob: string): RegExp {
    let pattern = "";
    for (let index = 0; index < glob.length;) {
        if (glob.startsWith("**/", index)) {
            pattern += "(?:.*/)?";
            index += 3;
            continue;
        }
        if (glob.startsWith("**", index) && index + 2 === glob.length) {
            pattern += ".*";
            index += 2;
            continue;
        }
        const char = glob[index]!;
        if (char === "*") {
            pattern += "[^/]*";
        } else if (char === "?") {
            pattern += "[^/]";
        } else {
            pattern += escapeRegExp(char);
        }
        index += 1;
    }
    return new RegExp(`^${pattern}$`);
}

function escapeRegExp(value: string): string {
    return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function posixPath(path: string): string {
    return path.split(sep).join("/");
}

function isWithin(parent: string, child: string): boolean {
    const path = relative(parent, child);
    return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function isMissingFile(error: unknown): boolean {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
}
