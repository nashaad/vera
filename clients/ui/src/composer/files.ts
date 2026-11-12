import type { DesktopBridge } from "../protocol/bridge.ts";
import { isImageFile } from "./images.ts";

// Dropped or pasted files as paths the host can read. A bitmap with no file behind it is written out first.
export async function imagePathsOf(bridge: DesktopBridge, files: readonly File[]): Promise<readonly string[]> {
    const paths: string[] = [];
    for (const file of files) {
        const path = bridge.pathForFile(file);
        if (path !== undefined) {
            if (isImageFile(path)) paths.push(path);
            continue;
        }
        if (!file.type.startsWith("image/")) continue;
        const saved = await bridge.savePastedImage(new Uint8Array(await file.arrayBuffer()), file.type);
        if (saved !== undefined) paths.push(saved);
    }
    return paths;
}
