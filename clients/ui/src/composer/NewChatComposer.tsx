import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";

import { ModelPills } from "../models/ModelPills.tsx";
import { useDraftModels } from "../models/useDraftModels.ts";
import { useRouter } from "../pages/router.tsx";
import { MAX_FOLDER_CHECKS, type CreateSessionResult, type DesktopBridge } from "../protocol/bridge.ts";
import { readNotesOffer } from "../state/notesOffer.ts";
import { useViewEnvironment } from "../views/env.tsx";
import type { NewChatComposerProps } from "./Composer.tsx";
import { ComposerBox } from "./ComposerBox.tsx";
import { ContextChips } from "./ContextChips.tsx";
import { pathsOfFiles } from "./files.ts";
import { ImageChips } from "./ImageChips.tsx";
import { PageCaptureChip } from "./PageCaptureChip.tsx";
import { appendPageCaptureText, queuePageCapture, type PageCapture } from "./page-captures.ts";
import { mergeNewChatPrefill, takeNewChatPrefill, useNewChatPrefill } from "./newChatPrefill.ts";
import { IMAGE_LIMIT } from "./images.ts";
import { beginOwnerCreate, failOwnerCreate, observeCreatingDraft, setOwnerCaptureCount, transferOwner } from "./draft-capture-owner.ts";
import { agentToStart, holdFirstTurn, reconcilePick, shownAgent } from "./newAgent.ts";
import { NewAgentPill } from "./NewAgentPill.tsx";
import { publishNewChatAgents } from "./newChatAgents.ts";
import { NewApprovalPill } from "./NewApprovalPill.tsx";
import { useSlashMenu } from "./slash/useSlashMenu.ts";
import { enterAction, FOLDER_MENU_LIMIT, folderChoices, sessionTitle } from "./rules.ts";
import { useBranch } from "./useBranch.ts";
import { useFiles } from "./useFiles.ts";
import { useExistingFolders } from "./useExistingFolders.ts";
import { useNewSessionAgents } from "./useNewSessionAgents.ts";
import { addDraftImages, type DraftImage } from "./useImages.ts";

const CREATE_FAILED = "Vera could not create the session.";
const NO_FILES = "Could not attach this file.";

export function NewChatComposer({ bridge, folder: startFolder, active = true, captureOwner }: NewChatComposerProps) {
    const { connection } = useViewEnvironment();
    const { navigate } = useRouter();
    const rows = connection.sessionRows ?? [];
    const existing = useExistingFolders(bridge, active ? folderChoices(rows, MAX_FOLDER_CHECKS).map((choice) => choice.folder) : []);
    const choices = folderChoices(rows, FOLDER_MENU_LIMIT, existing);
    // With no folder picked the session is a chat.
    const [folder, setFolder] = useState<string | undefined>(startFolder);
    const [approvalMode, setApprovalMode] = useState<string | undefined>(undefined);
    // The agent picked for the new session; undefined leaves the one the host starts it on.
    const [pick, setPick] = useState<string | undefined>(undefined);
    const [text, setText] = useState("");
    const prefill = useNewChatPrefill();
    const [images, setImages] = useState<readonly DraftImage[]>([]);
    const imageRef = useRef<readonly DraftImage[]>([]);
    const [captures, setCaptures] = useState<readonly PageCapture[]>([]);
    const capturesRef = useRef<readonly PageCapture[]>([]);
    const fileCount = useRef(0);
    // A refusal or a failed create; the typed text stays in the box.
    const [problem, setProblem] = useState<string | undefined>(undefined);
    // What a slash command said; the typed text stays or clears as that command needs.
    const [notice, setNotice] = useState<string | undefined>(undefined);
    const [busy, setBusy] = useState(false);
    const empty = appendPageCaptureText(text.trim(), captures).trim().length === 0;
    const branch = useBranch(active ? bridge : undefined, folder);
    const { controls: models, draft } = useDraftModels(bridge, folder, active && connection.phase === "attached", !busy && active);
    const mounted = useRef(true);
    const stopCreatingObserver = useRef<(() => void) | undefined>(undefined);
    const addImages = useCallback((paths: readonly string[]) => {
        const next = addDraftImages(imageRef.current, paths.slice(0, Math.max(0, IMAGE_LIMIT - fileCount.current - imageRef.current.length)));
        imageRef.current = next;
        setImages(next);
    }, []);
    const { files, add: addPaths, remove: removeFile, busy: checkingFiles } = useFiles(bridge, folder, folder === undefined, images.length, addImages, setProblem);
    fileCount.current = files.length;
    const slash = useSlashMenu({
        text,
        setText,
        session: undefined,
        hostBridge: bridge,
        onNewChatExtension: (line) => void startSession(line, true),
        notify: setNotice,
    });
    const listing = useNewSessionAgents(bridge, folder, active && connection.phase === "attached");
    useEffect(() => {
        if (captureOwner === undefined) return undefined;
        return captureOwner.recipient.subscribe((capture) => {
            if (imageRef.current.length + fileCount.current < IMAGE_LIMIT && !imageRef.current.some((image) => image.path === capture.path)) {
                const next = addDraftImages(imageRef.current, [capture.path]);
                imageRef.current = next;
                setImages(next);
                capturesRef.current = [...capturesRef.current, capture];
                setCaptures(capturesRef.current);
            }
            setOwnerCaptureCount(captureOwner, capturesRef.current.length);
        });
    }, [captureOwner]);
    useEffect(() => {
        if (!active || prefill === undefined) return;
        const value = takeNewChatPrefill(prefill.id);
        if (value !== undefined) setText((draft) => mergeNewChatPrefill(draft, value));
    }, [active, prefill]);

    const choosePick = useCallback((name: string) => {
        setPick(name);
        setNotice(undefined);
    }, []);

    // The list is read again for each folder; a pick the new folder does not offer goes back to the default.
    useEffect(() => {
        if (listing === undefined) return;
        const outcome = reconcilePick(pick, listing);
        if (outcome.notice === undefined) return;
        setPick(outcome.pick);
        setNotice(outcome.notice);
    }, [listing, pick]);

    // The Choose Agent sheet and /agent sit outside this composer and read the list from here.
    useEffect(() => {
        if (!active || listing === undefined) return undefined;
        return publishNewChatAgents({ agents: listing.agents, selected: shownAgent(pick, listing), pick: choosePick });
    }, [listing, pick, choosePick, active]);

    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
            stopCreatingObserver.current?.();
            stopCreatingObserver.current = undefined;
        };
    }, []);

    async function startSession(content: string, slashCommand = false): Promise<void> {
        if (busy || checkingFiles) return;
        setNotice(undefined);
        setBusy(true);
        setProblem(undefined);
        const agent = agentToStart(pick, listing);
        const snapshot = capturesRef.current;
        let owner = captureOwner;
        const attachmentCount = imageRef.current.length + files.length;
        if (owner !== undefined) beginOwnerCreate(owner, attachmentCount);
        else stopCreatingObserver.current = observeCreatingDraft((created) => {
            owner = created;
            beginOwnerCreate(created, attachmentCount);
        });
        const result = await createSession(bridge, folder, approvalMode, readNotesOffer());
        stopCreatingObserver.current?.();
        stopCreatingObserver.current = undefined;
        if (!mounted.current) return;
        if (!result.ok) {
            if (owner !== undefined) failOwnerCreate(owner);
            setProblem(result.reason);
            setBusy(false);
            return;
        }
        if (owner !== undefined) {
            owner.recipient.created(result.agentId, queuePageCapture);
        }
        holdFirstTurn(result.agentId, agent, {
            text: appendPageCaptureText(content, snapshot),
            ...(owner === undefined ? {} : { captureRecipient: owner.recipient }),
            images: images.map((image) => image.path),
            files,
            ...(draft === undefined ? {} : { model: draft }),
            ...(slashCommand ? { slashCommand: true } : {}),
        });
        if (owner !== undefined) transferOwner(owner);
        navigate({
            kind: "session",
            agentId: result.agentId,
            title: sessionTitle(appendPageCaptureText(content, snapshot)),
            workspace: result.workspace,
            ...(folder === undefined ? { chat: true } : {}),
        });
    }

    const submit = async (): Promise<void> => {
        const content = text.trim();
        if (appendPageCaptureText(content, capturesRef.current).trim().length === 0 || busy || checkingFiles) return;
        if (content.length > 0 && slash.runLine(content)) return;
        await startSession(content);
    };

    const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
        if (slash.onKeyDown(event)) return;
        if (event.key !== "Enter") return;
        const action = enterAction({
            shift: event.shiftKey,
            composing: event.nativeEvent.isComposing,
            empty,
            running: false,
            queued: false,
        });
        if (action === "passthrough") return;
        event.preventDefault();
        if (action === "send") void submit();
    };

    const addFiles = (files: readonly File[]): void => {
        void pathsOfFiles(bridge, files).then(({ paths, refused }) => {
            if (!mounted.current) return;
            if (refused || paths.length === 0) setProblem(NO_FILES);
            if (paths.length > 0) void addPaths(paths);
        });
    };
    const capturePaths = new Set(captures.map((capture) => capture.path));
    const chips = [...images.filter((image) => !capturePaths.has(image.path)).map((image) => ({
        key: image.path,
        label: `Image ${image.number}`,
        name: image.name,
        attaching: false,
    })), ...files.map((path) => ({ key: path, label: path.split("/").at(-1) ?? path, name: path, attaching: false }))];

    return (
        <div className="composer-inner">
            <ContextChips
                folder={folder}
                branch={branch}
                picker={{
                    choices,
                    onPick: setFolder,
                    onOpen: () => {
                        void bridge.chooseFolder().then((chosen) => {
                            if (chosen !== undefined) setFolder(chosen);
                        });
                    },
                }}
            />
            <ImageChips chips={chips} onRemove={(path) => { removeFile(path); imageRef.current = imageRef.current.filter((image) => image.path !== path); setImages(imageRef.current); }} />
            {captures.length === 0 ? null : <div className="context-chips attached">
                {captures.map((capture) => {
                    const image = images.find((item) => item.path === capture.path);
                    if (image === undefined) return null;
                    return <PageCaptureChip key={capture.path} item={{ key: capture.path, number: image.number, capture, attaching: false }} onRemove={(path) => {
                        imageRef.current = imageRef.current.filter((item) => item.path !== path);
                        capturesRef.current = capturesRef.current.filter((item) => item.path !== path);
                        setImages(imageRef.current);
                        setCaptures(capturesRef.current);
                        if (captureOwner !== undefined) setOwnerCaptureCount(captureOwner, capturesRef.current.length);
                    }} />;
                })}
            </div>}
            {problem === undefined ? null : <p className="composer-notice" data-tone="danger" role="alert">{problem}</p>}
            {notice === undefined ? null : <p className="composer-notice" role="status">{notice}</p>}
            <ComposerBox
                text={text}
                onText={setText}
                placeholder="Describe a task or ask a question"
                disabled={busy}
                onKeyDown={onKeyDown}
                slash={slash.view}
                onBlur={slash.onBlur}
                buttonMode="send"
                buttonEnabled={!empty && !busy && !checkingFiles}
                onPress={() => void submit()}
                onFiles={addFiles}
                onPaths={(paths) => void addPaths(paths)}
                onAttach={() => void bridge.chooseImages().then((paths) => addPaths(paths))}
                attachEnabled={!busy}
                autoFocus={active}
                barStart={(
                    <>
                        <NewApprovalPill mode={approvalMode} onPick={setApprovalMode} disabled={busy} />
                        {listing === undefined ? null : <NewAgentPill agent={shownAgent(pick, listing)} disabled={busy} />}
                    </>
                )}
                barEnd={<ModelPills controls={models} />}
            />
        </div>
    );
}

async function createSession(
    bridge: DesktopBridge,
    folder: string | undefined,
    approvalMode: string | undefined,
    notesOffer: boolean,
): Promise<CreateSessionResult> {
    try {
        return await bridge.createSession(folder, approvalMode, notesOffer);
    } catch {
        return { ok: false, reason: CREATE_FAILED };
    }
}
