import { useState } from "react";

import { runExtensionCommand } from "../../extensions/run-command.ts";
import { useDesktopExtensions } from "../../extensions/useExtensionOn.ts";
import type { DesktopMenuItem } from "../../protocol/extensions.ts";
import type { ImportReport } from "../../theme/import-flow.ts";
import { SettingRow } from "./SettingRow.tsx";

export interface ExtensionRowsViewProps {
    readonly rows: readonly DesktopMenuItem[];
    readonly busy: boolean;
    readonly report: ImportReport | undefined;
    readonly onRun: (command: string) => void;
}

export function ExtensionRowsView({ rows, busy, report, onRun }: ExtensionRowsViewProps) {
    if (rows.length === 0) return null;
    return (
        <>
            {rows.map((row) => (
                <SettingRow key={row.command} name={row.title} description={row.description ?? ""}>
                    <button
                        type="button"
                        className="ghost-btn"
                        data-extension-command={row.command}
                        disabled={busy}
                        onClick={() => onRun(row.command)}
                    >
                        {row.button ?? "Run"}
                    </button>
                </SettingRow>
            ))}
            {report === undefined ? null : (
                <p className="appearance-import-note" role="status" data-import-ok={report.ok}>{report.message}</p>
            )}
        </>
    );
}

// The rows enabled extensions list under `menus.appearance`. The web client has no desktop bridge and no
// extensions, so it shows none.
export function ExtensionRows() {
    const bridge = globalThis.window?.veraDesktop;
    const extensions = useDesktopExtensions();
    const [busy, setBusy] = useState(false);
    const [report, setReport] = useState<ImportReport | undefined>(undefined);
    if (bridge === undefined || extensions === undefined) return null;
    const rows = extensions.filter((extension) => extension.enabled).flatMap((extension) => extension.menus.appearance);

    async function run(command: string): Promise<void> {
        setBusy(true);
        setReport(undefined);
        await runExtensionCommand(command, setReport, bridge);
        setBusy(false);
    }

    return <ExtensionRowsView rows={rows} busy={busy} report={report} onRun={(command) => void run(command)} />;
}
