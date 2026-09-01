export interface InteractiveAttachmentLease {
    release(): number;
}

export interface StopIfLastDecision {
    readonly remainingClients: number;
    readonly rootsToStop: readonly string[];
}

export class InteractiveAttachmentRegistry {
    private readonly agents = new Map<string, Map<string, number>>();
    private readonly pendingStopRoots = new Set<string>();

    open(agentId: string, clientId: string): InteractiveAttachmentLease {
        const clients = this.agents.get(agentId) ?? new Map<string, number>();
        this.agents.set(agentId, clients);
        clients.set(clientId, (clients.get(clientId) ?? 0) + 1);
        let active = true;
        return {
            release: (): number => {
                if (!active) return this.clientCount([agentId]);
                active = false;
                const next = Math.max(0, (clients.get(clientId) ?? 0) - 1);
                if (next === 0) {
                    clients.delete(clientId);
                } else {
                    clients.set(clientId, next);
                }
                if (clients.size === 0) this.agents.delete(agentId);
                return this.clientCount([agentId]);
            },
        };
    }

    clientCount(
        agentIds: readonly string[],
        excludingClientId?: string,
    ): number {
        const clients = new Set<string>();
        for (const agentId of agentIds) {
            for (const clientId of this.agents.get(agentId)?.keys() ?? []) {
                if (clientId !== excludingClientId) clients.add(clientId);
            }
        }
        return clients.size;
    }

    stopIfLast(
        rootAgentId: string,
        departingClientId: string | undefined,
        readAgentTree: (rootAgentId: string) => readonly string[],
    ): StopIfLastDecision {
        const tree = readAgentTree(rootAgentId);
        const remainingClients = this.clientCount(tree, departingClientId);
        this.deferStop(rootAgentId);
        if (remainingClients > 0) {
            return { remainingClients, rootsToStop: [] };
        }
        return {
            remainingClients,
            rootsToStop: this.collectReadyRoots(
                rootAgentId,
                departingClientId,
                readAgentTree,
            ),
        };
    }

    deferStop(rootAgentId: string): void {
        this.pendingStopRoots.add(rootAgentId);
    }

    readyDeferredStops(
        releasedAgentId: string,
        readAgentTree: (rootAgentId: string) => readonly string[],
    ): readonly string[] {
        return this.collectReadyRoots(
            releasedAgentId,
            undefined,
            readAgentTree,
        );
    }

    keepRunning(
        agentId: string,
        readAgentTree: (rootAgentId: string) => readonly string[],
    ): void {
        for (const pendingRoot of [...this.pendingStopRoots]) {
            if (readAgentTree(pendingRoot).includes(agentId)) {
                this.pendingStopRoots.delete(pendingRoot);
            }
        }
    }

    forceStop(
        rootAgentId: string,
        readAgentTree: (rootAgentId: string) => readonly string[],
    ): readonly string[] {
        const tree = new Set(readAgentTree(rootAgentId));
        for (const pendingRoot of [...this.pendingStopRoots]) {
            if (tree.has(pendingRoot)) this.pendingStopRoots.delete(pendingRoot);
        }
        return [rootAgentId];
    }

    private collectReadyRoots(
        releasedAgentId: string,
        departingClientId: string | undefined,
        readAgentTree: (rootAgentId: string) => readonly string[],
    ): readonly string[] {
        const ready = [...this.pendingStopRoots].filter((pendingRoot) => {
            const tree = readAgentTree(pendingRoot);
            return tree.includes(releasedAgentId)
                && this.clientCount(tree, departingClientId) === 0;
        }).sort((left, right) =>
            readAgentTree(right).length - readAgentTree(left).length
        );
        const selected: string[] = [];
        for (const candidate of ready) {
            if (selected.some((root) =>
                readAgentTree(root).includes(candidate)
            )) {
                continue;
            }
            selected.push(candidate);
        }
        for (const root of selected) {
            const tree = new Set(readAgentTree(root));
            for (const pendingRoot of [...this.pendingStopRoots]) {
                if (tree.has(pendingRoot)) this.pendingStopRoots.delete(pendingRoot);
            }
        }
        return selected;
    }
}
