import { defaultVeraConfigPath } from "../src/config.ts";

export function veraConfigPath(): string {
    return defaultVeraConfigPath();
}

export { editorCommand, openFileInEditor } from "./external-editor.ts";
