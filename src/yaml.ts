interface YamlParser {
    parse(source: string): unknown;
}

interface YamlEnvironment {
    readonly Bun?: { readonly YAML: YamlParser };
}

export function parseYaml(source: string): unknown {
    const runtime = globalThis as typeof globalThis & YamlEnvironment;
    if (runtime.Bun !== undefined) return runtime.Bun.YAML.parse(source);
    return (require("yaml") as typeof import("yaml")).parse(source);
}
