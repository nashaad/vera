import type { DesktopBridge } from "../protocol/bridge.ts";
import { FILE_SIZE_LIMIT } from "../../../../src/attachments/file-limits.ts";

export async function pathsOfFiles(bridge: DesktopBridge, files: readonly File[]): Promise<{ readonly paths: readonly string[]; readonly refused: boolean }> {
    const paths: string[] = [];
    let refused = false;
    for (const file of files) {
        const path = bridge.pathForFile(file);
        if (path !== undefined) {
            paths.push(path);
            continue;
        }
        if (!file.type.startsWith("image/") || file.size > FILE_SIZE_LIMIT) { refused = true; continue; }
        const saved = await bridge.savePastedImage(new Uint8Array(await file.arrayBuffer()), file.type);
        if (saved !== undefined) paths.push(saved);
        else refused = true;
    }
    return { paths, refused };
}
