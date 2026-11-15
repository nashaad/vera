import { summaryOf, type ImportedTheme, type ImportedThemeSummary } from "../../ui/src/theme/imported.ts";
import type { InstalledThemesResult, ThemeImportResult } from "../../ui/src/protocol/themes.ts";
import { savedThemeExtensionId, stageSavedTheme } from "./extensions/saved-theme.ts";
import type { ExtensionStore } from "./extensions/store.ts";
import type { ImportOutcome, InstalledTheme, ThemeTask, ThemeTaskReply } from "./theme-import/task-protocol.ts";
import { ThemeStore } from "./theme-store.ts";

export type RunThemeTask = (task: ThemeTask) => Promise<ThemeTaskReply>;

// The themes the picker lists: those of the enabled desktop extensions, plus any theme still saved in the old
// themes folder because it could not be moved into an extension. Importing a VS Code theme converts it in a task
// process, which sends the converted themes back, and each is installed as a desktop extension named `imported.<slug>`.
export class ThemeService {
    private readonly saved: ThemeStore;
    private known: readonly ImportedThemeSummary[] = [];
    private listed = new Map<string, InstalledTheme>();

    constructor(
        private readonly extensions: ExtensionStore,
        savedDirectory: string,
        private readonly run: RunThemeTask,
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
        return this.importing({ kind: "import-file", path });
    }

    async listInstalled(): Promise<InstalledThemesResult> {
        const reply = await this.run({ kind: "list-installed" });
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
        return this.importing({ kind: "import-installed", theme });
    }

    // Whatever the task converted is installed here, one extension per theme.
    private async importing(task: ThemeTask): Promise<ThemeImportResult> {
        const reply = await this.run(task);
        if (reply.kind !== "imported") throw new Error("The theme import process answered an import with a listing.");
        return this.finish(reply.outcome);
    }

    private finish(outcome: ImportOutcome): ThemeImportResult {
        if (!outcome.ok) return outcome;
        const imported: ImportedThemeSummary[] = [];
        const skipped = [...outcome.skipped];
        let firstFailure: string | undefined;
        for (const theme of outcome.themes) {
            const failure = this.install(theme);
            if (failure === undefined) {
                imported.push(summaryOf(theme));
                continue;
            }
            firstFailure ??= failure;
            skipped.push(`${theme.name}: ${failure}`);
        }
        if (imported.length === 0) return { ok: false, reason: firstFailure ?? "Vera could not install that theme." };
        return { ok: true, imported, themes: this.load(), skipped };
    }

    // The reason it could not be installed, or undefined once it is.
    private install(theme: ImportedTheme): string | undefined {
        let folder: string | undefined;
        try {
            folder = stageSavedTheme(this.extensions, theme, { theme });
            const result = this.extensions.commit(folder);
            if (!result.ok) this.extensions.discard(folder);
            return result.ok ? undefined : result.reason;
        } catch {
            if (folder !== undefined) this.extensions.discard(folder);
            return `Vera could not install "${savedThemeExtensionId(theme.slug)}".`;
        }
    }
}
