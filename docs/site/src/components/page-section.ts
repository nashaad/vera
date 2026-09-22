import type { Node, Root } from 'fumadocs-core/page-tree';

function trimSlash(url: string): string {
    return url.endsWith('/') && url.length > 1 ? url.slice(0, -1) : url;
}

// The sidebar separator above the current page, or undefined for pages outside a section.
export function pageSection(tree: Root, pathname: string): string | undefined {
    const target = trimSlash(pathname);
    let section: string | undefined;
    const walk = (nodes: Node[]): boolean => {
        for (const node of nodes) {
            if (node.type === 'separator' && typeof node.name === 'string') section = node.name;
            if (node.type === 'page' && trimSlash(node.url) === target) return true;
            if (node.type === 'folder' && walk(node.children)) return true;
        }
        return false;
    };
    return walk(tree.children) ? section : undefined;
}
