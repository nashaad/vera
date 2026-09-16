import { ModelEventStream } from "../../src/model/stream.ts";
import { emptyUsage, type AssistantMessage, type ModelRequest } from "../../src/model/types.ts";
import type { VeraExtensionApi, VeraClientExtensionApi } from "../../src/sdk/extensions.ts";
import { ConversationBudget, conversationCost, costLabel, budgetPercent } from "./budget.ts";

export function activate(vera: VeraExtensionApi): void {
    const budgets = new ConversationBudget(vera.storage.profile);
    vera.sessions.registerState((sessionId) => ({ dollars: budgets.read(sessionId).dollars }));
    vera.commands.register({
        name: "budget",
        description: "Set a conversation budget; no amount turns it off",
        usage: "/budget [AMOUNT]",
        run({ sessionId, sessionPath, argumentsText }) {
            if (sessionId === undefined || sessionPath === undefined) throw new Error("Open a conversation first");
            const value = argumentsText.trim();
            if (value !== "" && !/^(?:-1|\d+(?:\.\d+)?|\.\d+)$/.test(value)) {
                throw new Error("Use /budget 0.50 to set it, or /budget to turn it off");
            }
            budgets.set(sessionId, value === "" ? -1 : Number(value));
            const setting = budgets.read(sessionId);
            const cost = conversationCost(sessionPath);
            if (value !== "" && setting.dollars !== -1 && (cost.priced > 0 || cost.unpriced === 0)) {
                return { kind: "text", text: `Budget changed to $${setting.dollars.toFixed(2)}. ${cost.unpriced > 0 ? "Known spend" : "Spent"}: $${cost.dollars.toFixed(2)}. Remaining: $${Math.max(0, setting.dollars - cost.dollars).toFixed(2)}.` };
            }
            return { kind: "text", text: `${costLabel(cost)}\n${setting.dollars === -1
                ? "Budget reminders off"
                : `Budget: $${setting.dollars.toFixed(2)}; reminders at 50% and 80%; approval at the limit`}` };
        },
    });
    vera.hooks.registerModelMiddleware((adapter, context) => ({
        ...(adapter.supportsImageInput === undefined ? {} : { supportsImageInput: adapter.supportsImageInput }),
        ...(adapter.imageInputSupport === undefined ? {} : { imageInputSupport: adapter.imageInputSupport.bind(adapter) }),
        ...(adapter.supportsImageInputFor === undefined ? {} : { supportsImageInputFor: adapter.supportsImageInputFor.bind(adapter) }),
        stream(request) {
            const output = new ModelEventStream();
            let terminal = false;
            const produce = async (): Promise<void> => {
                request.signal?.throwIfAborted();
                const cost = conversationCost(context.sessionPath);
                const approval = budgets.approval(context.sessionId, cost);
                let update: string | undefined;
                if (approval !== undefined) {
                    let error = "";
                    while (true) {
                        const answer = await context.ask?.({
                            question: `${approval}\n\nContinue spending? Enter a new total above $${cost.dollars.toFixed(2)}.${error}`,
                            customLabel: "Increase budget and continue",
                            allowNotes: false,
                            choices: [
                                { id: "stop", label: "Stop" },
                                { id: "ignore", label: "Ignore budget and continue" },
                            ],
                        }, request.signal);
                        request.signal?.throwIfAborted();
                        if (answer?.outcome === "selected" && answer.choice.id === "ignore") {
                            budgets.ignore(context.sessionId);
                            update = `${approval} The user chose to ignore this budget and continue.`;
                            break;
                        }
                        if (answer?.outcome === "custom") {
                            const value = answer.text.trim();
                            const dollars = /^(?:\d+(?:\.\d+)?|\.\d+)$/.test(value) ? Number(value) : NaN;
                            if (!Number.isFinite(dollars) || dollars <= cost.dollars) {
                                error = "\nEnter a number greater than the amount already spent.";
                                continue;
                            }
                            budgets.set(context.sessionId, dollars);
                            update = `Budget increased to $${dollars.toFixed(2)}. Spent: $${cost.dollars.toFixed(2)}. The user chose to continue.`;
                            break;
                        }
                        context.notice?.("Stopped at budget.");
                        output.push({ type: "done", message: stoppedMessage("Stopped at budget.") });
                        return;
                    }
                } else {
                    update = budgets.reminder(context.sessionId, cost, true);
                    if (update !== undefined) context.notice?.(update);
                }
                const next: ModelRequest = update === undefined ? request : {
                    ...request, messages: [...request.messages, {
                        role: "user", content: [{ type: "text", text: update }],
                    }],
                };
                request.signal?.throwIfAborted();
                for await (const event of adapter.stream(next)) {
                    terminal ||= event.type === "done" || event.type === "error";
                    output.push(event);
                }
                if (!terminal) throw new Error("Response ended without a result");
            };
            void produce().catch((cause: unknown) => {
                if (terminal) return;
                if (request.signal?.aborted) {
                    output.push({ type: "done", message: stoppedMessage() });
                    return;
                }
                const error = cause instanceof Error ? cause : new Error(String(cause));
                output.push({ type: "error", error, message: {
                    ...stoppedMessage(), stopReason: "error", errorMessage: error.message,
                } });
            });
            return output;
        },
    }));
}

function stoppedMessage(reason?: string): AssistantMessage {
    return { role: "assistant", content: [],
        source: { provider: "local", api: "none", model: "none" },
        usage: emptyUsage(), stopReason: "aborted",
        ...(reason === undefined ? {} : { errorMessage: reason }) };
}

export function activateClient(vera: VeraClientExtensionApi): void {
    vera.ui.sidebar.registerSummary(({ usage, extensionState }) => {
        if (usage === undefined) return [];
        const dollars = usage.rows.reduce((sum, row) => sum + (row.cost ?? 0), 0);
        const unpriced = usage.rows.reduce((sum, row) => sum + row.callsWithoutCost, 0);
        const priced = usage.rows.reduce((sum, row) => sum + row.calls - row.callsWithoutCost, 0);
        const budget = extensionState?.["vera.budget"]?.dollars;
        const available = !(unpriced > 0 && priced === 0);
        const amount = available ? `$${dollars.toFixed(2)}` : "unavailable";
        const value = typeof budget === "number" && budget >= 0
            ? `${amount} / $${budget.toFixed(2)}${available ? ` · ${budgetPercent(dollars, budget)}` : ""}`
            : amount;
        return [{ label: unpriced > 0 && priced > 0 ? "Known cost" : "Cost",
            value }];
    });
}
