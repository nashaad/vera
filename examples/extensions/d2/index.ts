import {
    DEFAULT_MAX_WIDTH,
    renderD2,
    type D2CharacterSet,
} from "./render.ts";

const MIN_MAX_WIDTH = 20;
const MAX_MAX_WIDTH = 500;

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
                max_width: {
                    type: "integer",
                    minimum: MIN_MAX_WIDTH,
                    maximum: MAX_MAX_WIDTH,
                    default: DEFAULT_MAX_WIDTH,
                    description: "Maximum terminal columns for the rendered "
                        + "diagram. Wide diagrams return guidance for making "
                        + "the layout more compact.",
                },
            },
            required: ["source"],
            additionalProperties: false,
        },
        permissionOperation: "diagram.render",
        async run({ input, workspace, signal }) {
            const source = requiredSource(input.source);
            const characterSet = parseCharacterSet(input.character_set);
            const maxWidth = parseMaxWidth(input.max_width);
            const result = await renderD2(
                source,
                characterSet,
                workspace,
                signal,
                undefined,
                maxWidth,
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

function parseMaxWidth(value: unknown): number {
    if (value === undefined) {
        return DEFAULT_MAX_WIDTH;
    }
    if (
        typeof value === "number"
        && Number.isInteger(value)
        && value >= MIN_MAX_WIDTH
        && value <= MAX_MAX_WIDTH
    ) {
        return value;
    }
    throw new Error(
        `render_d2 max_width must be an integer from ${MIN_MAX_WIDTH} to `
            + MAX_MAX_WIDTH,
    );
}
