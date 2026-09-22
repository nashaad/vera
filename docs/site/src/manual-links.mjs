// GitHub alert syntax, so the raw .md reads the same on GitHub and to agents.
const CALLOUT_TYPES = { NOTE: 'info', TIP: 'idea', IMPORTANT: 'info', WARNING: 'warning', CAUTION: 'error' };

function markCallout(node) {
    const paragraph = node.children[0];
    const first = paragraph?.type === 'paragraph' ? paragraph.children[0] : undefined;
    if (first?.type !== 'text') return;
    const match = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/.exec(first.value);
    if (!match) return;
    first.value = first.value.slice(match[0].length);
    // The marker usually sits on its own line, which leaves a leading soft break.
    if (first.value === '' && paragraph.children[1]?.type === 'break') paragraph.children.splice(1, 1);
    if (first.value === '') paragraph.children.shift();
    const properties = { 'data-callout': CALLOUT_TYPES[match[1]] };
    // A bold first line becomes the title: `> **Privacy**` on the line after the marker.
    const [lead, rest] = paragraph.children;
    if (lead?.type === 'strong' && lead.children.length === 1 && lead.children[0].type === 'text'
        && (rest === undefined || (rest.type === 'text' && rest.value.startsWith('\n')))) {
        properties['data-title'] = lead.children[0].value;
        paragraph.children.shift();
        if (rest) rest.value = rest.value.slice(1);
    }
    if (paragraph.children.length === 0) node.children.shift();
    node.data = { hName: 'div', hProperties: properties };
}

export default function manualLinks() {
    return function transform(tree) {
        // The page layout renders the title from frontmatter.
        const titleIndex = tree.children.findIndex((node) => node.type === 'heading' && node.depth === 1);
        if (titleIndex !== -1) tree.children.splice(titleIndex, 1);
        function visit(node) {
            if (node.type === 'blockquote') markCallout(node);
            if (node.type === 'link' || node.type === 'definition') {
                const match = /^(?:\.\/)?([a-z0-9-]+)\.md(#.*)?$/.exec(node.url);
                if (match) {
                    const path = match[1] === 'index' ? '/manual/' : `/${match[1]}/`;
                    node.url = path + (match[2] ?? '');
                }
            }
            for (const child of node.children ?? []) visit(child);
        }
        visit(tree);
    };
}
