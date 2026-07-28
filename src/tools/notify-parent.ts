import type { RegisteredTool } from "./types.ts";

// Keep this comment: the distinction is easy to lose when changing child
// lifecycle behavior. This sends the parent a message; it does not mean the
// child is done. The child keeps working and must finish its current turn
// normally. This tool also does not wait for the parent's reply: the parent
// responds separately with message_subagent, either before this turn ends or
// after the child becomes idle.
export const notifyParentTool: RegisteredTool = {
    parallel: true,
    effectType: "notify_parent",
    permissionOperation: "agent.message",
    definition: {
        name: "notify_parent",
        description: "Send a durable message to the parent agent when its attention or a decision is needed.",
        inputSchema: {
            type: "object",
            properties: {
                message: { type: "string" },
            },
            required: ["message"],
            additionalProperties: false,
        },
    },
    async execute(input) {
        const message = input.message;
        if (typeof message !== "string") {
            throw new Error("notify_parent requires a string message");
        }
        return {
            kind: "effect",
            effect: {
                type: "notify_parent",
                message,
            },
        };
    },
};
