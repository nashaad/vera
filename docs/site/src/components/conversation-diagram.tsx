import { useId } from 'react';
import '../styles/diagrams.css';

interface DiagramNodeProps {
    x: number;
    y: number;
    label: string;
    emphasis?: boolean;
}

function DiagramNode({ x, y, label, emphasis = false }: DiagramNodeProps) {
    return (
        <g className={emphasis ? 'flow-node flow-node-primary' : 'flow-node'}>
            <rect x={x} y={y} width="156" height="52" rx="8" />
            <text x={x + 78} y={y + 26} dominantBaseline="middle" textAnchor="middle">{label}</text>
        </g>
    );
}

export function ConversationDiagram() {
    const id = useId();
    const arrow = `${id}-arrow`;
    const title = `${id}-title`;
    const description = `${id}-description`;
    return (
        <figure className="conversation-diagram not-prose">
            <div className="conversation-diagram-scroll" tabIndex={0} role="region" aria-label="Conversation flow diagram">
                <svg viewBox="0 0 640 330" role="img" aria-labelledby={`${title} ${description}`}>
                    <title id={title}>A conversation with Vera</title>
                    <desc id={description}>Your message reaches the model. The model can respond or request a tool. Vera checks permission before running the tool. Tool results return to the model, and the cycle can repeat.</desc>
                    <defs>
                        <marker id={arrow} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                            <path d="M 1 1 L 8 5 L 1 9" fill="none" stroke="currentColor" strokeWidth="1.5" />
                        </marker>
                    </defs>
                    <g className="flow-lines" markerEnd={`url(#${arrow})`}>
                        <path d="M 176 52 H 232" />
                        <path d="M 396 52 H 452" />
                        <path d="M 318 78 V 124" />
                        <path d="M 396 158 H 452" />
                        <path d="M 538 184 V 230" />
                        <path d="M 460 264 H 404" />
                        <path d="M 240 264 H 212 Q 196 264 196 248 V 100 Q 196 84 212 84 H 218 Q 230 84 240 70" />
                    </g>
                    <DiagramNode x={20} y={26} label="Your message" />
                    <DiagramNode x={240} y={26} label="Model + context" emphasis />
                    <DiagramNode x={460} y={26} label="Response" />
                    <DiagramNode x={240} y={132} label="Tool request" />
                    <DiagramNode x={460} y={132} label="Permission check" />
                    <DiagramNode x={460} y={238} label="Run tool" />
                    <DiagramNode x={240} y={238} label="Tool results" />
                    <text className="flow-note" x="20" y="160">Tool use repeats</text>
                    <text className="flow-note" x="20" y="182">as needed.</text>
                </svg>
            </div>
            <figcaption>Vera checks permissions before each tool runs. Results return to the model.</figcaption>
        </figure>
    );
}
