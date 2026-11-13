import type { ImportedThemeSummary } from "../../ui/src/theme/imported.ts";
import type { InstalledThemesResult, ThemeImportResult } from "../../ui/src/protocol/themes.ts";
import type { ImportOutcome, InstalledTheme, ThemeTask, ThemeTaskReply } from "./theme-import/task-protocol.ts";
import { extensionRoots } from "./theme-import/roots.ts";
import { ThemeStore } from "./theme-store.ts";

export type RunThemeTask = (task: ThemeTask) => Promise<ThemeTaskReply>;

// The desktop's imported themes: what is saved under the home, and the installed VS Code themes last listed.
// Reading and converting theme files is a task for `run`, which the app sends to its own process.
export class ThemeService {
    private readonly store: ThemeStore;
    private known: readonly ImportedThemeSummary[] = [];
    private listed = new Map<string, InstalledTheme>();

    constructor(
        private readonly directory: string,
        private readonly run: RunThemeTask,
        private readonly roots: readonly string[] = extensionRoots(),
        private readonly onChange: () => void = () => {},
    ) {
        this.store = new ThemeStore(directory);
    }

    // Reads the saved themes again, so a file added by hand shows up.
    load(): readonly ImportedThemeSummary[] {
        const next = this.store.list();
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
        return this.finish(await this.importing({ kind: "import-file", directory: this.directory, path }));
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
        return this.finish(await this.importing({ kind: "import-installed", directory: this.directory, theme }));
    }

    private async importing(task: ThemeTask): Promise<ImportOutcome> {
        const reply = await this.run(task);
        if (reply.kind !== "imported") throw new Error("The theme import process answered an import with a listing.");
        return reply.outcome;
    }

    private finish(outcome: ImportOutcome): ThemeImportResult {
        if (!outcome.ok) return outcome;
        return { ok: true, imported: outcome.imported, themes: this.load(), skipped: outcome.skipped };
    }
}
