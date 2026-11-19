import type { HLJSApi } from "highlight.js";

import { HighlightCache } from "./cache.ts";
import { languageFor, languageNamed, type LanguageEntry } from "./languages.ts";
import { parseHighlighted, type HighlightedCode } from "./tokens.ts";

// Past these a block stays plain text: one span per token adds up in the page.
export const MAX_LINES = 600;
export const MAX_CHARS = 40_000;

const CACHE_ENTRIES = 64;
const CACHE_CHARS = 400_000;

const cache = new HighlightCache(CACHE_ENTRIES, CACHE_CHARS);
const loading = new Map<string, Promise<void>>();
const pending = new Map<string, Promise<HighlightedCode | null>>();
let core: Promise<HLJSApi> | undefined;

function cacheKey(language: LanguageEntry, code: string): string {
    return `${language.name}\n${code}`;
}

export function canHighlight(info: string, code: string): LanguageEntry | undefined {
    const language = languageFor(info);
    if (language === undefined || code.length > MAX_CHARS) return undefined;
    return countLines(code) > MAX_LINES ? undefined : language;
}

function countLines(code: string): number {
    let lines = 1;
    for (let at = code.indexOf("\n"); at !== -1; at = code.indexOf("\n", at + 1)) lines++;
    return lines;
}

// Reads the cache only. Used to paint a block that was highlighted before without a second pass.
export function peekHighlight(info: string, code: string): HighlightedCode | undefined {
    const language = canHighlight(info, code);
    return language === undefined ? undefined : cache.get(cacheKey(language, code));
}

function loadCore(): Promise<HLJSApi> {
    core ??= import("highlight.js/lib/core").then((module) => module.default);
    return core;
}

function register(language: LanguageEntry): Promise<void> {
    let job = loading.get(language.name);
    if (job === undefined) {
        job = Promise.all([loadCore(), language.load()]).then(([api, module]) => {
            api.registerLanguage(language.name, module.default);
        });
        loading.set(language.name, job);
        // A failed chunk load is retried on the next block rather than remembered.
        job.catch(() => loading.delete(language.name));
    }
    return job;
}

async function registerWithNeeds(language: LanguageEntry, seen: Set<string>): Promise<void> {
    if (seen.has(language.name)) return;
    seen.add(language.name);
    await register(language);
    await Promise.all(language.needs.map((name) => registerWithNeeds(languageNamed(name), seen)));
}

async function run(language: LanguageEntry, code: string): Promise<HighlightedCode | null> {
    try {
        await registerWithNeeds(language, new Set());
        const api = await loadCore();
        const html = api.highlight(code, { language: language.name, ignoreIllegals: true }).value;
        return parseHighlighted(html);
    } catch {
        return null;
    }
}

// Resolves to null for a language with no grammar, a block over the limits, or a grammar that fails; the caller shows plain text.
export function highlightCode(info: string, code: string): Promise<HighlightedCode | null> {
    const language = canHighlight(info, code);
    if (language === undefined) return Promise.resolve(null);
    const key = cacheKey(language, code);
    const hit = cache.get(key);
    if (hit !== undefined) return Promise.resolve(hit);
    let job = pending.get(key);
    if (job === undefined) {
        job = run(language, code).then((result) => {
            pending.delete(key);
            if (result !== null) cache.set(key, result, code.length);
            return result;
        });
        pending.set(key, job);
    }
    return job;
}

export function highlightCacheStats(): { readonly entries: number; readonly chars: number } {
    return { entries: cache.size, chars: cache.cost };
}
