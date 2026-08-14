import {
    canonicalSidecarId,
    canonicalWatchId,
    type ExtensionContributions,
    type SidecarContribution,
    type WatchContribution,
} from "./contributions.ts";

export interface OwnedWatchContribution {
    readonly id: string;
    readonly localId: string;
    readonly extensionId: string;
    readonly definition: WatchContribution;
}

export interface OwnedSidecarContribution {
    readonly id: string;
    readonly localId: string;
    readonly extensionId: string;
    /** Realpath of the extension directory; relative cwd resolves here. */
    readonly extensionDirectory: string;
    readonly definition: SidecarContribution;
}

export interface HostContributionSet {
    watches(): readonly OwnedWatchContribution[];
    watch(id: string): OwnedWatchContribution | undefined;
    sidecars(): readonly OwnedSidecarContribution[];
    sidecar(id: string): OwnedSidecarContribution | undefined;
    frozen(): boolean;
}

export interface MutableHostContributionSet extends HostContributionSet {
    admit(
        extensionId: string,
        contributions: ExtensionContributions,
        extensionDirectory: string,
    ): void;
    withdraw(extensionId: string): readonly OwnedWatchContribution[];
    freeze(): void;
}

export class ContributionCollisionError extends Error {
    readonly extensionId: string;
    readonly ownerId: string;

    constructor(id: string, extensionId: string, ownerId: string) {
        super(
            `Contribution ${id} from ${extensionId} collides with ${ownerId}`,
        );
        this.name = "ContributionCollisionError";
        this.extensionId = extensionId;
        this.ownerId = ownerId;
    }
}

export function createHostContributionSet(): MutableHostContributionSet {
    const watches = new Map<string, OwnedWatchContribution>();
    const sidecars = new Map<string, OwnedSidecarContribution>();
    let isFrozen = false;

    return {
        admit(
            extensionId: string,
            contributions: ExtensionContributions,
            extensionDirectory: string,
        ): void {
            if (isFrozen) {
                throw new Error(
                    `Contribution set is frozen; ${extensionId} cannot contribute`,
                );
            }
            const admittedWatches: string[] = [];
            const admittedSidecars: string[] = [];
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
                    admittedWatches.push(id);
                }
                for (const definition of contributions.sidecars) {
                    const id = canonicalSidecarId(extensionId, definition.id);
                    const existing = sidecars.get(id);
                    if (existing !== undefined) {
                        throw new ContributionCollisionError(
                            id,
                            extensionId,
                            existing.extensionId,
                        );
                    }
                    sidecars.set(id, {
                        id,
                        localId: definition.id,
                        extensionId,
                        extensionDirectory,
                        definition,
                    });
                    admittedSidecars.push(id);
                }
            } catch (error) {
                for (const id of admittedSidecars.toReversed()) {
                    sidecars.delete(id);
                }
                for (const id of admittedWatches.toReversed()) {
                    watches.delete(id);
                }
                throw error;
            }
        },
        withdraw(extensionId: string): readonly OwnedWatchContribution[] {
            const ownedSidecars = [...sidecars.values()].filter(
                (entry) => entry.extensionId === extensionId,
            ).toReversed();
            for (const entry of ownedSidecars) {
                sidecars.delete(entry.id);
            }
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
        sidecars(): readonly OwnedSidecarContribution[] {
            return [...sidecars.values()];
        },
        sidecar(id: string): OwnedSidecarContribution | undefined {
            return sidecars.get(id);
        },
    };
}
