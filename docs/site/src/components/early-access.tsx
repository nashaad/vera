import { useEffect, useState } from 'react';
import type { Node, Root } from 'fumadocs-core/page-tree';

const STORAGE_KEY = 'vera-manual-show-early-access';

function readSaved(): boolean {
    try {
        return window.localStorage.getItem(STORAGE_KEY) === 'true';
    } catch {
        return false;
    }
}

function save(show: boolean): void {
    try {
        window.localStorage.setItem(STORAGE_KEY, String(show));
    } catch {
        // Private windows can block storage; the switch still works for this page.
    }
}

// Starts hidden on the server, then applies the saved choice after hydration.
export function useShowEarlyAccess(): [boolean, (show: boolean) => void] {
    const [show, setShow] = useState(false);
    useEffect(() => setShow(readSaved()), []);
    const update = (next: boolean) => {
        setShow(next);
        save(next);
    };
    return [show, update];
}

// Drops early access pages, then any separator left with no pages under it.
export function hideEarlyAccess(tree: Root, earlyAccessUrls: string[]): Root {
    const hidden = new Set(earlyAccessUrls);
    const pages = tree.children.filter((node) => node.type !== 'page' || !hidden.has(node.url));
    const children: Node[] = [];
    for (let i = 0; i < pages.length; i++) {
        const node = pages[i]!;
        const next = pages[i + 1];
        if (node.type === 'separator' && (next === undefined || next.type === 'separator')) continue;
        children.push(node);
    }
    // The sidebar caches the tree by $id, so the filtered copy needs its own.
    return { ...tree, $id: `${tree.$id ?? 'root'}-stable`, children };
}

interface EarlyAccessSwitchProps {
    show: boolean;
    pageCount: number;
    onChange: (show: boolean) => void;
}

export function EarlyAccessSwitch({ show, pageCount, onChange }: EarlyAccessSwitchProps) {
    const status = show
        ? `${pageCount} pages added under Workflows (early access)`
        : 'Workflows and Python SDK hidden';
    return (
        <button type="button" role="switch" aria-checked={show} className="early-access" onClick={() => onChange(!show)}>
            <span>
                <span className="early-access-label">Early access</span>
                <span className="early-access-status" aria-live="polite">{status}</span>
            </span>
            <span className="early-access-track" aria-hidden="true" />
        </button>
    );
}
