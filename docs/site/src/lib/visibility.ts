import { getCollection } from 'astro:content';

export const showDrafts = import.meta.env.DEV || import.meta.env.MODE === 'preview';

export async function getManualEntries() {
    const entries = await getCollection('docs');
    const visible = entries.filter((entry) => showDrafts || !entry.data.draft);
    const ids = new Set(visible.map((entry) => entry.id));
    return visible.map((entry) => {
        if (entry.id !== 'index') return entry;
        const body = (entry.body ?? '').split('\n').filter((line) => {
            const link = /^- \[[^\]]+\]\(([^)]+)\.md\)$/.exec(line);
            return !link || ids.has(link[1]!);
        }).join('\n');
        return { ...entry, body };
    });
}
