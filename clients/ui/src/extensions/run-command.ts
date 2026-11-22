import { queuePageCapture } from "../composer/page-captures.ts";
import { readExtensions } from "../customize/desktop-extensions.ts";
import { activeSession } from "../session/activeSession.ts";
import { openPicker } from "../overlays/store.ts";
import type { DesktopBridge } from "../protocol/bridge.ts";
import { FAILED, reportImport, UNAVAILABLE, type ImportReport } from "../theme/import-flow.ts";

// Runs one extension command through the desktop shell and hands what it answers to `report`: a result shows
// there, a list opens the picker, and choosing from it runs the command again with that choice. Nothing is
// reported when the person closed a file picker without choosing.
export async function runExtensionCommand(
    command: string,
    report: (outcome: ImportReport) => void,
    bridge: DesktopBridge | undefined = globalThis.window?.veraDesktop,
    pick?: string,
): Promise<void> {
    if (bridge === undefined) {
        report(UNAVAILABLE);
        return;
    }
    const owner = activeSession()?.agentId;
    let result;
    try {
        result = await bridge.runExtensionCommand(command, pick, (progress) => {
            if (progress.ok && progress.kind === "capture" && owner !== undefined) queuePageCapture(owner, progress.capture);
            else if (!progress.ok) report({ ok: false, message: progress.reason });
        });
    } catch {
        report(FAILED);
        return;
    }
    if (result.ok && result.kind === "pick") {
        openPicker({
            title: result.title,
            items: result.items,
            cut: result.cut,
            choose: (key) => void runExtensionCommand(command, report, bridge, key),
        });
        return;
    }
    if (result.ok && result.kind === "capture") {
        if (owner !== undefined) queuePageCapture(owner, result.capture);
        return;
    }
    if (result.ok && result.kind === "closed") return;
    if (result.ok && result.kind === "themes" && result.imported.length > 0) await readExtensions(bridge);
    const outcome = reportImport(result);
    if (outcome !== undefined) report(outcome);
}
