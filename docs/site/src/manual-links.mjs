export default function manualLinks() {
    return function transform(tree) {
        // The page layout renders the title from frontmatter.
        const titleIndex = tree.children.findIndex((node) => node.type === 'heading' && node.depth === 1);
        if (titleIndex !== -1) tree.children.splice(titleIndex, 1);
        function visit(node) {
            if (node.type === 'link' || node.type === 'definition') {
                const match = /^(?:\.\/)?([a-z0-9-]+)\.md(#.*)?$/.exec(node.url);
                if (match) {
                    const path = match[1] === 'index' ? '/' : `/${match[1]}/`;
                    node.url = path + (match[2] ?? '');
                }
            }
            for (const child of node.children ?? []) visit(child);
        }
        visit(tree);
    };
}
