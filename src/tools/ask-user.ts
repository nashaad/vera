import type {
    AskUserChoice,
    RegisteredTool,
} from "./types.ts";

const MIN_CHOICES = 2;
const MAX_CHOICES = 9;

export const askUserTool: RegisteredTool = {
    requiresUserInteraction: true,
    definition: {
        name: "ask_user",
        description: "Ask the user to choose one of two to nine fixed options.",
        inputSchema: {
            type: "object",
            properties: {
                question: { type: "string" },
                choices: {
                    type: "array",
                    minItems: MIN_CHOICES,
                    maxItems: MAX_CHOICES,
                    items: {
                        type: "object",
                        properties: {
                            id: { type: "string" },
                            label: { type: "string" },
                            preview: {
                                type: "string",
                                description:
                                    "Optional. What this choice concretely looks"
                                    + " like: a layout mockup, a diff, a snippet,"
                                    + " a small ASCII diagram. Shown verbatim in a"
                                    + " monospace box beside the choices. Include"
                                    + " it when the choices differ in a way the"
                                    + " labels cannot show; omit it when it would"
                                    + " only restate the label.",
                            },
                        },
                        required: ["id", "label"],
                        additionalProperties: false,
                    },
                },
            },
            required: ["question", "choices"],
            additionalProperties: false,
        },
    },
    async execute(input) {
        const question = nonEmptyString(input.question, "question");
        if (!Array.isArray(input.choices)) {
            throw new Error("ask_user requires a choices array");
        }
        if (
            input.choices.length < MIN_CHOICES
            || input.choices.length > MAX_CHOICES
        ) {
            throw new Error("ask_user requires two to nine choices");
        }

        const choices = input.choices.map(parseChoice);
        const ids = new Set(choices.map((choice) => choice.id));
        if (ids.size !== choices.length) {
            throw new Error("ask_user choice IDs must be unique");
        }

        return {
            kind: "interaction",
            interaction: {
                type: "ask_user",
                question,
                choices,
            },
        };
    },
};

function parseChoice(value: unknown, index: number): AskUserChoice {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`ask_user choice ${index + 1} must be an object`);
    }
    const choice = value as Record<string, unknown>;
    const known = ["id", "label", "preview"];
    if (
        !Object.hasOwn(choice, "id")
        || !Object.hasOwn(choice, "label")
        || Object.keys(choice).some((key) => !known.includes(key))
    ) {
        throw new Error(
            `ask_user choice ${index + 1} must contain only id, label, and`
                + " preview",
        );
    }
    return {
        id: nonEmptyString(choice.id, `choice ${index + 1} ID`),
        label: nonEmptyString(choice.label, `choice ${index + 1} label`),
        // A preview is kept verbatim: its indentation is part of what it shows.
        ...(choice.preview === undefined ? {} : {
            preview: verbatimString(
                choice.preview,
                `choice ${index + 1} preview`,
            ),
        }),
    };
}

function verbatimString(value: unknown, name: string): string {
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new Error(`ask_user requires a non-empty ${name}`);
    }
    return value;
}

function nonEmptyString(value: unknown, name: string): string {
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new Error(`ask_user requires a non-empty ${name}`);
    }
    return value.trim();
}
