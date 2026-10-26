import { readFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";

import type { VeraExtensionApi } from "../../src/sdk/extensions.ts";

const HOOK_BUDGET_MS = 300;

const TOOL_DESCRIPTION = [
    "Record that Nash just took back or replaced an earlier memory.",
    "Call this on your own when his message retracts, corrects, or supersedes",
    "a memory you were shown. new_text is what he said now.",
    "old_item_id is the id in brackets on the memory he is changing.",
    "Do not call it for a brand new fact.",
].join(" ");

export function activate(vera: VeraExtensionApi): void {
    vera.hooks.registerPreTurn(async (turn) => {
        const context = await ask(turn.workspace, "context_for", {
            session: turn.sessionId ?? "",
            next_message: turn.prompt,
        }, HOOK_BUDGET_MS);
        const text = context && typeof context.context === "string" ? context.context : "";
        if (!text.trim()) return { power: "observe" };
        return { power: "mutate", context: text, display: "memory" };
    });

    vera.hooks.registerTurnFinished(async (turn) => {
        if (turn.outcome !== "completed" || !turn.prompt.trim() || !turn.reply.trim()) return;
        await ask(turn.workspace, "save_turn", {
            user_text: turn.prompt,
            reply_text: turn.reply,
            session: turn.sessionId,
        }, HOOK_BUDGET_MS);
    });

    vera.tools.register({
        name: "memory_revises",
        description: TOOL_DESCRIPTION,
        inputSchema: {
            type: "object",
            properties: {
                new_text: {
                    type: "string",
                    description: "What Nash said that replaces the old memory.",
                },
                old_item_id: {
                    type: "string",
                    description: "Item id of the memory being replaced, from the injected excerpts.",
                },
            },
            required: ["new_text", "old_item_id"],
            additionalProperties: false,
        },
        timeoutMs: HOOK_BUDGET_MS,
        run: async (request) => {
            const newText = request.input.new_text;
            const oldId = request.input.old_item_id;
            if (typeof newText !== "string" || typeof oldId !== "string" || !newText.trim() || !oldId.trim()) {
                return { output: "memory_revises needs new_text and old_item_id.", isError: true };
            }
            const result = await ask(request.workspace, "revise", {
                new_item: newText,
                old_item: oldId,
                actor: "vera",
                session: request.sessionId,
            }, HOOK_BUDGET_MS);
            if (result === undefined) {
                return { output: "Memory is not running. The turn continues without a revision.", isError: true };
            }
            return { output: `Recorded that ${result.new_id} revises ${result.old_id}.` };
        },
    });
}

function ask(
    workspace: string,
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
): Promise<any | undefined> {
    const pointer = join(workspace, ".activmem", "socket-path");
    let sock = join(workspace, ".activmem", "activmem.sock");
    try {
        sock = readFileSync(pointer, "utf8").trim() || sock;
    } catch {
        // No server has published a socket yet.
    }
    return new Promise((resolve) => {
        const client = connect(sock);
        let buffer = "";
        let settled = false;
        const finish = (value: any) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            client.destroy();
            resolve(value);
        };
        const timer = setTimeout(() => finish(undefined), timeoutMs);
        client.on("error", () => finish(undefined));
        client.on("data", (chunk) => {
            buffer += chunk.toString("utf8");
            const end = buffer.indexOf("\n");
            if (end < 0) return;
            try {
                const message = JSON.parse(buffer.slice(0, end));
                finish(message.ok ? message.result : undefined);
            } catch {
                finish(undefined);
            }
        });
        client.on("connect", () => {
            client.write(`${JSON.stringify({ method, params })}\n`);
        });
    });
}
