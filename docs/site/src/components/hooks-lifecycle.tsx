import { useId } from 'react';
import '../styles/diagrams.css';

interface StepProps {
    x: number;
    y: number;
    label: string;
    detail?: string;
    hook?: boolean;
}

const NODE_WIDTH = 210;
const NODE_HEIGHT = 52;
const NODE_X = 80;
const CENTER = NODE_X + NODE_WIDTH / 2;
const NODE_RIGHT = NODE_X + NODE_WIDTH;

function Step({ x, y, label, detail, hook = false }: StepProps) {
    const classes = hook ? 'flow-node flow-node-hook' : 'flow-node';
    return (
        <g className={classes}>
            <rect x={x} y={y} width={NODE_WIDTH} height={NODE_HEIGHT} rx="8" />
            <text x={x + NODE_WIDTH / 2} y={detail ? y + 19 : y + 26} dominantBaseline="middle" textAnchor="middle">{label}</text>
            {detail && (
                <text className="flow-detail" x={x + NODE_WIDTH / 2} y={y + 37} dominantBaseline="middle" textAnchor="middle">{detail}</text>
            )}
        </g>
    );
}

export function HooksLifecycle() {
    const id = useId();
    const arrow = `${id}-arrow`;
    const title = `${id}-title`;
    const description = `${id}-description`;
    const marker = `url(#${arrow})`;
    const sessionY = 16;
    const messageY = 132;
    const modelY = 208;
    const beforeY = 336;
    const permissionY = 420;
    const runsY = 496;
    const afterY = 572;
    const responseY = 728;
    const joinY = 668;
    const blockedX = 324;
    const answerX = 390;

    return (
        <figure className="conversation-diagram hooks-lifecycle not-prose">
            <div className="conversation-diagram-scroll" tabIndex={0} role="region" aria-label="Hook lifecycle diagram">
                <svg viewBox="0 0 416 816" role="img" aria-labelledby={`${title} ${description}`}>
                    <title id={title}>When a hook runs</title>
                    <desc id={description}>
                        Session start runs when a conversation starts or resumes, then your message
                        reaches the model. After compaction during a turn it runs again and the model
                        continues without a new user message; after /compact it waits for your next message. If the model calls a tool, a hook runs before
                        the permission check. A blocked call skips the tool and returns its reason
                        to the model. Otherwise the tool runs, a hook runs after it, and the result
                        returns to the model. The model may call another tool or answer.
                    </desc>
                    <defs>
                        <marker id={arrow} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                            <path d="M 1 1 L 8 5 L 1 9" fill="none" stroke="context-stroke" strokeWidth="1.5" />
                        </marker>
                    </defs>
                    <rect className="flow-region is-turn" x="16" y="96" width="384" height="704" rx="8" />
                    <text className="flow-region-label" x="28" y="114">Each turn</text>
                    <rect className="flow-region is-tool" x="56" y="304" width="296" height="384" rx="8" />
                    <text className="flow-region-label" x="68" y="322">Each tool call</text>
                    <g className="flow-lines">
                        <path d={`M ${CENTER} ${sessionY + NODE_HEIGHT} V ${messageY - 8}`} markerEnd={marker} />
                        <path d={`M ${CENTER} ${messageY + NODE_HEIGHT} V ${modelY - 8}`} markerEnd={marker} />
                        <path d={`M ${CENTER} ${modelY + NODE_HEIGHT} V ${beforeY - 8}`} markerEnd={marker} />
                        <path d={`M ${CENTER} ${beforeY + NODE_HEIGHT} V ${permissionY - 8}`} markerEnd={marker} />
                        <path d={`M ${CENTER} ${permissionY + NODE_HEIGHT} V ${runsY - 8}`} markerEnd={marker} />
                        <path d={`M ${CENTER} ${runsY + NODE_HEIGHT} V ${afterY - 8}`} markerEnd={marker} />
                        <path className="is-result" d={`M ${CENTER} ${afterY + NODE_HEIGHT} V ${joinY}`} />
                        <path className="is-blocked" d={`M ${NODE_RIGHT} ${beforeY + NODE_HEIGHT / 2} H ${blockedX} V ${joinY} H ${CENTER + 8}`} markerEnd={marker} />
                        <path className="is-result" d={`M ${CENTER} ${joinY} H 32 V ${modelY + NODE_HEIGHT / 2} H ${NODE_X}`} markerEnd={marker} />
                        <path className="is-answer" d={`M ${NODE_RIGHT} ${modelY + NODE_HEIGHT / 2} H ${answerX} V ${responseY + NODE_HEIGHT / 2} H ${NODE_RIGHT + 4}`} markerEnd={marker} />
                    </g>
                    <text className="flow-note" x={CENTER + 8} y="288">calls a tool</text>
                    <text className="flow-note is-answer" x={NODE_RIGHT + 16} y={modelY + 12}>answers</text>
                    <text className="flow-note is-blocked" x={NODE_RIGHT + 4} y={beforeY - 6}>blocked</text>
                    <text className="flow-note is-result" x="40" y={joinY - 6}>result</text>
                    <Step x={NODE_X} y={sessionY} label="Session start" detail="start, resume, after compaction" hook />
                    <Step x={NODE_X} y={messageY} label="Your message" />
                    <Step x={NODE_X} y={modelY} label="Model" />
                    <Step x={NODE_X} y={beforeY} label="Before the tool" detail="pre_tool_use" hook />
                    <Step x={NODE_X} y={permissionY} label="Permission check" />
                    <Step x={NODE_X} y={runsY} label="Tool runs" />
                    <Step x={NODE_X} y={afterY} label="After the tool" detail="post_tool_use" hook />
                    <Step x={NODE_X} y={responseY} label="Response" />
                </svg>
            </div>
            <figcaption>
                Outlined steps are hooks. A blocked call returns its reason to the model without
                running the tool. Otherwise the result returns to the model, which may call another
                tool or answer. After compaction during a turn, session start runs again and the
                model continues. After /compact, Vera waits for your next message.
            </figcaption>
        </figure>
    );
}
