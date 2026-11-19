interface SessionIdentity {
    readonly id: string;
}

export function sessionRootIds<T extends SessionIdentity>(
    rows: readonly T[],
    parentId: (row: T) => string | undefined,
    isRoot: (row: T) => boolean = () => false,
): ReadonlyMap<string, string> {
    const byId = new Map(rows.map((row) => [row.id, row]));
    const roots = new Map<string, string>();
    const cyclic = new Set<string>();
    for (const row of rows) {
        let current = row;
        const path: string[] = [];
        const seen = new Set<string>();
        let root: string | undefined;
        while (true) {
            const known = roots.get(current.id);
            if (known !== undefined) {
                root = cyclic.has(current.id) ? undefined : known;
                break;
            }
            if (seen.has(current.id)) {
                root = undefined;
                break;
            }
            seen.add(current.id);
            path.push(current.id);
            const parent = isRoot(current) ? undefined : parentId(current);
            const next = parent === undefined ? undefined : byId.get(parent);
            if (next === undefined) {
                root = current.id;
                break;
            }
            current = next;
        }
        for (const id of path) {
            roots.set(id, root ?? id);
            if (root === undefined) cyclic.add(id);
        }
    }
    return roots;
}
