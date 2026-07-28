import {
    canonicalWatchId,
    type ExtensionContributions,
    type WatchContribution,
} from "./contributions.ts";

export interface OwnedWatchContribution {
    readonly id: string;
    readonly localId: string;
    readonly extensionId: string;
    readonly definition: WatchContribution;
}

export interface HostContributionSet {
    watches(): readonly OwnedWatchContribution[];
    watch(id: string): OwnedWatchContribution | undefined;
    frozen(): boolean;
}

export interface MutableHostContributionSet extends HostContributionSet {
    admit(extensionId: string, contributions: ExtensionContributions): void;
    withdraw(extensionId: string): readonly OwnedWatchContribution[];
    freeze(): void;
}

export class ContributionCollisionError extends Error {
    readonly extensionId: string;
    readonly ownerId: string;

    constructor(id: string, extensionId: string, ownerId: string) {
        super(
            `Watch contribution ${id} from ${extensionId} collides with ${ownerId}`,
        );
        this.name = "ContributionCollisionError";
        this.extensionId = extensionId;
        this.ownerId = ownerId;
    }
}

export function createHostContributionSet(): MutableHostContributionSet {
    const watches = new Map<string, OwnedWatchContribution>();
    let isFrozen = false;

    return {
        admit(
            extensionId: string,
            contributions: ExtensionContributions,
        ): void {
            if (isFrozen) {
                throw new Error(
                    `Contribution set is frozen; ${extensionId} cannot contribute`,
                );
            }
            const admitted: string[] = [];
            try {
                for (const definition of contributions.watches) {
                    const id = canonicalWatchId(extensionId, definition.id);
                    const existing = watches.get(id);
                    if (existing !== undefined) {
                        throw new ContributionCollisionError(
                            id,
                            extensionId,
                            existing.extensionId,
                        );
                    }
                    watches.set(id, {
                        id,
                        localId: definition.id,
                        extensionId,
                        definition,
                    });
                    admitted.push(id);
                }
            } catch (error) {
                for (const id of admitted.toReversed()) {
                    watches.delete(id);
                }
                throw error;
            }
        },
        withdraw(extensionId: string): readonly OwnedWatchContribution[] {
            const owned = [...watches.values()].filter(
                (entry) => entry.extensionId === extensionId,
            ).toReversed();
            for (const entry of owned) {
                watches.delete(entry.id);
            }
            return owned;
        },
        freeze(): void {
            isFrozen = true;
        },
        frozen(): boolean {
            return isFrozen;
        },
        watches(): readonly OwnedWatchContribution[] {
            return [...watches.values()];
        },
        watch(id: string): OwnedWatchContribution | undefined {
            return watches.get(id);
        },
    };
}
