// `/subagents` lists only subagents, so it shows bare names and skips this.
export function subagentTitle(title: string, parentId: string | undefined): string {
    return parentId === undefined ? title : `sub: ${title}`;
}
