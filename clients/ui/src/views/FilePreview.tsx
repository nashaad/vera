import { useEffect, useState, useSyncExternalStore } from "react";

import { RefreshIcon } from "../components/Icons.tsx";
import { BrowserCommands } from "../extensions/BrowserCommands.tsx";
import { desktopExtensions, subscribeDesktopExtensions } from "../extensions/state.ts";

import { MAX_FILE_PREVIEW_BYTES, type DesktopBridge, type FilePreview as Preview } from "../protocol/bridge.ts";
import { byteSize, gutterText, lineCount } from "./files.ts";
import { useTurnsEnded } from "./useTurnsEnded.ts";

export interface FilePreviewProps {
    readonly bridge: DesktopBridge;
    readonly path: string;
    readonly folder: string;
    readonly visible: boolean;
    readonly running: boolean;
}

interface ActiveScope {
    readonly token: string;
    readonly url: string;
    readonly path: string;
    readonly folder: string;
}

interface Shown {
    readonly path: string;
    readonly preview: Preview;
}

// Read again when the pane comes back into view and when a turn ends, keeping the last text on screen meanwhile.
export function FilePreview({ bridge, folder, path, visible, running }: FilePreviewProps) {
    const extensions = useSyncExternalStore(subscribeDesktopExtensions, desktopExtensions);
    const suffix = path.split(".").pop()?.toLowerCase();
    const supported = suffix !== undefined && (extensions?.some((entry) => entry.enabled && entry.filePreviews?.includes(suffix)) ?? false);
    const [mode, setMode] = useState<"source" | "preview">("source");
    const [openedScope, setScope] = useState<ActiveScope | undefined>();
    const scope = openedScope?.path === path && openedScope.folder === folder && visible && mode === "preview" ? openedScope : undefined;
    const [error, setError] = useState<string | undefined>();
    const [round, setRound] = useState(0);
    const [shown, setShown] = useState<Shown | undefined>(undefined);
    const turnsEnded = useTurnsEnded(running);

    useEffect(() => {
        if (!visible) return;
        let current = true;
        void bridge.readFilePreview(path).then((preview) => {
            if (current) setShown({ path, preview });
        });
        return () => {
            current = false;
        };
    }, [bridge, path, visible, turnsEnded]);

    useEffect(() => {
        if (!visible || mode !== "preview" || !supported) return;
        let current = true;
        let token: string | undefined;
        setScope(undefined);
        setError(undefined);
        void bridge.openLocalPreview(folder, path).then((result) => {
            if (!result.ok) { if (current) setError(result.reason); return; }
            if (!current) { bridge.closeLocalPreview(result.token); return; }
            token = result.token;
            setScope({ ...result, path, folder });
        }).catch(() => { if (current) setError("That file cannot be previewed."); });
        return () => { current = false; if (token !== undefined) bridge.closeLocalPreview(token); };
    }, [bridge, folder, path, visible, mode, supported]);

    const preview = shown?.path === path ? shown.preview : undefined;
    const frameName = scope === undefined ? undefined : `preview-${scope.token}`;
    return (
        <div className="file-preview">
            {supported ? <div className="local-preview-controls">
                <div className="right-seg" role="group" aria-label="File view">
                    <button type="button" className="right-seg-option" data-on={mode === "source"} aria-pressed={mode === "source"} onClick={() => setMode("source")}>Source</button>
                    <button type="button" className="right-seg-option" data-on={mode === "preview"} aria-pressed={mode === "preview"} onClick={() => setMode("preview")}>Preview</button>
                </div>
                {mode === "preview" ? <>
                    <button type="button" className="icon-button" aria-label="Reload" title="Reload" data-page-reload="" disabled={scope === undefined} onClick={() => setRound((value) => value + 1)}><RefreshIcon /></button>
                    <BrowserCommands hasPage={visible && scope !== undefined} onError={setError} frameName={frameName} />
                </> : null}
            </div> : null}
            {mode === "source" || !supported ? <PreviewBody preview={preview} /> : <>
                {error === undefined ? null : <p className="file-preview-note" role="alert">{error}</p>}
                {visible && scope !== undefined ? <iframe key={`${scope.token}:${round}`} className="browser-frame local-preview-frame" name={frameName} title="File preview" src={scope.url} sandbox="allow-scripts allow-same-origin allow-forms" /> : null}
            </>}
        </div>
    );
}

function PreviewBody({ preview }: { readonly preview: Preview | undefined }) {
    if (preview === undefined) return <p className="file-preview-note">Reading…</p>;
    if (!preview.ok) return <p className="file-preview-note">{preview.reason}</p>;
    if (preview.text === "") return <p className="file-preview-note">Empty file</p>;
    return (
        <>
            {preview.cut ? (
                <p className="file-preview-note">Showing the first {byteSize(MAX_FILE_PREVIEW_BYTES)} of {byteSize(preview.size)}.</p>
            ) : null}
            <div className="file-preview-text">
                <pre className="file-preview-gutter" aria-hidden="true">{gutterText(lineCount(preview.text))}</pre>
                <pre className="file-preview-lines">{preview.text}</pre>
            </div>
        </>
    );
}
