import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { handleTuiExtensionsListKey, openTuiExtensionsList } from "../../clients/tui/extensions-list.ts";
import { applyPluginExtensionStates, pluginExtensionEntries } from "../../clients/tui/main/extensions-ops.ts";
import { installPlugin, listPlugins, setPluginEnabled } from "../../src/plugins/manager.ts";

function fixture() {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "vera-plugin-migrate-tui-"));
    return { root, home: join(root, "home") };
}

test("the extensions picker shows plugin extensions and makes them read-only", () => {
    const f = fixture();
    try {
        const source = join(f.root, "source");
        mkdirSync(source);
        writeFileSync(join(source, "vera.extension.json"), JSON.stringify({
            id: "crow.pick", sdk: "1", version: "1.0.0", entrypoint: "extension.ts", capabilities: [],
        }));
        writeFileSync(join(source, "extension.ts"), "export default {};\n");
        installPlugin(source, { home: f.home });
        setPluginEnabled("crow.pick", false, { home: f.home });
        const plugins = listPlugins({ home: f.home }).plugins;
        const entries = pluginExtensionEntries(plugins);
        expect(entries).toHaveLength(1);
        let state = applyPluginExtensionStates(openTuiExtensionsList(entries), plugins);
        expect(state.rows[0]).toMatchObject({ id: "crow.pick", status: "disabled", source: "Plugin crow.pick", managed: false });
        expect(handleTuiExtensionsListKey(state, { name: "space" }).mutate).toBeUndefined();
        state = handleTuiExtensionsListKey(state, { name: "return" }).state!;
        const detail = handleTuiExtensionsListKey(state, { name: "return" });
        expect(detail.mutate).toBeUndefined();
        expect(detail.command).toBeUndefined();
    } finally { rmSync(f.root, { recursive: true, force: true }); }
});
