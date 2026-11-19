import type { CommandRefusal, CommandThemesDone } from "../../ui/src/protocol/extension-commands.ts";
import { summaryOf, type ImportedTheme, type ImportedThemeSummary } from "../../ui/src/theme/imported.ts";
import { savedThemeExtensionId, stageSavedTheme } from "./extensions/saved-theme.ts";
import type { ExtensionStore } from "./extensions/store.ts";
import { ThemeStore } from "./theme-store.ts";

// The themes the picker lists: those of the enabled desktop extensions, plus any theme still saved in the old
// themes folder because it could not be moved into an extension. A command that converts themes in a task process
// sends them back, and each is installed as a desktop extension named `imported.<slug>`.
export class ThemeService {
    private readonly saved: ThemeStore;
    private known: readonly ImportedThemeSummary[] = [];

    constructor(
        private readonly extensions: ExtensionStore,
        savedDirectory: string,
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

    // Whatever a task converted is installed here, one extension per theme.
    install(themes: readonly ImportedTheme[], skipped: readonly string[]): CommandThemesDone | CommandRefusal {
        const imported: ImportedThemeSummary[] = [];
        const notImported = [...skipped];
        let firstFailure: string | undefined;
        for (const theme of themes) {
            const failure = this.installOne(theme);
            if (failure === undefined) {
                imported.push(summaryOf(theme));
                continue;
            }
            firstFailure ??= failure;
            notImported.push(`${theme.name}: ${failure}`);
        }
        if (imported.length === 0) return { ok: false, reason: firstFailure ?? "Vera could not install that theme." };
        return { ok: true, kind: "themes", imported, themes: this.load(), skipped: notImported };
    }

    // The reason it could not be installed, or undefined once it is.
    private installOne(theme: ImportedTheme): string | undefined {
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
