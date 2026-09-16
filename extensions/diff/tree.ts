import type { ChangedFile } from "./model.ts";

export interface FileNode {
    path: string;
    name: string;
    children: FileNode[];
    fileIndex?: number;
}
export interface FileRow {
    node: FileNode;
    depth: number;
}
export function fileTree(files: readonly ChangedFile[]): FileNode[] {
    const roots: FileNode[] = [];
    files.forEach((file, fileIndex) => {
        let children = roots;
        let path = "";
        const parts = file.path.split("/");
        parts.forEach((name, index) => {
            path = path ? `${path}/${name}` : name;
            let node = children.find((item) => item.path === path);
            if (!node) { node = { path, name, children: [] }; children.push(node); }
            if (index === parts.length - 1) node.fileIndex = fileIndex;
            children = node.children;
        });
    });
    const sort = (nodes: FileNode[]): void => {
        nodes.sort((a, b) => Number(a.fileIndex !== undefined) - Number(b.fileIndex !== undefined) || a.name.localeCompare(b.name));
        nodes.forEach((node) => sort(node.children));
    };
    sort(roots);
    return roots;
}
export function fileRows(nodes: readonly FileNode[], expanded: ReadonlySet<string>, depth = 0): FileRow[] {
    return nodes.flatMap((node) => [{ node, depth }, ...(expanded.has(node.path) ? fileRows(node.children, expanded, depth + 1) : [])]);
}
