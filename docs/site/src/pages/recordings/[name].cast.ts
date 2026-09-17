import type { APIRoute, GetStaticPaths } from 'astro';
import { getManualEntries } from '../../lib/visibility';
import modelPicker from '../../recordings/model-picker.cast?raw';

const recordings = { 'model-picker': modelPicker };

interface Props {
    recording: string;
}

export const getStaticPaths: GetStaticPaths = async () => {
    const entries = await getManualEntries();
    const names = new Set(entries.flatMap((entry) => entry.data.replay ? [entry.data.replay] : []));
    return [...names].map((name) => ({ params: { name }, props: { recording: recordings[name] } }));
};

export const GET: APIRoute<Props> = ({ props }) => new Response(props.recording, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
});
