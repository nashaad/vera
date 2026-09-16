import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

export interface ConversationCost {
    readonly dollars: number;
    readonly priced: number;
    readonly unpriced: number;
}

interface BudgetSetting {
    readonly dollars: number;
    readonly notified: number;
    readonly ignored?: boolean;
}

export function conversationCost(path: string): ConversationCost {
    let dollars = 0;
    let priced = 0;
    let unpriced = 0;
    if (!existsSync(path)) return { dollars, priced, unpriced };
    for (const line of readFileSync(path, "utf8").split("\n")) {
        if (!line.trim()) continue;
        const entry = JSON.parse(line);
        if (entry.type !== "compaction" && (entry.type !== "message" || entry.message?.role !== "assistant"
            || entry.message.source?.api === "none")) continue;
        if (entry.type === "compaction" && entry.billed === undefined) continue;
        const cost = entry.type === "compaction" ? entry.billed?.usage?.cost : entry.message.usage?.cost;
        if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0) {
            dollars += cost;
            priced++;
        } else unpriced++;
    }
    return { dollars: Math.round(dollars * 1e9) / 1e9, priced, unpriced };
}

export function costLabel(cost: ConversationCost): string {
    if (cost.priced === 0 && cost.unpriced > 0) return "Cost unavailable";
    return `${cost.unpriced > 0 ? "Known cost" : "Cost"}: $${cost.dollars.toFixed(2)}`;
}

export function budgetPercent(spent: number, budget: number): string {
    return budget === 0 ? (spent > 0 ? "over" : "100%") : `${Math.floor(spent / budget * 100 + 1e-8)}%`;
}

export class ConversationBudget {
    constructor(private readonly directory: string) {}

    read(session: string): BudgetSetting {
        const path = this.path(session);
        return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { dollars: -1, notified: 0 };
    }

    set(session: string, dollars: number): void {
        if (!Number.isFinite(dollars) || (dollars < 0 && dollars !== -1)) {
            throw new Error("Use /budget 0.50 to set it, or /budget to turn it off");
        }
        const prior = this.read(session);
        this.save(session, { dollars, notified: dollars === prior.dollars ? prior.notified : 0 });
    }

    ignore(session: string): void {
        this.save(session, { ...this.read(session), ignored: true });
    }

    approval(session: string, cost: ConversationCost): string | undefined {
        const setting = this.read(session);
        if (setting.ignored === true || setting.dollars < 0 || cost.dollars < setting.dollars) return undefined;
        const heading = cost.dollars > setting.dollars ? "Budget exceeded" : "Budget reached";
        const qualifier = cost.unpriced > 0 ? "\nKnown spend only; some replies have no reported cost." : "";
        return `${heading}: $${cost.dollars.toFixed(2)} / $${setting.dollars.toFixed(2)}.${qualifier}`;
    }

    reminder(session: string, cost: ConversationCost, acknowledge = false): string | undefined {
        const setting = this.read(session);
        if (setting.ignored === true || setting.dollars === -1 || cost.priced === 0 || cost.dollars >= setting.dollars) return undefined;
        const fraction = setting.dollars === 0 ? 1 : cost.dollars / setting.dollars;
        const crossed = [50, 80].filter((point) => fraction * 100 + 1e-8 >= point && point > setting.notified);
        if (crossed.length === 0) return undefined;
        if (acknowledge) this.save(session, { ...setting, notified: crossed.at(-1)! });
        const qualifier = cost.unpriced > 0 ? "Known spend only; some replies have no reported cost. " : "";
        const spent = `$${cost.dollars.toFixed(2)}`;
        const total = `$${setting.dollars.toFixed(2)}`;
        const heading = crossed.includes(80) ? "80% of budget used" : "Halfway through budget";
        return `${heading}: ${spent} spent of ${total}. $${(setting.dollars - cost.dollars).toFixed(2)} remaining.${qualifier ? ` ${qualifier.trim()}` : ""}`;
    }

    private path(session: string): string {
        return join(this.directory, `${createHash("sha256").update(session).digest("hex")}.json`);
    }

    private save(session: string, setting: BudgetSetting): void {
        const path = this.path(session);
        writeFileSync(`${path}.tmp`, JSON.stringify(setting), { mode: 0o600 });
        renameSync(`${path}.tmp`, path);
    }
}
