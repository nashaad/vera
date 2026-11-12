import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";

import { takePendingPrompt } from "../session/pendingPrompt.ts";
import { abortCommand, releaseQueuedCommand, withdrawQueuedCommand } from "../session/wire.ts";
import type { SessionComposerProps } from "./Composer.tsx";
import { ComposerBox } from "./ComposerBox.tsx";
import { ContextChips } from "./ContextChips.tsx";
import { imagePathsOf } from "./files.ts";
import { ImageChips } from "./ImageChips.tsx";
import { imageLabel, imageState, readyAttachments } from "./images.ts";
import { freshRequestId, sendPrompt, type SentPrompt } from "./requests.ts";
import { arrowUpAction, enterAction, escapeAction } from "./rules.ts";
import { useBranch } from "./useBranch.ts";
import { useSessionImages } from "./useImages.ts";

const IMAGES_WAITING = "The images are still attaching.";
const NOT_IMAGES = "Only image files can be attached.";

export function SessionComposer({ bridge, agentId, watch, send, folder }: SessionComposerProps) {
    const [text, setText] = useState("");
    const [notice, setNotice] = useState<string | undefined>(undefined);
    // Set when a New Chat prompt waits for its images before it goes out.
    const [autoSend, setAutoSend] = useState(false);
    const lastSent = useRef<SentPrompt | undefined>(undefined);
    const withdrawing = useRef<string | undefined>(undefined);
    const attached = watch.phase === "attached";
    const running = watch.status !== "idle";
    const queued = watch.queue.length > 0;
    const held = watch.queue.some((prompt) => prompt.state === "held");
    const empty = text.trim().length === 0;
    const branch = useBranch(bridge, folder);
    const onRefused = useCallback((reason: string) => {
        setNotice(reason);
        setAutoSend(false);
    }, []);
    const { images, add, remove, clear } = useSessionImages(send, watch.images, onRefused);
    const ready = readyAttachments(images, watch.images);

    // A refusal of the last prompt sent from here gives the text back and says why.
    useEffect(() => {
        const last = lastSent.current;
        const refused = watch.refused;
        if (last === undefined || refused === undefined || refused.requestId !== last.requestId) return;
        lastSent.current = undefined;
        setNotice(refused.reason);
        setText((current) => (current.length === 0 ? last.text : current));
    }, [watch.refused]);

    // A prompt taken back out of the queue lands in the box to edit.
    useEffect(() => {
        const withdrawn = watch.withdrawn;
        if (withdrawn === undefined || withdrawn.requestId !== withdrawing.current) return;
        withdrawing.current = undefined;
        setText((current) => (current.trim().length === 0 ? withdrawn.content : `${current}\n${withdrawn.content}`));
    }, [watch.withdrawn]);

    // A prompt typed on New Chat goes out once, when the new session's watch attaches.
    useEffect(() => {
        if (!attached) return;
        const pending = takePendingPrompt(agentId);
        if (pending === undefined) return;
        if (pending.images.length === 0) {
            lastSent.current = sendPrompt(send, pending.text);
            return;
        }
        setText(pending.text);
        add(pending.images);
        setAutoSend(true);
    }, [attached, agentId, send, add]);

    const submit = (): void => {
        const content = text.trim();
        if (!attached || content.length === 0) return;
        if (ready.kind === "waiting") {
            setNotice(IMAGES_WAITING);
            return;
        }
        setNotice(undefined);
        setText("");
        lastSent.current = sendPrompt(send, content, ready.attachmentIds);
        clear();
    };

    useEffect(() => {
        if (!autoSend || ready.kind !== "ready") return;
        setAutoSend(false);
        submit();
    });

    const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
        const composing = event.nativeEvent.isComposing;
        if (event.key === "Enter") {
            const action = enterAction({ shift: event.shiftKey, composing, empty, running, queued });
            if (action === "passthrough") return;
            event.preventDefault();
            if (action === "send") submit();
            else if (action === "release-all") send(releaseQueuedCommand("all"));
            else if (action === "abort") send(abortCommand());
        } else if (event.key === "Escape") {
            if (escapeAction({ composing, empty, queued }) !== "release-one") return;
            event.preventDefault();
            send(releaseQueuedCommand("one"));
        } else if (event.key === "ArrowUp") {
            if (arrowUpAction({ composing, empty, held }) !== "withdraw") return;
            event.preventDefault();
            const requestId = freshRequestId("withdraw");
            withdrawing.current = requestId;
            send(withdrawQueuedCommand(requestId));
        }
    };

    const addFiles = (files: readonly File[]): void => {
        void imagePathsOf(bridge, files).then((paths) => {
            if (paths.length === 0) setNotice(NOT_IMAGES);
            else add(paths);
        });
    };

    const stopping = running && empty;
    const placeholder = watch.phase === "attaching"
        ? "Opening the session"
        : !attached
            ? "Not connected to this session"
            : running
                ? "Queue a message for when this turn ends"
                : "Reply to Vera";
    const chips = images.map((image) => ({
        key: image.requestId,
        label: imageLabel(image),
        name: image.name,
        attaching: imageState(image, watch.images).kind === "attaching",
    }));

    return (
        <div className="composer-inner wide">
            <ContextChips folder={folder} branch={branch} />
            <ImageChips chips={chips} onRemove={remove} />
            {notice === undefined ? null : <p className="composer-notice" role="status">{notice}</p>}
            <ComposerBox
                text={text}
                onText={setText}
                placeholder={placeholder}
                disabled={!attached}
                onKeyDown={onKeyDown}
                buttonMode={stopping ? "stop" : "send"}
                buttonEnabled={stopping ? attached : attached && !empty && ready.kind === "ready"}
                onPress={() => (stopping ? send(abortCommand()) : submit())}
                onFiles={addFiles}
                onPaths={add}
                onAttach={() => void bridge.chooseImages().then(add)}
                attachEnabled={attached}
            />
        </div>
    );
}
