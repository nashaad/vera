import { useState } from "react";

import type { InstalledThemeEntry } from "../../protocol/themes.ts";
import { importInstalledTheme, importThemeFromPicker, type ImportReport } from "../../theme/import-flow.ts";
import { SettingRow } from "./SettingRow.tsx";

type InstalledList =
    | { readonly kind: "closed" }
    | { readonly kind: "loading" }
    | { readonly kind: "open"; readonly themes: readonly InstalledThemeEntry[]; readonly cut: boolean };

// Import controls for Settings > Appearance. The web client has no desktop bridge, so it shows none.
export function ThemeImport() {
    const bridge = globalThis.window?.veraDesktop;
    const [busy, setBusy] = useState(false);
    const [report, setReport] = useState<ImportReport | undefined>(undefined);
    const [installed, setInstalled] = useState<InstalledList>({ kind: "closed" });
    if (bridge === undefined) return null;

    async function finish(work: Promise<ImportReport | undefined>): Promise<void> {
        setBusy(true);
        const result = await work;
        setBusy(false);
        if (result !== undefined) setReport(result);
    }

    async function showInstalled(): Promise<void> {
        if (bridge === undefined) return;
        setReport(undefined);
        setInstalled({ kind: "loading" });
        try {
            const result = await bridge.listInstalledThemes();
            if (result.ok) {
                setInstalled({ kind: "open", themes: result.themes, cut: result.cut });
            } else {
                setInstalled({ kind: "closed" });
                setReport({ ok: false, message: result.reason });
            }
        } catch {
            setInstalled({ kind: "closed" });
            setReport({ ok: false, message: "Vera could not list the themes installed in VS Code." });
        }
    }

    return (
        <>
            <SettingRow
                name="Import a VS Code theme"
                description="Choose a theme .json file or a .vsix extension package. Colors carry over; fonts, sizes and spacing stay Vera's."
            >
                <button
                    type="button"
                    className="ghost-btn"
                    data-theme-import="file"
                    disabled={busy}
                    onClick={() => void finish(importThemeFromPicker(bridge))}
                >
                    Import…
                </button>
            </SettingRow>
            <SettingRow name="Installed in VS Code" description="Themes from the extensions installed in VS Code on this machine.">
                <button
                    type="button"
                    className="ghost-btn"
                    data-theme-import="installed"
                    disabled={busy || installed.kind === "loading"}
                    onClick={() => void showInstalled()}
                >
                    {installed.kind === "open" ? "Refresh list" : "Show themes"}
                </button>
            </SettingRow>
            {installed.kind === "loading" ? <p className="appearance-import-note">Looking for installed themes…</p> : null}
            {installed.kind === "open" ? (
                <InstalledThemes
                    themes={installed.themes}
                    cut={installed.cut}
                    busy={busy}
                    onPick={(key) => void finish(importInstalledTheme(key, bridge))}
                />
            ) : null}
            {report === undefined ? null : (
                <p className="appearance-import-note" role="status" data-import-ok={report.ok}>{report.message}</p>
            )}
        </>
    );
}

interface InstalledThemesProps {
    readonly themes: readonly InstalledThemeEntry[];
    readonly cut: boolean;
    readonly busy: boolean;
    readonly onPick: (key: string) => void;
}

function InstalledThemes({ themes, cut, busy, onPick }: InstalledThemesProps) {
    if (themes.length === 0) {
        return <p className="appearance-import-note">VS Code has no themed extensions installed here.</p>;
    }
    return (
        <>
            <ul className="appearance-installed" aria-label="Themes installed in VS Code">
                {themes.map((theme) => (
                    <li key={theme.key}>
                        <button type="button" disabled={busy} data-installed-theme={theme.label} onClick={() => onPick(theme.key)}>
                            <span className="appearance-installed-name">{theme.label}</span>
                            <span className="appearance-installed-extension">{theme.extension}</span>
                        </button>
                    </li>
                ))}
            </ul>
            {cut ? <p className="appearance-import-note">More themes are installed than this list shows.</p> : null}
        </>
    );
}
