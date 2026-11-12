import type { ReactNode } from "react";

import { LAYOUT_COMMANDS } from "../../commands/layout-commands.ts";
import { THEME_COMMANDS } from "../../commands/theme-commands.ts";
import type { DesktopBridge } from "../../protocol/bridge.ts";
import { showToast } from "../../overlays/toasts.ts";
import { DEFAULT_APPEARANCE, changeAppearance } from "../../theme/preferences.ts";
import { DEFAULT_THEME } from "../../theme/tokens.ts";
import { useViewEnvironment } from "../../views/env.tsx";
import { useWorkbench } from "../../workbench/context.tsx";
import { desktopFolder, sessionCountLabel } from "./data.ts";

interface DataRowProps {
    readonly name: string;
    readonly description: ReactNode;
    readonly children?: ReactNode;
}

// Mirrors SettingRow, which takes a text description only; this row also takes the folder path as code.
function DataRow({ name, description, children }: DataRowProps) {
    return (
        <div className="setting">
            <div className="setting-body">
                <div className="setting-name">{name}</div>
                <div className="setting-desc">{description}</div>
            </div>
            {children}
        </div>
    );
}

export function DataSection() {
    const { connection } = useViewEnvironment();
    const { run } = useWorkbench();
    const bridge: DesktopBridge | undefined = window.veraDesktop;
    const attached = connection.phase === "attached";
    const sessionCount = sessionCountLabel(connection.sessionRows?.length, attached);
    const folder = desktopFolder(connection.ready?.home);
    const revealLabel = bridge?.platform === "darwin" ? "Show in Finder" : "Open folder";

    async function reveal(path: string): Promise<void> {
        if (bridge === undefined) return;
        const opened = await bridge.revealFolder(path).catch(() => false);
        if (!opened) showToast("The folder could not be opened", "danger");
    }

    // The appearance is stored first, so the theme command, which re-applies stored appearance, keeps the defaults.
    function resetAppearance(): void {
        changeAppearance(DEFAULT_APPEARANCE);
        run(THEME_COMMANDS[DEFAULT_THEME]);
        showToast("Appearance reset", "success");
    }

    function resetLayout(): void {
        run(LAYOUT_COMMANDS.reset);
        showToast("Layout reset", "success");
    }

    return (
        <>
            <h1>Data</h1>
            <p className="settings-lede">What this desktop keeps in the Vera home it is attached to. Sessions and settings belong to the host; the folder, appearance and layout are the window's own.</p>
            <DataRow name="Sessions" description="Listed by the host this window is attached to">
                <span className="data-value">{sessionCount}</span>
            </DataRow>
            <DataRow
                name="Desktop folder"
                description={folder === undefined ? "Known once Vera is connected" : <code className="data-path">{folder}</code>}
            >
                <button
                    type="button"
                    className="ghost-btn"
                    disabled={folder === undefined || bridge === undefined}
                    onClick={() => {
                        if (folder !== undefined) void reveal(folder);
                    }}
                >
                    {revealLabel}
                </button>
            </DataRow>
            <DataRow
                name="Appearance"
                description="Theme, text size, code size, density and motion, kept in this desktop's browser storage"
            >
                <button type="button" className="ghost-btn" onClick={resetAppearance}>
                    Reset
                </button>
            </DataRow>
            <DataRow name="Layout" description="Pane sizes, what is shown and where, kept in machine/desktop/layout.json">
                <button type="button" className="ghost-btn" onClick={resetLayout}>
                    Reset
                </button>
            </DataRow>
        </>
    );
}
