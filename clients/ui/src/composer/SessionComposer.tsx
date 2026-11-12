import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";

import { effortCommand, switchModelCommand } from "../models/commands.ts";
import { ModelPills } from "../models/ModelPills.tsx";
import { useSessionModels } from "../models/useSessionModels.ts";
import { subscribeDrafts, takeDraft } from "../session/drafts.ts";
import { takePendingPrompt, type PendingPrompt } from "../session/pendingPrompt.ts";
import { abortCommand, releaseQueuedCommand, withdrawQueuedCommand } from "../session/wire.ts";
import type { SessionComposerProps } from "./Composer.tsx";
import { ApprovalPill } from "./ApprovalPill.tsx";
import { ComposerBox } from "./ComposerBox.tsx";
import { ContextChips } from "./ContextChips.tsx";
import { imagePathsOf } from "./files.ts";
import { ImageChips } from "./ImageChips.tsx";
import { imageLabel, imageState, readyAttachments } from "./images.ts";
import { freshRequestId, sendPrompt, type SentPrompt } from "./requests.ts";
import { arrowUpAction, enterAction, escapeAction, folderMissingNotice } from "./rules.ts";
import { useSlashMenu } from "./slash/useSlashMenu.ts";
import { useBranch } from "./useBranch.ts";
import { useFolderMissing } from "./useFolderMissing.ts";
import { useSessionImages } from "./useImages.ts";

const IMAGES_WAITING = "The images are still attaching.";
const NOT_IMAGES = "Only image files can be attached.";
const MODEL_REFUSED = "Vera could not start this session on the model you chose, so the prompt was not sent.";

interface ModelGate {
    readonly requestId: string;
    readonly prompt: PendingPrompt;
}

export function SessionComposer({ bridge, agentId, watch, send, folder, chat }: SessionComposerProps) {
    const [text, setText] = useState("");
    const [notice, setNotice] = useState<string | undefined>(undefined);
    // Set when a New Chat prompt waits for its images before it goes out.
    const [autoSend, setAutoSend] = useState(false);
    const lastSent = useRef<SentPrompt | undefined>(undefined);
    const withdrawing = useRef<string | undefined>(undefined);
    const input = useRef<HTMLTextAreaElement>(null);
    const [landed, setLanded] = useState(0);
    // A New Chat prompt waits here until the session has switched to the model chosen for it.
    const modelGate = useRef<ModelGate | undefined>(undefined);
    const attached = watch.phase === "attached";
    const running = watch.status !== "idle";
    const queued = watch.queue.length > 0;
    const held = watch.queue.some((prompt) => prompt.state === "held");
    const empty = text.trim().length === 0;
    const branch = useBranch(bridge, chat ? undefined : folder);
    const missing = useFolderMissing(bridge, folder, chat);
    const onRefused = useCallback((reason: string) => {
        setNotice(reason);
        setAutoSend(false);
    }, []);
    const { images, add, remove, clear } = useSessionImages(send, watch.images, onRefused);
    const ready = readyAttachments(images, watch.images);
    const models = useSessionModels(bridge, watch, send, folder);
    const slash = useSlashMenu({
        text,
        setText,
        session: { bridge, agentId, send, attached, running },
        notify: setNotice,
    });

    // A refusal of the last prompt sent from here gives the text back and says why.
    useEffect(() => {
        const last = lastSent.current;
        const refused = watch.refused;
        if (last === undefined || refused === undefined || refused.requestId !== last.requestId) return;
        lastSent.current = undefined;
        setNotice(refused.reason);
        setText((current) => (current.length === 0 ? last.text : current));
    }, [watch.refused]);

    // A prompt a rewind or fork gave back, or a quoted reply, lands in the box to edit.
    useEffect(() => {
        const land = (): void => {
            const draft = takeDraft(agentId);
            if (draft === undefined) return;
            setText((current) => (current.trim().length === 0 ? draft : `${current}\n${draft}`));
            setLanded((count) => count + 1);
        };
        land();
        return subscribeDrafts((target) => {
            if (target === agentId) land();
        });
    }, [agentId]);

    // Runs after a closing menu hands focus back to its button, so the box keeps it.
    useEffect(() => {
        const box = input.current;
        if (landed === 0 || box === null) return;
        box.focus();
        box.setSelectionRange(box.value.length, box.value.length);
    }, [landed]);

    // A prompt taken back out of the queue lands in the box to edit.
    useEffect(() => {
        const withdrawn = watch.withdrawn;
        if (withdrawn === undefined || withdrawn.requestId !== withdrawing.current) return;
        withdrawing.current = undefined;
        setText((current) => (current.trim().length === 0 ? withdrawn.content : `${current}\n${withdrawn.content}`));
    }, [watch.withdrawn]);

    const startPending = useCallback((pending: PendingPrompt): void => {
        if (pending.images.length === 0) {
            lastSent.current = sendPrompt(send, pending.text);
            return;
        }
        setText(pending.text);
        add(pending.images);
        setAutoSend(true);
    }, [send, add]);

    // A prompt typed on New Chat goes out once, when the new session's watch attaches.
    useEffect(() => {
        if (!attached) return;
        const pending = takePendingPrompt(agentId);
        if (pending === undefined) return;
        const model = pending.model;
        if (model === undefined) {
            startPending(pending);
            return;
        }
        const requestId = freshRequestId("model");
        modelGate.current = { requestId, prompt: pending };
        send(model.switched
            ? switchModelCommand(requestId, model.provider, model.model, model.effort)
            : effortCommand(requestId, model.effort ?? null));
    }, [attached, agentId, send, startPending]);

    useEffect(() => {
        const gate = modelGate.current;
        if (gate === undefined) return;
        if (watch.models?.requestId === gate.requestId) {
            modelGate.current = undefined;
            startPending(gate.prompt);
        } else if (watch.modelRefused?.requestId === gate.requestId) {
            modelGate.current = undefined;
            setNotice(MODEL_REFUSED);
            setText(gate.prompt.text);
            if (gate.prompt.images.length > 0) add(gate.prompt.images);
        }
    }, [watch.models, watch.modelRefused, startPending, add]);

    const submit = (): void => {
        const content = text.trim();
        if (!attached || content.length === 0) return;
        if (slash.runLine(content)) return;
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
        if (slash.onKeyDown(event)) return;
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
            <ContextChips folder={folder} branch={branch} chat={chat} missing={missing} />
            <ImageChips chips={chips} onRemove={remove} />
            {missing && folder !== undefined ? (
                <p className="composer-notice" data-tone="warning" role="status">{folderMissingNotice(folder)}</p>
            ) : null}
            {notice === undefined ? null : <p className="composer-notice" role="status">{notice}</p>}
            <ComposerBox
                text={text}
                onText={setText}
                placeholder={placeholder}
                disabled={!attached}
                onKeyDown={onKeyDown}
                slash={slash.view}
                onBlur={slash.onBlur}
                inputRef={input}
                buttonMode={stopping ? "stop" : "send"}
                buttonEnabled={stopping ? attached : attached && !empty && ready.kind === "ready"}
                onPress={() => (stopping ? send(abortCommand()) : submit())}
                onFiles={addFiles}
                onPaths={add}
                onAttach={() => void bridge.chooseImages().then(add)}
                attachEnabled={attached}
                barStart={
                    <ApprovalPill approval={watch.approval} refused={watch.approvalRefused} send={send} enabled={attached} running={running} />
                }
                barEnd={<ModelPills controls={models} />}
            />
        </div>
    );
}
