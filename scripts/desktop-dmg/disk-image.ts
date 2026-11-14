import { rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";

import { run } from "./run.ts";

export const VOLUME_NAME = "Vera";

// The staging directory already holds Vera.app; the volume also gets a link to /Applications to drag it onto.
export function createDiskImage(stagingDirectory: string, image: string): void {
    rmSync(join(stagingDirectory, "Applications"), { force: true });
    symlinkSync("/Applications", join(stagingDirectory, "Applications"));
    rmSync(image, { force: true });
    run("hdiutil", ["create", "-volname", VOLUME_NAME, "-srcfolder", stagingDirectory, "-format", "UDZO", "-ov", image]);
}
