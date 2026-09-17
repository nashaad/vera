import type { APIRoute, GetStaticPaths } from 'astro';
import type { CollectionEntry } from 'astro:content';
import { getManualEntries } from '../lib/visibility';

interface Props {
    entry: CollectionEntry<'docs'>;
}

export const getStaticPaths: GetStaticPaths = async () => {
    const entries = await getManualEntries();
    return entries.map((entry) => ({ params: { slug: entry.id }, props: { entry } }));
};

export const GET: APIRoute<Props> = ({ props }) => new Response(props.entry.body, {
    headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
});
