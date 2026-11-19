import { homedir } from "node:os";
import { join } from "node:path";

const BUNDLED_APP_EXTENSIONS = "/Applications/Visual Studio Code.app/Contents/Resources/app/extensions";

// Where VS Code keeps extensions: the user's folder, and on macOS the themes that ship inside the app.
export function extensionRoots(platform: string = process.platform): readonly string[] {
    const roots = [join(homedir(), ".vscode", "extensions")];
    if (platform === "darwin") roots.push(BUNDLED_APP_EXTENSIONS);
    return roots;
}
