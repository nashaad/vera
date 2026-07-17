import type { ModelTool } from "../model/types.ts";

export interface AssembleSystemPromptInput {
    readonly tools: readonly ModelTool[];
    readonly workspace: string;
    readonly date: Date;
}

interface SystemPromptSection {
    readonly name: "Identity" | "Tools" | "Workspace" | "Date";
    readonly content: string;
}

const IDENTITY = "You are Vera, a coding agent. Follow the user's instructions and use the available tools when they help.";

export function assembleSystemPrompt(
    input: AssembleSystemPromptInput,
): string {
    const sections: readonly SystemPromptSection[] = [
        {
            name: "Identity",
            content: IDENTITY,
        },
        {
            name: "Tools",
            content: renderTools(input.tools),
        },
        {
            name: "Workspace",
            content: `Working directory: ${input.workspace}`,
        },
        {
            name: "Date",
            content: `Current date: ${formatLocalDate(input.date)}`,
        },
    ];

    return sections
        .map((section) => `## ${section.name}\n${section.content}`)
        .join("\n\n");
}

function renderTools(tools: readonly ModelTool[]): string {
    const lines = tools.map((tool) => `- ${tool.name}: ${tool.description}`);
    return ["Available tools:", ...(lines.length === 0 ? ["(none)"] : lines)]
        .join("\n");
}

function formatLocalDate(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
}
