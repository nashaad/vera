import { describeImportRejection } from "../../../src/host/session-import-client.ts";
import { beginSessionResume } from "../main.ts";
import { focusActiveSurface } from "../main/focus-switch.ts";
import { renderState } from "../main/render-state.ts";
import { startTuiImportPicker, type TuiImportScope } from "../settings-picker.ts";
import { appendTuiError, appendTuiNotice } from "../state.ts";
import type { TuiRuntime } from "./runtime.ts";

export function openImportPicker(rt: TuiRuntime, scope: TuiImportScope): void {
    const listImportableSessions = rt.dependencies.listImportableSessions;
    if (listImportableSessions === undefined) {
        rt.state = appendTuiError(rt.state, "This host cannot list conversations to import");
        renderState(rt);
        return;
    }
    const version = ++rt.importListVersion;
    const workspace = rt.client.workspace ?? process.cwd();
    rt.settingsPicker = startTuiImportPicker({ scope, workspace });
    focusActiveSurface(rt);
    renderState(rt);
    const stale = (): boolean =>
        rt.shuttingDown
        || version !== rt.importListVersion
        || rt.settingsPicker?.kind !== "session_import";
    void listImportableSessions(scope === "folder" ? workspace : undefined).then((listing) => {
        if (stale()) return;
        if (listing === undefined) {
            rt.settingsPicker = undefined;
            rt.state = appendTuiError(
                rt.state,
                "Could not list sessions. Check that the Vera host is running.",
            );
            focusActiveSurface(rt);
            renderState(rt);
            return;
        }
        rt.settingsPicker = startTuiImportPicker({ scope, workspace, listing });
        focusActiveSurface(rt);
        renderState(rt);
    });
}

export function importSessionFromTui(rt: TuiRuntime, path: string): void {
    const importSession = rt.dependencies.importSession;
    if (importSession === undefined) {
        rt.state = appendTuiError(rt.state, "This host cannot import conversations");
        return;
    }
    rt.state = appendTuiNotice(rt.state, `Importing ${path}`);
    void importSession(path).then((outcome) => {
        if (rt.shuttingDown) return;
        if (outcome.status === "rejected") {
            rt.state = appendTuiError(
                rt.state,
                describeImportRejection(path, outcome.reason),
            );
            renderState(rt);
            return;
        }
        beginSessionResume(rt,
            outcome.sessionPath,
            outcome.sessionId,
            false,
            false,
            "keep_running",
            "attach",
        );
    }).catch((error) => {
        if (rt.shuttingDown) return;
        rt.state = appendTuiError(
            rt.state,
            error instanceof Error ? error.message : String(error),
        );
        renderState(rt);
    });
}
