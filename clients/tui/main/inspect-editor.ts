import { openFileInEditor } from "../../external-editor.ts";
import type { TuiRuntime } from "./runtime.ts";
import { renderState } from "./render-state.ts";
import { focusActiveSurface } from "./focus-switch.ts";

const editing = new WeakSet<TuiRuntime>();

export async function openInspectEditor(rt: TuiRuntime): Promise<void> {
    const document = rt.documentDialog;
    if (document?.editorPath === undefined || editing.has(rt)) return;
    editing.add(rt);
    rt.renderer.suspend();
    try {
        await openFileInEditor(document.editorPath);
        if (rt.documentDialog === document) await document.onEditorClosed?.();
    } catch (error) {
        if (rt.documentDialog === document) {
            rt.documentDialog = { ...document, footerText: `Could not open editor: ${String(error)}` };
        }
    } finally {
        editing.delete(rt);
        rt.renderer.resume();
        renderState(rt);
        focusActiveSurface(rt);
    }
}
