import { renderD2, type D2CharacterSet } from "./render.ts";

interface ExtensionApi {
    readonly tools: {
        register(spec: {
            readonly name: string;
            readonly description: string;
            readonly inputSchema: Readonly<Record<string, unknown>>;
            readonly permissionOperation?: string;
            readonly run: (request: {
                readonly input: Readonly<Record<string, unknown>>;
                readonly workspace: string;
                readonly signal: AbortSignal;
            }) => Promise<{
                readonly output: string;
                readonly isError?: boolean;
                readonly presentation?: {
                    readonly kind: "tool_notice";
                    readonly text: string;
                };
            }>;
        }): void;
    };
}

export function activate(vera: ExtensionApi): void {
    vera.tools.register({
        name: "render_d2",
        description: "Render D2 source as terminal-friendly text.",
        inputSchema: {
            type: "object",
            properties: {
                source: {
                    type: "string",
                    description: "Complete D2 diagram source.",
                },
                character_set: {
                    type: "string",
                    enum: ["unicode", "ascii"],
                    description: "Unicode box drawing by default; use ASCII "
                        + "only when maximum terminal portability is needed.",
                },
            },
            required: ["source"],
            additionalProperties: false,
        },
        permissionOperation: "diagram.render",
        async run({ input, workspace, signal }) {
            const source = requiredSource(input.source);
            const characterSet = parseCharacterSet(input.character_set);
            const result = await renderD2(
                source,
                characterSet,
                workspace,
                signal,
            );
            return result.isError
                ? result
                : {
                    ...result,
                    presentation: {
                        kind: "tool_notice",
                        text: result.output,
                    },
                };
        },
    });
}

function requiredSource(value: unknown): string {
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new Error("render_d2 requires non-empty D2 source");
    }
    return value;
}

function parseCharacterSet(value: unknown): D2CharacterSet {
    if (value === undefined || value === "unicode") {
        return "unicode";
    }
    if (value === "ascii") {
        return value;
    }
    throw new Error("render_d2 character_set must be unicode or ascii");
}
