import type { AgentDefinition } from "../agents/definition.ts";
import type { ModelTool } from "../model/types.ts";

export function withSubagentCatalog(
    tools: readonly ModelTool[],
    agents: readonly AgentDefinition[],
): readonly ModelTool[] {
    const available = agents.filter((entry) => entry.nudges === undefined)
        .sort((left, right) => left.name.localeCompare(right.name));
    if (available.length === 0) return tools;
    const catalog = available.map((entry) => entry.description === undefined
        ? entry.name
        : `${entry.name}: ${entry.description}`).join("\n");
    return tools.map((tool) => tool.name !== "subagent" ? tool : {
        ...tool,
        inputSchema: {
            ...tool.inputSchema,
            properties: {
                ...(tool.inputSchema.properties as Readonly<Record<string, unknown>>),
                agent: {
                    type: "string",
                    description: `Optional agent definition. Available agents: ${catalog}. The selected definition supplies instructions and narrows tools and skills.`,
                },
            },
        },
    });
}
