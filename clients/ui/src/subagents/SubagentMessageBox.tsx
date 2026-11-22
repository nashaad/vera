import { useEffect, useRef, useState, type KeyboardEvent } from "react";

import { appendDiffComments } from "../../../shared/diff-comment.ts";
import { ComposerBox } from "../composer/ComposerBox.tsx";
import { DiffCommentChips } from "../composer/DiffCommentChips.tsx";
import { getDiffComments, removeDiffComments } from "../composer/diff-comments.ts";
import { useDiffComments } from "../composer/useDiffComments.ts";
import { sendPrompt, type SentPrompt } from "../composer/requests.ts";
import { escapeAction } from "../composer/rules.ts";
import type { SessionWatch } from "../session/model.ts";
import { releaseQueuedCommand } from "../session/wire.ts";
import { messageEnterAction, messagePlaceholder } from "./messageBox.ts";

export interface SubagentMessageBoxProps {
    readonly sessionId: string;
    readonly watch: SessionWatch;
    readonly send: (line: string) => void;
}

// Plain text to one subagent: no slash commands, files or pills.
export function SubagentMessageBox({ sessionId, watch, send }: SubagentMessageBoxProps) {
    const [text, setText] = useState("");
    const [notice, setNotice] = useState<string | undefined>(undefined);
    const lastSent = useRef<(SentPrompt & { readonly hasDiffComments: boolean }) | undefined>(undefined);
    const attached = watch.phase === "attached";
    const running = watch.status !== "idle";
    const queued = watch.queue.length > 0;
    const comments = useDiffComments(sessionId);
    const empty = text.trim().length === 0 && comments.length === 0;

    // A refusal of the last message sent from here gives the text back and says why.
    useEffect(() => {
        const last = lastSent.current;
        const refused = watch.refused;
        if (last === undefined || refused === undefined || refused.requestId !== last.requestId) return;
        lastSent.current = undefined;
        setNotice(refused.reason);
        setText((current) => (current.length === 0 ? last.text : last.hasDiffComments ? `${last.text}\n\n${current}` : current));
    }, [watch.refused]);

    const submit = (): void => {
        const sentComments = getDiffComments(sessionId);
        const content = appendDiffComments(text.trim(), sentComments);
        if (!attached || content.length === 0) return;
        setNotice(undefined);
        setText("");
        lastSent.current = { ...sendPrompt(send, content), hasDiffComments: sentComments.length > 0 };
        removeDiffComments(sessionId, sentComments.map((comment) => comment.id));
    };

    const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
        const composing = event.nativeEvent.isComposing;
        if (event.key === "Enter") {
            const action = messageEnterAction({ shift: event.shiftKey, composing, empty, running, queued });
            if (action === "passthrough") return;
            event.preventDefault();
            if (action === "send") submit();
            else if (action === "steer") send(releaseQueuedCommand("all"));
        } else if (event.key === "Escape") {
            if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || watch.requests.length > 0) return;
            if (escapeAction({ composing, empty, queued }) !== "release-one") return;
            event.preventDefault();
            send(releaseQueuedCommand("one"));
        }
    };

    return (
        <div className="composer-wrap subagent-message">
            <div className="composer-inner wide">
                <DiffCommentChips sessionId={sessionId} comments={comments} />
                {notice === undefined ? null : <p className="composer-notice" role="status">{notice}</p>}
                <ComposerBox
                    text={text}
                    onText={setText}
                    placeholder={messagePlaceholder(watch)}
                    disabled={!attached}
                    onKeyDown={onKeyDown}
                    buttonMode="send"
                    buttonEnabled={attached && !empty}
                    onPress={submit}
                    attachEnabled={false}
                    autoFocus={false}
                />
            </div>
        </div>
    );
}
