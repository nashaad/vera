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
                            description: {
                                type: "string",
                                description:
                                    "Optional. One line saying what picking"
                                    + " this means, shown under the label."
                                    + " Include it when the label alone leaves"
                                    + " the consequence unclear; omit it when it"
                                    + " would only restate the label.",
                            },
                            preview: {
                                type: "string",
                                description:
                                    "Optional, and most questions want none."
                                    + " Only for something the reader has to see"
                                    + " laid out to judge it: a layout mockup, a"
                                    + " diff, a code snippet, a small ASCII"
                                    + " diagram. Never prose. A sentence, an"
                                    + " example phrasing, or anything that reads"
                                    + " as writing belongs in description, or"
                                    + " nowhere. If the choices do not differ in"
                                    + " a way a monospace box would show, leave"
                                    + " it off every choice.",
                            },
                            recommended: {
                                type: "boolean",
                                description:
                                    "Optional. True on at most one choice, the"
                                    + " one the asker would pick. Leave it off"
                                    + " every other choice, and off every choice"
                                    + " when there is no preference.",
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

        const parsed = input.choices.map(parseChoice);
        const ids = new Set(parsed.map((choice) => choice.id));
        if (ids.size !== parsed.length) {
            throw new Error("ask_user choice IDs must be unique");
        }
        if (parsed.filter((choice) => choice.recommended === true).length > 1) {
            throw new Error("ask_user allows at most one recommended choice");
        }

        return {
            kind: "interaction",
            interaction: {
                type: "ask_user",
                question,
                choices: withRecommendedFirst(parsed),
            },
        };
    },
};

function parseChoice(value: unknown, index: number): AskUserChoice {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`ask_user choice ${index + 1} must be an object`);
    }
    const choice = value as Record<string, unknown>;
    const known = ["id", "label", "description", "preview", "recommended"];
    if (
        !Object.hasOwn(choice, "id")
        || !Object.hasOwn(choice, "label")
        || Object.keys(choice).some((key) => !known.includes(key))
    ) {
        throw new Error(
            `ask_user choice ${index + 1} must contain only id, label,`
                + " description, preview, and recommended",
        );
    }
    return {
        id: nonEmptyString(choice.id, `choice ${index + 1} ID`),
        label: nonEmptyString(choice.label, `choice ${index + 1} label`),
        // An empty string counts as omitted: the schema calls these fields
        // optional, and models routinely fill optional strings with "".
        ...(isOmitted(choice.description) ? {} : {
            description: nonEmptyString(
                choice.description,
                `choice ${index + 1} description`,
            ),
        }),
        // A preview is kept verbatim: its indentation is part of what it shows.
        ...(isOmitted(choice.preview) ? {} : {
            preview: verbatimString(
                choice.preview,
                `choice ${index + 1} preview`,
            ),
        }),
        ...(parseRecommended(choice.recommended, index) ? { recommended: true } : {}),
    };
}

function parseRecommended(value: unknown, index: number): boolean {
    if (value === undefined || value === false) {
        return false;
    }
    if (value !== true) {
        throw new Error(
            `ask_user choice ${index + 1} recommended must be a boolean`,
        );
    }
    return true;
}

function withRecommendedFirst(
    choices: readonly AskUserChoice[],
): readonly AskUserChoice[] {
    const index = choices.findIndex((choice) => choice.recommended === true);
    if (index <= 0) {
        return choices;
    }
    const recommended = choices[index];
    if (recommended === undefined) {
        return choices;
    }
    return [recommended, ...choices.filter((_, i) => i !== index)];
}

function isOmitted(value: unknown): boolean {
    return value === undefined
        || (typeof value === "string" && value.trim().length === 0);
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
