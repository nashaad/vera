import { useState, type ClipboardEvent, type DragEvent } from "react";
import { FeedbackIcon } from "../components/Icons.tsx";
import { baseName, isImageFile } from "../composer/images.ts";
import { useRouter } from "../pages/router.tsx";
import { feedbackScreenshot } from "./store.ts";
import { OverlaySheet } from "./OverlaySheet.tsx";

export function FeedbackSheet({ onClose }: { readonly onClose: () => void }) {
    const { route } = useRouter();
    const bridge = window.veraDesktop;
    const screenshot = feedbackScreenshot();
    const [include, setInclude] = useState(false);
    const [kind, setKind] = useState<"bug" | "feature">("bug");
    const [title, setTitle] = useState("");
    const [description, setDescription] = useState("");
    const [images, setImages] = useState<readonly string[]>([]);
    const [error, setError] = useState<string>();
    const [saved, setSaved] = useState<string>();
    const [busy, setBusy] = useState(false);
    const add = (paths: readonly string[]) => {
        setImages((current) => {
            const limit = 4 - (include ? 1 : 0);
            const next = [...current];
            for (const path of paths) if (isImageFile(path) && !next.includes(path) && next.length < limit) next.push(path);
            return next;
        });
    };
    const addFiles = async (files: readonly File[]) => {
        const paths: string[] = [];
        for (const file of files.slice(0, 4)) {
            const path = bridge.pathForFile(file);
            if (path !== undefined) paths.push(path);
            else if (file.type.startsWith("image/") && file.size <= 10 * 1024 * 1024) {
                const savedPath = await bridge.savePastedImage(new Uint8Array(await file.arrayBuffer()), file.type);
                if (savedPath !== undefined) paths.push(savedPath);
            }
        }
        add(paths);
    };
    const drop = (event: DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        void addFiles([...event.dataTransfer.files]);
    };
    const paste = (event: ClipboardEvent<HTMLDivElement>) => {
        if (event.clipboardData.files.length === 0) return;
        event.preventDefault();
        void addFiles([...event.clipboardData.files]);
    };
    const save = async () => {
        setBusy(true);
        setError(undefined);
        try {
            if (bridge === undefined) throw new Error("Feedback is available in the desktop window.");
            const paths = [...images];
            if (include && screenshot !== undefined) {
                const encoded = screenshot.slice(screenshot.indexOf(",") + 1);
                const data = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
                const path = await bridge.savePastedImage(data, "image/png");
                if (path === undefined) throw new Error("Could not attach the screenshot.");
                paths.unshift(path);
            }
            const result = await bridge.saveFeedback({ kind, title, description, image_paths: paths,
                ...(route.kind === "session" ? { session_id: route.agentId } : {}) });
            if (!result.ok) throw new Error(result.reason);
            setSaved(result.path);
        } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save the report."); }
        finally { setBusy(false); }
    };
    return <OverlaySheet title="Report a bug or request a feature" Icon={FeedbackIcon} onClose={onClose} name="feedback" foot={
        saved === undefined ? <><button className="ghost-btn" onClick={onClose}>Cancel</button><button className="solid-btn" disabled={busy || title.trim() === ""} onClick={() => void save()}>Save report</button></>
            : <button className="ghost-btn" onClick={onClose}>Close</button>
    }>
        {saved !== undefined ? <div className="feedback-form"><p>Report saved on this computer.</p><button className="ghost-btn" onClick={() => void bridge.revealFolder(saved)}>Show in file manager</button></div> :
            <div className="feedback-form" onDrop={drop} onDragOver={(event) => event.preventDefault()} onPaste={paste}>
                <label>Kind<select value={kind} onChange={(event) => setKind(event.target.value as "bug" | "feature")}><option value="bug">Bug</option><option value="feature">Feature request</option></select></label>
                <label>Title<input autoFocus value={title} maxLength={200} onChange={(event) => setTitle(event.target.value)} /></label>
                <label>Description<textarea value={description} maxLength={20000} onChange={(event) => setDescription(event.target.value)} /></label>
                <label className="feedback-check"><input type="checkbox" checked={include} disabled={screenshot === undefined || (!include && images.length >= 4)} onChange={(event) => setInclude(event.target.checked)} /> Include a screenshot of this window</label>
                {screenshot === undefined ? <span>Screenshot unavailable.</span> : null}
                {include && screenshot !== undefined ? <div><img className="feedback-thumbnail" src={screenshot} alt="Screenshot of this window" /><button className="ghost-btn" onClick={() => setInclude(false)}>Remove screenshot</button></div> : null}
                <button className="ghost-btn" disabled={images.length + (include ? 1 : 0) >= 4} onClick={() => void bridge.chooseImages().then(add)}>Add image</button>
                <span>Drop or paste images here.</span>
                {images.map((path) => <div key={path}>{baseName(path)} <button className="ghost-btn" onClick={() => setImages((current) => current.filter((item) => item !== path))}>Remove</button></div>)}
                {error === undefined ? null : <p role="alert">{error}</p>}
            </div>}
    </OverlaySheet>;
}
