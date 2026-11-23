import { useState, type ReactNode } from "react";

import { LAYOUT_COMMANDS } from "../../commands/layout-commands.ts";
import { THEME_COMMANDS } from "../../commands/theme-commands.ts";
import type { DesktopBridge } from "../../protocol/bridge.ts";
import { STORAGE_CAPABILITY } from "../../protocol/storage.ts";
import { showToast } from "../../overlays/toasts.ts";
import { DEFAULT_APPEARANCE, changeAppearance } from "../../theme/preferences.ts";
import { DEFAULT_THEME } from "../../theme/tokens.ts";
import { useViewEnvironment } from "../../views/env.tsx";
import { useWorkbench } from "../../workbench/context.tsx";
import { desktopFolder, sessionCountLabel } from "./data.ts";
import { useSearchHit } from "./RowHighlight.tsx";
import { StorageDialog } from "./StorageDialog.tsx";

interface DataRowProps {
    readonly id: string;
    readonly name: string;
    readonly description: ReactNode;
    readonly children?: ReactNode;
}

// Mirrors SettingRow, which takes a text description only; this row also takes the folder path as code.
function DataRow({ id, name, description, children }: DataRowProps) {
    const searchHit = useSearchHit(id);
    return (
        <div className="setting" data-setting-id={id} {...searchHit}>
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
    const home = connection.ready?.home;
    const revealLabel = bridge?.platform === "darwin" ? "Show in Finder" : "Open folder";
    const storageSupported = connection.identity?.capabilities?.includes(STORAGE_CAPABILITY) === true;
    const [storageOpen, setStorageOpen] = useState(false);

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
            <DataRow id="data.sessions" name="Sessions" description="Listed by the host this window is attached to">
                <span className="data-value">{sessionCount}</span>
            </DataRow>
            <DataRow
                id="data.storage"
                name="Storage"
                description={connection.identity !== undefined && !storageSupported
                    ? "Needs a newer Vera host"
                    : "See how much space Vera uses on this computer"}
            >
                <button
                    type="button"
                    className="ghost-btn"
                    disabled={!storageSupported || bridge === undefined || home === undefined}
                    onClick={() => setStorageOpen(true)}
                >
                    Manage
                </button>
            </DataRow>
            <DataRow
                id="data.desktop-folder"
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
                id="data.appearance"
                name="Appearance"
                description="Theme, text size, code size, density and motion, kept in this desktop's browser storage"
            >
                <button type="button" className="ghost-btn" onClick={resetAppearance}>
                    Reset
                </button>
            </DataRow>
            <DataRow id="data.layout" name="Layout" description="Pane sizes, what is shown and where, kept in machine/desktop/layout.json">
                <button type="button" className="ghost-btn" onClick={resetLayout}>
                    Reset
                </button>
            </DataRow>
            {storageOpen && bridge !== undefined && home !== undefined ? (
                <StorageDialog bridge={bridge} home={home} onClose={() => setStorageOpen(false)} />
            ) : null}
        </>
    );
}
