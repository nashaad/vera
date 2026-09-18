import { Fragment, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { directoryTrees, type DirectoryNode, type DirectoryTree, type Placement, type TreeName, type Writer } from '../data/vera-directory';
import '../styles/directory-explorer.css';

interface Entry {
    node: DirectoryNode;
    key: string;
    fullPath: string;
    depth: number;
    parent?: string;
}

const writerLabels: Record<Writer, string> = {
    you: 'You write it',
    vera: 'Vera writes it',
    both: 'You and Vera',
};

const placementLabels: Record<Placement, string> = {
    home: 'In your home',
    committed: 'Committed',
    local: 'Not committed',
};

function entriesOf(tree: DirectoryTree): Entry[] {
    const entries: Entry[] = [];
    function walk(nodes: DirectoryNode[], prefix: string, depth: number, parent?: string) {
        for (const node of nodes) {
            const fullPath = prefix + node.name;
            entries.push({ node, key: fullPath, fullPath, depth, parent });
            if (node.children) walk(node.children, fullPath, depth + 1, fullPath);
        }
    }
    walk(tree.nodes, '', 0);
    return entries;
}

// Text in the data marks code with backticks.
function Inline({ text }: { text: string }) {
    const parts = text.split('`');
    return <>{parts.map((part, index) => index % 2 === 1 ? <code key={index}>{part}</code> : <Fragment key={index}>{part}</Fragment>)}</>;
}

function pageLink(page: string): ReactNode {
    if (page === 'llms.txt') return <a href="/llms.txt">llms.txt</a>;
    return <a href={`/${page}/`}>Read more</a>;
}

// Server output and the first client render match: the static table.
function useHydrated(): boolean {
    const [hydrated, setHydrated] = useState(false);
    useEffect(() => setHydrated(true), []);
    return hydrated;
}

function StaticTables() {
    return (
        <div className="directory-explorer-static">
            {directoryTrees.map((tree) => (
                <table key={tree.name}>
                    <caption>{tree.label}: <code>{tree.root}</code></caption>
                    <thead>
                        <tr><th scope="col">Path</th><th scope="col">What it is</th><th scope="col">Written by</th><th scope="col">Where</th></tr>
                    </thead>
                    <tbody>
                        {entriesOf(tree).map((entry) => (
                            <tr key={entry.key}>
                                <td><code>{entry.fullPath}</code></td>
                                <td><Inline text={entry.node.summary} /></td>
                                <td>{writerLabels[entry.node.writer]}</td>
                                <td>{placementLabels[entry.node.placement]}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            ))}
        </div>
    );
}

function Detail({ tree, entry }: { tree: DirectoryTree; entry: Entry }) {
    const [copied, setCopied] = useState(false);
    const { node } = entry;
    useEffect(() => setCopied(false), [entry.key]);

    async function copy() {
        if (!node.example) return;
        try {
            await navigator.clipboard.writeText(node.example);
            setCopied(true);
        } catch {
            setCopied(false);
        }
    }

    return (
        <div className="directory-explorer-detail" aria-live="polite">
            <p className="directory-explorer-path"><code>{tree.root}/{entry.fullPath}</code></p>
            <p className="directory-explorer-badges">
                <span className={`directory-explorer-badge writer-${node.writer}`}>{writerLabels[node.writer]}</span>
                <span className={`directory-explorer-badge placement-${node.placement}`}>{placementLabels[node.placement]}</span>
            </p>
            <p className="directory-explorer-summary"><Inline text={node.summary} /></p>
            <h4>When it loads</h4>
            <p><Inline text={node.loads} /></p>
            <p><Inline text={node.detail} /></p>
            {node.example && (
                <div className="directory-explorer-example">
                    <div className="directory-explorer-example-bar">
                        <span>Example</span>
                        <button type="button" onClick={() => void copy()}>{copied ? 'Copied' : 'Copy'}</button>
                    </div>
                    <pre><code>{node.example}</code></pre>
                </div>
            )}
            <p className="directory-explorer-link">{pageLink(node.documentedIn)}</p>
        </div>
    );
}

function Explorer() {
    const id = useId();
    const [treeName, setTreeName] = useState<TreeName>('home');
    const tree = directoryTrees.find((candidate) => candidate.name === treeName) ?? directoryTrees[0]!;
    const entries = entriesOf(tree);
    const [selected, setSelected] = useState<string>(entries[0]!.key);
    const [expanded, setExpanded] = useState<Set<string>>(new Set());
    const items = useRef(new Map<string, HTMLLIElement>());

    const visible = entries.filter((entry) => {
        let parent = entry.parent;
        while (parent) {
            if (!expanded.has(parent)) return false;
            parent = entries.find((candidate) => candidate.key === parent)?.parent;
        }
        return true;
    });
    const current = entries.find((entry) => entry.key === selected) ?? entries[0]!;

    function chooseTree(name: TreeName) {
        const next = directoryTrees.find((candidate) => candidate.name === name)!;
        setTreeName(name);
        setSelected(entriesOf(next)[0]!.key);
        setExpanded(new Set());
    }

    function toggle(key: string) {
        setExpanded((previous) => {
            const next = new Set(previous);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
        });
    }

    function focus(key: string) {
        setSelected(key);
        items.current.get(key)?.focus();
    }

    function onKeyDown(event: KeyboardEvent<HTMLLIElement>, entry: Entry) {
        const index = visible.findIndex((candidate) => candidate.key === entry.key);
        const hasChildren = Boolean(entry.node.children?.length);
        switch (event.key) {
            case 'ArrowDown':
                if (visible[index + 1]) focus(visible[index + 1]!.key);
                break;
            case 'ArrowUp':
                if (visible[index - 1]) focus(visible[index - 1]!.key);
                break;
            case 'ArrowRight':
                if (hasChildren && !expanded.has(entry.key)) toggle(entry.key);
                else if (hasChildren && visible[index + 1]) focus(visible[index + 1]!.key);
                break;
            case 'ArrowLeft':
                if (hasChildren && expanded.has(entry.key)) toggle(entry.key);
                else if (entry.parent) focus(entry.parent);
                break;
            case 'Home':
                focus(visible[0]!.key);
                break;
            case 'End':
                focus(visible[visible.length - 1]!.key);
                break;
            case 'Enter':
            case ' ':
                setSelected(entry.key);
                if (hasChildren) toggle(entry.key);
                break;
            default:
                return;
        }
        event.preventDefault();
    }

    return (
        <>
            <div className="directory-explorer-tabs" role="tablist" aria-label="Directory">
                {directoryTrees.map((candidate) => (
                    <button
                        key={candidate.name}
                        type="button"
                        role="tab"
                        id={`${id}-${candidate.name}-tab`}
                        aria-selected={candidate.name === treeName}
                        aria-controls={`${id}-panel`}
                        onClick={() => chooseTree(candidate.name)}
                    >
                        {candidate.label}
                    </button>
                ))}
            </div>
            <p className="directory-explorer-intro"><Inline text={tree.intro} /></p>
            <div className="directory-explorer-panes" role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-${treeName}-tab`}>
                <div className="directory-explorer-tree">
                    <p className="directory-explorer-root"><code>{tree.root}</code></p>
                    <ul role="tree" aria-label={`${tree.label} directory`}>
                        {visible.map((entry) => {
                            const hasChildren = Boolean(entry.node.children?.length);
                            const isOpen = expanded.has(entry.key);
                            return (
                                <li
                                    key={entry.key}
                                    ref={(element) => {
                                        if (element) items.current.set(entry.key, element);
                                        else items.current.delete(entry.key);
                                    }}
                                    role="treeitem"
                                    aria-level={entry.depth + 1}
                                    aria-selected={entry.key === current.key}
                                    aria-expanded={hasChildren ? isOpen : undefined}
                                    tabIndex={entry.key === current.key ? 0 : -1}
                                    style={{ paddingLeft: `${0.5 + entry.depth * 1.1}rem` }}
                                    onClick={() => {
                                        setSelected(entry.key);
                                        if (hasChildren) toggle(entry.key);
                                    }}
                                    onKeyDown={(event) => onKeyDown(event, entry)}
                                >
                                    <span className="directory-explorer-twisty" aria-hidden="true">{hasChildren ? (isOpen ? '▾' : '▸') : ''}</span>
                                    <span className="directory-explorer-name">{entry.node.name}</span>
                                    <span className={`directory-explorer-dot writer-${entry.node.writer}`} aria-hidden="true" />
                                </li>
                            );
                        })}
                    </ul>
                </div>
                <Detail tree={tree} entry={current} />
            </div>
            <p className="directory-explorer-legend">
                <span><span className="directory-explorer-dot writer-you" aria-hidden="true" />{writerLabels.you}</span>
                <span><span className="directory-explorer-dot writer-vera" aria-hidden="true" />{writerLabels.vera}</span>
                <span><span className="directory-explorer-dot writer-both" aria-hidden="true" />{writerLabels.both}</span>
            </p>
        </>
    );
}

export function DirectoryExplorer() {
    const hydrated = useHydrated();
    return (
        <figure className="directory-explorer not-prose">
            {hydrated ? <Explorer /> : <StaticTables />}
            <figcaption>{hydrated ? 'Choose a file or directory to see what it holds and when Vera reads it.' : 'The files Vera reads and writes, in your home and in a project.'}</figcaption>
        </figure>
    );
}
