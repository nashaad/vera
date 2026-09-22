// The Vera mark as three shapes, so the beak can move on its own.
interface CrowMarkProps {
    step: number;
    playing: boolean;
}

export function CrowMark({ step, playing }: CrowMarkProps) {
    return (
        <svg className={playing ? 'crow-mark is-playing' : 'crow-mark'} viewBox="40 70 320 260" aria-hidden="true">
            <g className="crow-mark-bird">
                <polygon points="96,80 200,80 230,100 168,144 50,144" />
                <polygon points="58,158 168,158 208,182 208,320 170,305" />
                {/* Remounts per step, so the peck plays once on each change. */}
                <g key={step} className="crow-mark-beak">
                    <polygon points="240,106 350,137 348,144 210,163 190,148" />
                </g>
            </g>
        </svg>
    );
}
