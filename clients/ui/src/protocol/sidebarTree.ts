import { sessionRootIds } from "../../../../src/session-roots.ts";

import { ARCHIVED_TITLE, CHATS_TITLE, PINNED_TITLE, folderName } from "./sessionGroups.ts";
import type { SessionRow } from "./sessions.ts";

export type SidebarGrouping = "none" | "folder";

// One session and the rows listed under it, nested to any depth.
export interface SidebarNode {
    readonly row: SessionRow;
    readonly children: readonly SidebarNode[];
    // The top of the family, which owns the archive choice for every row in it.
    readonly archiveRoot: SessionRow;
}

export type SidebarSectionKind = "pinned" | "flat" | "folder" | "chats" | "archived";

export interface SidebarSection {
    readonly key: string;
    readonly kind: SidebarSectionKind;
    // Empty on the ungrouped list, which has no heading.
    readonly title: string;
    // Empty for special sections and for sessions with no folder.
    readonly workspace: string;
    readonly chats: boolean;
    // The only session in a folder shares its row with the folder heading.
    readonly folderRow: boolean;
    readonly nodes: readonly SidebarNode[];
}

export interface SidebarTree {
    readonly sections: readonly SidebarSection[];
}

export interface SidebarRowEntry {
    readonly row: SessionRow;
    readonly nested: boolean;
}

const CHATS_KEY = "chats";
const FOLDER_KEY = "folder:";
export const ARCHIVED_KEY = "archived";

// Pinned roots first, in pin order, then the rest in the host's order, flat or under folder
// headings. Each row is listed once; only a root can be pinned, and nested rows follow their parent.
export function buildSidebarTree(
    rows: readonly SessionRow[],
    pins: readonly string[] = [],
    grouping: SidebarGrouping = "none",
): SidebarTree {
    const byId = new Map(rows.map((row) => [row.id, row]));
    const rootIds = sessionRootIds(rows, (row) => row.parentId);
    const roots: SessionRow[] = [];
    const children = new Map<string, SessionRow[]>();
    for (const row of rows) {
        const rootId = rootIds.get(row.id) ?? row.id;
        if (rootId === row.id) {
            roots.push(row);
            continue;
        }
        const parentId = row.parentId;
        if (parentId === undefined || byId.get(parentId) === undefined) continue;
        const siblings = children.get(parentId);
        if (siblings === undefined) children.set(parentId, [row]);
        else siblings.push(row);
    }
    const build = (row: SessionRow, archiveRoot: SessionRow, seen: ReadonlySet<string>): SidebarNode => {
        const nextSeen = new Set(seen).add(row.id);
        return {
            row,
            archiveRoot,
            children: (children.get(row.id) ?? [])
                .filter((child) => !nextSeen.has(child.id))
                .map((child) => build(child, archiveRoot, nextSeen)),
        };
    };
    const builtRoots = roots.map((row) => build(row, row, new Set()));
    const rootById = new Map(builtRoots.map((node) => [node.row.id, node]));
    const archived = (node: SidebarNode): boolean => node.row.archived === true || node.children.some(archived);
    const activeRoots = builtRoots.filter((node) => !archived(node));
    const archivedRoots = builtRoots.filter(archived);

    const pinnedIds = new Set<string>();
    const pinned: SidebarNode[] = [];
    for (const id of pins) {
        if (pinnedIds.has(id) || !activeRoots.some((node) => node.row.id === id)) continue;
        const node = rootById.get(id);
        if (node === undefined) continue;
        pinnedIds.add(id);
        pinned.push(node);
    }
    const ordinary = activeRoots.filter((node) => !pinnedIds.has(node.row.id));

    const sections: SidebarSection[] = [];
    if (pinned.length > 0) {
        sections.push({
            key: "pinned",
            kind: "pinned",
            title: PINNED_TITLE,
            workspace: "",
            chats: false,
            folderRow: false,
            nodes: pinned,
        });
    }
    if (grouping === "none") {
        if (ordinary.length > 0) {
            sections.push({ key: "flat", kind: "flat", title: "", workspace: "", chats: false, folderRow: false, nodes: ordinary });
        }
    } else {
        const totals = new Map<string, number>();
        for (const node of activeRoots) {
            if (node.row.chat) continue;
            totals.set(node.row.workspace, (totals.get(node.row.workspace) ?? 0) + 1);
        }
        const groups = new Map<string, {
            readonly workspace: string;
            readonly chats: boolean;
            readonly nodes: SidebarNode[];
        }>();
        for (const node of ordinary) {
            const key = node.row.chat ? CHATS_KEY : `${FOLDER_KEY}${node.row.workspace}`;
            let group = groups.get(key);
            if (group === undefined) {
                group = { workspace: node.row.chat ? "" : node.row.workspace, chats: node.row.chat, nodes: [] };
                groups.set(key, group);
            }
            group.nodes.push(node);
        }
        for (const [key, group] of groups) {
            const title = group.chats ? CHATS_TITLE : folderName(group.workspace);
            sections.push({
                key,
                kind: group.chats ? "chats" : "folder",
                title,
                workspace: group.workspace,
                chats: group.chats,
                folderRow: !group.chats
                    && group.nodes.length === 1
                    && totals.get(group.workspace) === 1
                    && group.nodes[0]?.row.name === title,
                nodes: group.nodes,
            });
        }
    }
    if (archivedRoots.length > 0) {
        sections.push({
            key: ARCHIVED_KEY,
            kind: "archived",
            title: ARCHIVED_TITLE,
            workspace: "",
            chats: false,
            folderRow: false,
            nodes: archivedRoots,
        });
    }
    return { sections };
}

// Every listed row in tree order, for a page that shows all of them without grouping.
export function sidebarRowEntries(tree: SidebarTree): readonly SidebarRowEntry[] {
    const entries: SidebarRowEntry[] = [];
    const walk = (node: SidebarNode, nested: boolean): void => {
        entries.push({ row: node.row, nested });
        for (const child of node.children) walk(child, true);
    };
    for (const section of tree.sections) {
        for (const node of section.nodes) walk(node, false);
    }
    return entries;
}
