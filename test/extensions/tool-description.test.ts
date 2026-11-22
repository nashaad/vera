import { afterEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startExtensionRegistry } from "../../src/extensions/registry.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("@core setDescription changes only the extension's own tool and reports one change", async () => {
    const changes: Array<{ extensionId: string; name: string; description: string }> = [];
    const other = createExtension("other.extension", `
        export function activate(vera) {
            vera.tools.register({
                name: "foreign_tool",
                description: "Other extension's tool",
                inputSchema: { type: "object", properties: {}, additionalProperties: false },
                run() { return { output: "foreign" }; },
            });
        }
    `);
    const owner = createExtension("owner.extension", `
        export function activate(vera) {
            vera.tools.register({
                name: "owned_tool",
                description: "First description",
                inputSchema: { type: "object", properties: {}, additionalProperties: false },
                run() { return { output: "owned" }; },
            });
            const errors = [];
            for (const name of ["foreign_tool", "missing_tool"]) {
                try {
                    vera.tools.setDescription(name, "Hijacked description");
                } catch (error) {
                    errors.push(String(error));
                }
            }
            vera.commands.register({
                name: "set-description-errors",
                description: "Return the setDescription errors",
                usage: "/set-description-errors",
                run() { return { kind: "text", text: errors.join("\\n") }; },
            });
            vera.tools.setDescription("owned_tool", "Second description");
            vera.tools.setDescription("owned_tool", "Second description");
            vera.tools.setDescription("owned_tool", "  Second description  ");
        }
    `, ["tools.register", "commands.register"]);
    const registry = await startExtensionRegistry({
        extensions: [configured(other), configured(owner)],
        onToolDescriptionChanged: (extensionId, name, description) => changes.push({ extensionId, name, description }),
    });
    try {
        const tool = registry.tools().find((entry) => entry.definition.name === "owned_tool")!;
        const foreign = registry.tools().find((entry) => entry.definition.name === "foreign_tool")!;
        expect(tool.definition.description).toBe("Second description");
        expect(foreign.definition.description).toBe("Other extension's tool");
        expect(changes).toEqual([
            { extensionId: "owner.extension", name: "owned_tool", description: "Second description" },
        ]);
        const outcome = await registry.invokeCommand("set-description-errors", "", createDirectory());
        expect(outcome.body).toEqual({
            kind: "text",
            text: "Error: Extension owner.extension did not register tool foreign_tool\n"
                + "Error: Extension owner.extension did not register tool missing_tool",
        });
        registry.setToolDescription("owner.extension", "owned_tool", "Third description");
        expect(tool.definition.description).toBe("Third description");
        registry.setToolDescription("owner.extension", "owned_tool", "Third description");
        expect(changes).toHaveLength(1);
        registry.setToolDescription("missing.extension", "owned_tool", "Fourth description");
        expect(tool.definition.description).toBe("Third description");
    } finally { await registry.close(); }
});

function createExtension(
    id: string,
    source: string,
    capabilities: readonly string[] = ["tools.register"],
): string {
    const directory = createDirectory();
    writeFileSync(join(directory, "vera.extension.json"), JSON.stringify({
        id,
        version: "1.0.0",
        sdk: "1",
        entrypoint: "./extension.ts",
        capabilities,
    }));
    writeFileSync(join(directory, "extension.ts"), source);
    return directory;
}

function configured(path: string) {
    return { path, enabled: true, config: null };
}

function createDirectory(): string {
    const directory = join(tmpdir(), `vera-tool-description-${crypto.randomUUID()}`);
    mkdirSync(directory);
    temporaryDirectories.push(directory);
    return directory;
}
