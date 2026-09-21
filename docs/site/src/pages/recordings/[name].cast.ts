import type { APIRoute, GetStaticPaths } from 'astro';
import { getManualEntries } from '../../lib/visibility';
import conversation from '../../recordings/conversation.cast?raw';

const recordings = { conversation };
type RecordingName = keyof typeof recordings;
// The homepage replay is not a manual entry, so it is listed here.
const HOMEPAGE_RECORDINGS: RecordingName[] = ['conversation'];

interface Props {
    recording: string;
}

export const getStaticPaths: GetStaticPaths = async () => {
    const entries = await getManualEntries();
    const names = new Set<RecordingName>(entries.flatMap((entry) => entry.data.replay ? [entry.data.replay] : []));
    for (const name of HOMEPAGE_RECORDINGS) names.add(name);
    return [...names].map((name) => ({ params: { name }, props: { recording: recordings[name] } }));
};

export const GET: APIRoute<Props> = ({ props }) => new Response(props.recording, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
});
