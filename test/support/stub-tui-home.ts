import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function createStubTuiHome(prefix: string): string {
    const home = mkdtempSync(join(tmpdir(), prefix));
    const veraHome = join(home, ".vera");
    mkdirSync(veraHome);
    writeFileSync(join(veraHome, "config.json"), JSON.stringify({
        schema_version: 1, provider: "stub", model: "test", approval_mode: "auto",
        providers: { stub: { protocol: "openai-chat", base_url: "http://127.0.0.1:1/v1", credential: "none" } },
    }));
    return home;
}
