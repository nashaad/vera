import { useEffect, useId, useState } from 'react';
import { CONTEXT_ENTRIES, FLOW_EVENT, type ContextEntry, type FlowHighlight, type FlowLine, type FlowNode } from '../data/screen-steps';
import '../styles/diagrams.css';

interface DiagramNodeProps {
    x: number;
    y: number;
    label: string;
    emphasis?: boolean;
    active: boolean;
    detail?: string;
}

function DiagramNode({ x, y, label, emphasis = false, active, detail }: DiagramNodeProps) {
    const classes = ['flow-node'];
    if (emphasis) classes.push('flow-node-primary');
    if (active) classes.push('is-active');
    return (
        <g className={classes.join(' ')}>
            <rect x={x} y={y} width="156" height="52" rx="8" />
            <text x={x + 78} y={detail ? y + 19 : y + 26} dominantBaseline="middle" textAnchor="middle">{label}</text>
            {detail && <text key={detail} className="flow-detail" x={x + 78} y={y + 37} dominantBaseline="middle" textAnchor="middle">{detail}</text>}
        </g>
    );
}

interface NodeSpec {
    id: FlowNode;
    x: number;
    y: number;
    label: string;
    emphasis?: boolean;
}

const NODES: NodeSpec[] = [
    { id: 'message', x: 20, y: 26, label: 'Your message' },
    { id: 'model', x: 240, y: 26, label: 'Model + context', emphasis: true },
    { id: 'response', x: 460, y: 26, label: 'Response' },
    { id: 'request', x: 240, y: 132, label: 'Tool request' },
    { id: 'permission', x: 460, y: 132, label: 'Permission check' },
    { id: 'run', x: 460, y: 238, label: 'Run tool' },
    { id: 'results', x: 240, y: 238, label: 'Tool results' },
];

const LINES: Record<FlowLine, string> = {
    'message-model': 'M 176 52 H 232',
    'model-response': 'M 396 52 H 452',
    'model-request': 'M 318 78 V 124',
    'request-permission': 'M 396 158 H 452',
    'permission-run': 'M 538 184 V 230',
    'run-results': 'M 460 264 H 404',
    'results-model': 'M 240 264 H 212 Q 196 264 196 248 V 100 Q 196 84 212 84 H 218 Q 230 84 240 70',
};

const BAR_WIDTHS = ['62%', '44%', '54%'];

// Fixed height, so the reader sees the space fill up as each turn adds to it.
export function ContextPanel({ entries: all, count, fresh = 1 }: { entries: ContextEntry[]; count: number; fresh?: number }) {
    const entries = all.slice(0, count);
    return (
        <div className="flow-context" aria-hidden="true">
            <div className="flow-context-title">What the model sees</div>
            <div className="flow-context-body">
                {entries.map((entry, index) => (
                    <div
                        key={index}
                        className={index >= count - fresh ? `flow-context-entry ${entry.role} is-new` : `flow-context-entry ${entry.role}`}
                    >
                        <span className="flow-context-role">{entry.role}</span>
                        <span className="flow-context-content">
                            <span className="flow-context-text">{entry.text}</span>
                            {BAR_WIDTHS.slice(0, (entry.lines ?? 1) - 1).map((width, bar) => (
                                <span key={bar} className="flow-context-bar" style={{ width }} />
                            ))}
                        </span>
                    </div>
                ))}
            </div>
        </div>
    );
}

function nodeDetail(node: FlowNode, flow: FlowHighlight | undefined): string | undefined {
    if (!flow) return undefined;
    if (node === flow.node) return flow.detail;
    if (node === 'model') return flow.model;
    return undefined;
}

// The tool-call widget below the diagram drives the highlight; without it the diagram stays still.
export function ConversationDiagram({ wide = false }: { wide?: boolean }) {
    const id = useId();
    const arrow = `${id}-arrow`;
    const activeArrow = `${id}-arrow-active`;
    const title = `${id}-title`;
    const description = `${id}-description`;
    const [flow, setFlow] = useState<FlowHighlight | undefined>(undefined);

    useEffect(() => {
        function onFlow(event: Event) {
            setFlow((event as CustomEvent<FlowHighlight | undefined>).detail);
        }
        window.addEventListener(FLOW_EVENT, onFlow);
        return () => window.removeEventListener(FLOW_EVENT, onFlow);
    }, []);

    const landing = NODES.find((node) => node.id === flow?.node);
    return (
        <figure className={wide ? 'conversation-diagram wide not-prose' : 'conversation-diagram not-prose'}>
            <ContextPanel entries={CONTEXT_ENTRIES} count={flow?.context ?? 0} />
            <div className="conversation-diagram-scroll" tabIndex={0} role="region" aria-label="Conversation flow diagram">
                <svg viewBox="0 0 640 330" role="img" aria-labelledby={`${title} ${description}`}>
                    <title id={title}>A conversation with Vera</title>
                    <desc id={description}>Your message reaches the model. The model can respond or request a tool. Vera checks permission before running the tool. Tool results return to the model, and the cycle can repeat.</desc>
                    <defs>
                        <marker id={arrow} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                            <path d="M 1 1 L 8 5 L 1 9" fill="none" stroke="currentColor" strokeWidth="1.5" />
                        </marker>
                        <marker id={activeArrow} className="flow-marker-active" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                            <path d="M 1 1 L 8 5 L 1 9" fill="none" strokeWidth="1.5" />
                        </marker>
                    </defs>
                    <g className="flow-lines">
                        {(Object.keys(LINES) as FlowLine[]).map((line) => {
                            const trail = flow?.trail.includes(line) ?? false;
                            return <path key={line} d={LINES[line]} className={trail ? 'is-trail' : undefined} markerEnd={`url(#${trail ? activeArrow : arrow})`} />;
                        })}
                    </g>
                    {NODES.map((node) => (
                        <DiagramNode key={node.id} x={node.x} y={node.y} label={node.label} emphasis={node.emphasis} active={flow?.node === node.id} detail={nodeDetail(node.id, flow)} />
                    ))}
                    {landing && flow && (
                        <g className="flow-badge" key={flow.step}>
                            <circle cx={landing.x + 4} cy={landing.y + 4} r="11" />
                            <text x={landing.x + 4} y={landing.y + 4} dominantBaseline="central" textAnchor="middle">{flow.step}</text>
                        </g>
                    )}
                    <text className="flow-note" x="20" y="160">Tool use repeats</text>
                    <text className="flow-note" x="20" y="182">as needed.</text>
                </svg>
            </div>
            <figcaption>Vera checks permissions before each tool runs. Results return to the model.</figcaption>
        </figure>
    );
}
