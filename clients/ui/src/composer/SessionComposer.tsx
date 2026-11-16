import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { fileReferences } from "../../../../src/attachments/file-limits.ts";

import { effortCommand, switchModelCommand } from "../models/commands.ts";
import { ModelPills } from "../models/ModelPills.tsx";
import { useSessionModels } from "../models/useSessionModels.ts";
import type { DesktopBridge } from "../protocol/bridge.ts";
import { subscribeDrafts, takeDraft } from "../session/drafts.ts";
import { stepAgentGate } from "../session/agentGate.ts";
import { takePendingPrompt, type PendingPrompt } from "../session/pendingPrompt.ts";
import { useSlowOpening } from "../session/useSlowOpening.ts";
import { abortCommand, releaseQueuedCommand, withdrawQueuedCommand } from "../session/wire.ts";
import type { SessionComposerProps } from "./Composer.tsx";
import { ApprovalPill } from "./ApprovalPill.tsx";
import { ComposerBox } from "./ComposerBox.tsx";
import { ContextChips } from "./ContextChips.tsx";
import { pathsOfFiles } from "./files.ts";
import { ImageChips } from "./ImageChips.tsx";
import { imageLabel, imageState, readyAttachments } from "./images.ts";
import { freshRequestId, sendPrompt, type SentPrompt } from "./requests.ts";
import { NO_ANSWER } from "./slash/run.ts";
import { arrowUpAction, enterAction, escapeAction, folderMissingNotice, MOVE_TO_FOLDER_LABEL } from "./rules.ts";
import { useSlashMenu } from "./slash/useSlashMenu.ts";
import { useBranch } from "./useBranch.ts";
import { useFolderMissing } from "./useFolderMissing.ts";
import { useMoveToFolder } from "./useMoveToFolder.ts";
import { useSessionImages } from "./useImages.ts";
import { useFiles } from "./useFiles.ts";

const IMAGES_WAITING = "The images are still attaching.";
const NO_FILES = "Could not attach this file.";
const MODEL_REFUSED = "Vera could not start this session on the model you chose, so the prompt was not sent.";

// A held first prompt gives up waiting for the agent switch after this long and hands the text back.
const AGENT_WAIT_MS = 10_000;

interface ModelGate {
    readonly requestId: string;
    readonly prompt: PendingPrompt;
}

interface AgentGate {
    readonly prompt: PendingPrompt;
    readonly timer: ReturnType<typeof setTimeout>;
}

export function SessionComposer({ bridge, agentId, pane = "main", watch, send, folder, chat, onMoved, agentStart }: SessionComposerProps) {
    const [text, setText] = useState("");
    const [notice, setNotice] = useState<string | undefined>(undefined);
    // Set when a New Chat prompt waits for its images before it goes out.
    const [autoSend, setAutoSend] = useState(false);
    const [preparing, setPreparing] = useState(false);
    const lastSent = useRef<SentPrompt | undefined>(undefined);
    const withdrawing = useRef<string | undefined>(undefined);
    const input = useRef<HTMLTextAreaElement>(null);
    const [landed, setLanded] = useState(0);
    // A New Chat prompt waits here until the session has switched to the model chosen for it.
    const modelGate = useRef<ModelGate | undefined>(undefined);
    // A New Chat prompt waits here until the session has confirmed the agent chosen for it.
    const agentGate = useRef<AgentGate | undefined>(undefined);
    const attached = watch.phase === "attached";
    // Typing waits while the session switches to the agent it was opened for, so nothing reaches the first agent.
    const hold = attached && agentStart.name !== undefined && !agentStart.selected && agentStart.refused === undefined
        ? "Switching agent"
        : undefined;
    const slowOpening = useSlowOpening(watch);
    const running = watch.status !== "idle";
    const queued = watch.queue.length > 0;
    const held = watch.queue.some((prompt) => prompt.state === "held");
    const empty = text.trim().length === 0;
    const branch = useBranch(bridge, chat ? undefined : folder);
    const missing = useFolderMissing(bridge, folder, chat);
    const move = useMoveToFolder(bridge, agentId, onMoved);
    const onRefused = useCallback((reason: string) => {
        setNotice(reason);
        setAutoSend(false);
    }, []);
    const { images, add, remove, clear } = useSessionImages(send, watch.images, onRefused);
    const selected = useFiles(bridge, folder, chat, images.length, add, setNotice);
    const ready = readyAttachments(images, watch.images);
    const models = useSessionModels(bridge, watch, send, folder);
    const slash = useSlashMenu({
        text,
        setText,
        session: { bridge, agentId, pane, send, attached, running, folder, chat },
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
        if (pending.images.length === 0 && (pending.files?.length ?? 0) === 0) {
            lastSent.current = sendPrompt(send, pending.text);
            return;
        }
        setText(pending.text);
        add(pending.images);
        selected.replace(pending.files ?? []);
        setAutoSend(true);
    }, [send, add, selected.replace]);

    // A prompt that was held and not sent goes back into the box with what was attached to it.
    const restorePending = useCallback((pending: PendingPrompt, reason: string): void => {
        setNotice(reason);
        setText(pending.text);
        if (pending.images.length > 0) add(pending.images);
        selected.replace(pending.files ?? []);
    }, [add, selected.replace]);
    const restoreLatest = useRef(restorePending);
    restoreLatest.current = restorePending;

    // Sends a held prompt, first putting the session on the model chosen for it.
    const proceed = useCallback((pending: PendingPrompt): void => {
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
    }, [send, startPending]);

    // A prompt typed on New Chat goes out once, when the new session's watch attaches.
    useEffect(() => {
        if (!attached) return;
        const pending = takePendingPrompt(agentId);
        if (pending === undefined) return;
        if (pending.agent === undefined) {
            proceed(pending);
            return;
        }
        const timer = setTimeout(() => {
            if (agentGate.current?.prompt !== pending) return;
            agentGate.current = undefined;
            restoreLatest.current(pending, NO_ANSWER);
        }, AGENT_WAIT_MS);
        agentGate.current = { prompt: pending, timer };
    }, [attached, agentId, proceed]);

    useEffect(() => {
        const gate = agentGate.current;
        if (gate?.prompt.agent === undefined) return;
        const step = stepAgentGate(agentStart, gate.prompt.agent);
        if (step.kind === "wait") return;
        clearTimeout(gate.timer);
        agentGate.current = undefined;
        if (step.kind === "send") proceed(gate.prompt);
        else restorePending(gate.prompt, step.reason);
    }, [agentStart, proceed, restorePending]);

    useEffect(() => () => {
        if (agentGate.current !== undefined) clearTimeout(agentGate.current.timer);
    }, []);

    useEffect(() => {
        const gate = modelGate.current;
        if (gate === undefined) return;
        if (watch.models?.requestId === gate.requestId) {
            modelGate.current = undefined;
            startPending(gate.prompt);
        } else if (watch.modelRefused?.requestId === gate.requestId) {
            modelGate.current = undefined;
            restorePending(gate.prompt, MODEL_REFUSED);
        }
    }, [watch.models, watch.modelRefused, startPending, restorePending]);

    const submit = async (): Promise<void> => {
        const content = text.trim();
        if (!attached || hold !== undefined || content.length === 0 || preparing || selected.busy) return;
        if (slash.runLine(content)) return;
        if (ready.kind === "waiting") {
            setNotice(IMAGES_WAITING);
            return;
        }
        let sentContent = content;
        if (selected.files.length > 0) {
            if (folder === undefined) { setNotice("The session folder is not available."); return; }
            setPreparing(true);
            let result: Awaited<ReturnType<DesktopBridge["prepareComposerFiles"]>>;
            try {
                result = await bridge.prepareComposerFiles(selected.files, folder, chat);
            } catch {
                setPreparing(false);
                setNotice("Could not attach these files.");
                return;
            }
            setPreparing(false);
            if (result.paths === undefined) { setNotice(result.error ?? "Could not attach these files."); return; }
            sentContent = `${content}\n\n${fileReferences(result.paths)}`;
        }
        setNotice(undefined);
        setText("");
        lastSent.current = sendPrompt(send, sentContent, ready.attachmentIds);
        clear();
        selected.clear();
    };

    useEffect(() => {
        if (!autoSend || ready.kind !== "ready") return;
        setAutoSend(false);
        void submit();
    });

    const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
        if (slash.onKeyDown(event)) return;
        const composing = event.nativeEvent.isComposing;
        if (event.key === "Enter") {
            if (!event.shiftKey && !composing && empty && (images.length > 0 || selected.files.length > 0)) {
                event.preventDefault();
                return;
            }
            const action = enterAction({ shift: event.shiftKey, composing, empty, running, queued });
            if (action === "passthrough") return;
            event.preventDefault();
            if (action === "send") void submit();
            else if (action === "release-all") send(releaseQueuedCommand("all"));
            else if (action === "abort") send(abortCommand());
        } else if (event.key === "Escape") {
            if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey
                || watch.requests.length > 0
                || document.querySelector('[role="dialog"], [role="menu"], [role="listbox"], [data-popover]') !== null) return;
            if (escapeAction({ composing, empty: empty && images.length === 0 && selected.files.length === 0, queued }) !== "release-one") return;
            event.preventDefault();
            send(releaseQueuedCommand("one"));
        } else if (event.key === "ArrowUp") {
            if (images.length > 0 || selected.files.length > 0) return;
            if (arrowUpAction({ composing, empty, held }) !== "withdraw") return;
            event.preventDefault();
            const requestId = freshRequestId("withdraw");
            withdrawing.current = requestId;
            send(withdrawQueuedCommand(requestId));
        }
    };

    const addFiles = (files: readonly File[]): void => {
        void pathsOfFiles(bridge, files).then(({ paths, refused }) => {
            if (refused || paths.length === 0) setNotice(NO_FILES);
            if (paths.length > 0) void selected.add(paths);
        });
    };

    useEffect(() => {
        const onDrop = (event: Event): void => {
            const detail = (event as CustomEvent<{ agentId: string; files: readonly File[] }>).detail;
            if (detail?.agentId === agentId) addFiles(detail.files);
        };
        window.addEventListener("vera-composer-drop", onDrop);
        return () => window.removeEventListener("vera-composer-drop", onDrop);
    });

    const stopping = running && empty;
    const placeholder = hold !== undefined
        ? hold
        : slowOpening
        ? "Opening the session"
        : !attached && watch.phase !== "attaching"
            ? "Not connected to this session"
            : running
                ? "Queue a message for when this turn ends"
                : "Reply to Vera";
    const chips = [...images.map((image) => ({
        key: image.requestId,
        label: imageLabel(image),
        name: image.name,
        attaching: imageState(image, watch.images).kind === "attaching",
    })), ...selected.files.map((path) => ({ key: path, label: path.split("/").at(-1) ?? path, name: path, attaching: false }))];

    return (
        <div className="composer-inner wide">
            <ContextChips
                folder={folder}
                branch={branch}
                chat={chat}
                missing={missing}
                move={{ onMove: move.run, disabled: move.moving }}
            />
            <ImageChips chips={chips} onRemove={(key) => { remove(key); selected.remove(key); }} />
            {missing && folder !== undefined ? (
                <div className="composer-notice-row">
                    <p className="composer-notice" data-tone="warning" role="status">{folderMissingNotice(folder)}</p>
                    <button type="button" className="composer-notice-action" disabled={move.moving} onClick={move.run}>
                        {MOVE_TO_FOLDER_LABEL}
                    </button>
                </div>
            ) : null}
            {move.problem === undefined ? null : (
                <p className="composer-notice" data-tone="danger" role="alert">{move.problem}</p>
            )}
            {notice === undefined ? null : <p className="composer-notice" role="status">{notice}</p>}
            <ComposerBox
                text={text}
                onText={setText}
                placeholder={placeholder}
                disabled={!attached || preparing || hold !== undefined}
                onKeyDown={onKeyDown}
                slash={slash.view}
                onBlur={slash.onBlur}
                inputRef={input}
                buttonMode={stopping ? "stop" : "send"}
                buttonEnabled={hold === undefined && !preparing && !selected.busy && (stopping ? attached : attached && !empty && ready.kind === "ready")}
                onPress={() => (stopping ? send(abortCommand()) : void submit())}
                onFiles={addFiles}
                onPaths={(paths) => void selected.add(paths)}
                onAttach={() => void bridge.chooseImages().then((paths) => selected.add(paths))}
                attachEnabled={attached && !preparing}
                barStart={
                    <ApprovalPill approval={watch.approval} refused={watch.approvalRefused} send={send} enabled={attached} running={running} />
                }
                barEnd={<ModelPills controls={models} />}
            />
        </div>
    );
}
