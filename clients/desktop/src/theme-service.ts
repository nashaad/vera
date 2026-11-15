import { join } from "node:path";

import type { ImportedThemeSummary } from "../../ui/src/theme/imported.ts";
import type { InstalledThemesResult, ThemeImportResult } from "../../ui/src/protocol/themes.ts";
import { savedThemeExtensionId, stageSavedTheme } from "./extensions/saved-theme.ts";
import type { ExtensionStore } from "./extensions/store.ts";
import type { ImportOutcome, InstalledTheme, ThemeTask, ThemeTaskReply } from "./theme-import/task-protocol.ts";
import { extensionRoots } from "./theme-import/roots.ts";
import { ThemeStore } from "./theme-store.ts";

export type RunThemeTask = (task: ThemeTask) => Promise<ThemeTaskReply>;

// The themes the picker lists: those of the enabled desktop extensions, plus any theme still saved in the old
// themes folder because it could not be moved into an extension. Importing a VS Code theme converts it in a task
// process into a staging folder, and each result is installed as a desktop extension named `imported.<slug>`.
export class ThemeService {
    private readonly saved: ThemeStore;
    private known: readonly ImportedThemeSummary[] = [];
    private listed = new Map<string, InstalledTheme>();

    constructor(
        private readonly extensions: ExtensionStore,
        savedDirectory: string,
        private readonly run: RunThemeTask,
        private readonly roots: readonly string[] = extensionRoots(),
        private readonly onChange: () => void = () => {},
    ) {
        this.saved = new ThemeStore(savedDirectory);
    }

    // Reads the themes again, so an extension or a file added by hand shows up.
    load(): readonly ImportedThemeSummary[] {
        const fromExtensions = this.extensions.themes();
        const keys = new Set(fromExtensions.map((theme) => theme.slug));
        const next = [...fromExtensions, ...this.saved.list().filter((theme) => !keys.has(theme.slug))]
            .sort((a, b) => a.name.localeCompare(b.name));
        const changed = next.length !== this.known.length || next.some((theme, index) => theme.slug !== this.known[index]?.slug || theme.name !== this.known[index]?.name);
        this.known = next;
        if (changed) this.onChange();
        return next;
    }

    themes(): readonly ImportedThemeSummary[] {
        return this.known;
    }

    has(slug: string): boolean {
        return this.known.some((theme) => theme.slug === slug);
    }

    async importFile(path: string): Promise<ThemeImportResult> {
        return this.importing((directory) => ({ kind: "import-file", directory, path }));
    }

    async listInstalled(): Promise<InstalledThemesResult> {
        const reply = await this.run({ kind: "list-installed", roots: this.roots });
        if (reply.kind !== "listed") throw new Error("The theme import process answered a listing with an import.");
        this.listed = new Map();
        const themes = reply.scan.themes.map((theme, index) => {
            const key = `installed-${index}`;
            this.listed.set(key, theme);
            return { key, label: theme.label, extension: theme.extension };
        });
        return { ok: true, themes, cut: reply.scan.cut };
    }

    async importInstalled(key: string): Promise<ThemeImportResult> {
        const theme = this.listed.get(key);
        if (theme === undefined) return { ok: false, reason: "That theme is not in the list. Open the list again." };
        return this.importing((directory) => ({ kind: "import-installed", directory, theme }));
    }

    // The task saves into an empty staging folder; whatever it saved is then installed, one extension per theme.
    private async importing(task: (directory: string) => ThemeTask): Promise<ThemeImportResult> {
        const staging = this.extensions.newStaging();
        try {
            const reply = await this.run(task(staging));
            if (reply.kind !== "imported") throw new Error("The theme import process answered an import with a listing.");
            return this.finish(reply.outcome, staging);
        } finally {
            this.extensions.discard(staging);
        }
    }

    private finish(outcome: ImportOutcome, staging: string): ThemeImportResult {
        if (!outcome.ok) return outcome;
        const imported: ImportedThemeSummary[] = [];
        const skipped = [...outcome.skipped];
        let firstFailure: string | undefined;
        for (const summary of outcome.imported) {
            const failure = this.install(summary, join(staging, `${summary.slug}.json`));
            if (failure === undefined) {
                imported.push(summary);
                continue;
            }
            firstFailure ??= failure;
            skipped.push(`${summary.name}: ${failure}`);
        }
        if (imported.length === 0) return { ok: false, reason: firstFailure ?? "Vera could not install that theme." };
        return { ok: true, imported, themes: this.load(), skipped };
    }

    // The reason it could not be installed, or undefined once it is.
    private install(summary: ImportedThemeSummary, file: string): string | undefined {
        let folder: string | undefined;
        try {
            folder = stageSavedTheme(this.extensions, summary, file, "move");
            const result = this.extensions.commit(folder);
            if (!result.ok) this.extensions.discard(folder);
            return result.ok ? undefined : result.reason;
        } catch {
            if (folder !== undefined) this.extensions.discard(folder);
            return `Vera could not install "${savedThemeExtensionId(summary.slug)}".`;
        }
    }
}
