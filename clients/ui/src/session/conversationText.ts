import type { Block } from "./model.ts";

// The prompts and replies of the loaded conversation as Markdown; tool work is left out.
export function conversationText(title: string, blocks: readonly Block[]): string {
    const parts: string[] = [`# ${title}`];
    for (const block of blocks) {
        if (block.kind === "user") parts.push(`## You\n\n${block.text}`);
        else if (block.kind === "text") parts.push(`## Vera\n\n${block.text}`);
    }
    return `${parts.join("\n\n")}\n`;
}
