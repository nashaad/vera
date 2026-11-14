import { useCallback, useRef, useState } from "react";
import { FILE_COUNT_LIMIT } from "../../../../src/attachments/file-limits.ts";
import type { DesktopBridge } from "../protocol/bridge.ts";
import { baseName, isImageFile } from "./images.ts";

export function useFiles(bridge: DesktopBridge, workspace: string | undefined, chat: boolean, imageCount: number, addImages: (paths: readonly string[]) => void, notice: (message: string) => void) {
    const [files, setFiles] = useState<readonly string[]>([]);
    const [busy, setBusy] = useState(false);
    const checking = useRef(false);
    const held = useRef<readonly string[]>([]);
    const count = useRef(imageCount);
    count.current = imageCount;
    const update = useCallback((next: readonly string[]) => {
        held.current = next;
        setFiles(next);
    }, []);
    const add = useCallback(async (paths: readonly string[]) => {
        if (checking.current) { notice("Wait for files to finish attaching."); return; }
        checking.current = true;
        setBusy(true);
        const images: string[] = [];
        const next: string[] = [];
        try {
            for (const path of paths) {
                if (held.current.includes(path) || next.includes(path)) continue;
                if (held.current.length + next.length + count.current + images.length >= FILE_COUNT_LIMIT) {
                    notice("A message can have up to 8 files.");
                    break;
                }
                const result = await bridge.checkComposerFile(path, workspace, chat);
                if (result.kind === undefined) {
                    notice(`${baseName(path)}: ${result.error ?? "Could not attach this file."}`);
                    continue;
                }
                if (result.kind === "file" && isImageFile(path)) images.push(path);
                else next.push(path);
            }
            update([...held.current, ...next]);
            if (images.length > 0) {
                count.current += images.length;
                addImages(images);
            }
        } catch {
            notice("Could not attach this file.");
        } finally {
            checking.current = false;
            setBusy(false);
        }
    }, [bridge, workspace, chat, addImages, notice, update]);
    const remove = useCallback((path: string) => update(held.current.filter((item) => item !== path)), [update]);
    const clear = useCallback(() => update([]), [update]);
    return { files, add, remove, clear, replace: update, busy };
}
