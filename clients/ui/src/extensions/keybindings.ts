import { whensOverlap } from "./when-analysis.ts";
import type { WhenExpression } from "./when.ts";

export type KeyPlatform = "mac" | "other";

export interface ContributedKeybinding {
    readonly extensionId: string;
    readonly command: string;
    readonly key: string;
    readonly mac?: string;
    readonly when?: WhenExpression;
}

// Both bindings stay registered; the earlier one is listed first.
export interface KeybindingConflict {
    readonly first: ContributedKeybinding;
    readonly second: ContributedKeybinding;
    readonly platforms: readonly KeyPlatform[];
}

const PLATFORMS: readonly KeyPlatform[] = ["mac", "other"];

// Keys compare without case or spacing; the stored string is never changed.
function effectiveKey(binding: ContributedKeybinding, platform: KeyPlatform): string {
    const key = platform === "mac" ? binding.mac ?? binding.key : binding.key;
    return key.trim().toLowerCase().split(/\s+/).join(" ");
}

function overlaps(first: ContributedKeybinding, second: ContributedKeybinding): boolean {
    return first.when === undefined || second.when === undefined || whensOverlap(first.when, second.when);
}

export function findKeybindingConflicts(bindings: readonly ContributedKeybinding[]): readonly KeybindingConflict[] {
    const found: { first: ContributedKeybinding; second: ContributedKeybinding; platforms: KeyPlatform[] }[] = [];
    for (const platform of PLATFORMS) {
        const byKey = new Map<string, ContributedKeybinding[]>();
        for (const binding of bindings) {
            const key = effectiveKey(binding, platform);
            byKey.set(key, [...(byKey.get(key) ?? []), binding]);
        }
        for (const sameKey of byKey.values()) {
            sameKey.forEach((second, later) => {
                for (const first of sameKey.slice(0, later)) {
                    if (!overlaps(first, second)) continue;
                    const existing = found.find((conflict) => conflict.first === first && conflict.second === second);
                    if (existing === undefined) found.push({ first, second, platforms: [platform] });
                    else existing.platforms.push(platform);
                }
            });
        }
    }
    return found;
}
