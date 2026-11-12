import { useEffect, useRef, useState, type KeyboardEvent } from "react";

import { ModelPills } from "../models/ModelPills.tsx";
import { useDraftModels } from "../models/useDraftModels.ts";
import { useRouter } from "../pages/router.tsx";
import { MAX_FOLDER_CHECKS, type CreateSessionResult, type DesktopBridge } from "../protocol/bridge.ts";
import { setPendingPrompt } from "../session/pendingPrompt.ts";
import { useViewEnvironment } from "../views/env.tsx";
import type { NewChatComposerProps } from "./Composer.tsx";
import { ComposerBox } from "./ComposerBox.tsx";
import { ContextChips } from "./ContextChips.tsx";
import { imagePathsOf } from "./files.ts";
import { ImageChips } from "./ImageChips.tsx";
import { NewApprovalPill } from "./NewApprovalPill.tsx";
import { useSlashMenu } from "./slash/useSlashMenu.ts";
import { enterAction, FOLDER_MENU_LIMIT, folderChoices, sessionTitle } from "./rules.ts";
import { useBranch } from "./useBranch.ts";
import { useExistingFolders } from "./useExistingFolders.ts";
import { addDraftImages, type DraftImage } from "./useImages.ts";

const CREATE_FAILED = "Vera could not create the session.";
const NOT_IMAGES = "Only image files can be attached.";

export function NewChatComposer({ bridge, folder: startFolder }: NewChatComposerProps) {
    const { connection } = useViewEnvironment();
    const { navigate } = useRouter();
    const rows = connection.sessionRows ?? [];
    const existing = useExistingFolders(bridge, folderChoices(rows, MAX_FOLDER_CHECKS).map((choice) => choice.folder));
    const choices = folderChoices(rows, FOLDER_MENU_LIMIT, existing);
    // With no folder picked the session is a chat.
    const [folder, setFolder] = useState<string | undefined>(startFolder);
    const [approvalMode, setApprovalMode] = useState<string | undefined>(undefined);
    const [text, setText] = useState("");
    const [images, setImages] = useState<readonly DraftImage[]>([]);
    // A refusal or a failed create; the typed text stays in the box.
    const [problem, setProblem] = useState<string | undefined>(undefined);
    // What a slash command said; the typed text stays or clears as that command needs.
    const [notice, setNotice] = useState<string | undefined>(undefined);
    const [busy, setBusy] = useState(false);
    const empty = text.trim().length === 0;
    const branch = useBranch(bridge, folder);
    const { controls: models, draft } = useDraftModels(bridge, folder, connection.phase === "attached", !busy);
    const mounted = useRef(true);
    const slash = useSlashMenu({ text, setText, session: undefined, notify: setNotice });

    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
        };
    }, []);

    const submit = async (): Promise<void> => {
        const content = text.trim();
        if (content.length === 0 || busy) return;
        if (slash.runLine(content)) return;
        setNotice(undefined);
        setBusy(true);
        setProblem(undefined);
        const result = await createSession(bridge, folder, approvalMode);
        if (!mounted.current) return;
        if (!result.ok) {
            setProblem(result.reason);
            setBusy(false);
            return;
        }
        setPendingPrompt(result.agentId, {
            text: content,
            images: images.map((image) => image.path),
            ...(draft === undefined ? {} : { model: draft }),
        });
        navigate({
            kind: "session",
            agentId: result.agentId,
            title: sessionTitle(content),
            ...(folder === undefined ? { chat: true } : { workspace: result.workspace }),
        });
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

    const addPaths = (paths: readonly string[]): void => setImages((current) => addDraftImages(current, paths));
    const addFiles = (files: readonly File[]): void => {
        void imagePathsOf(bridge, files).then((paths) => {
            if (!mounted.current) return;
            if (paths.length === 0) setProblem(NOT_IMAGES);
            else addPaths(paths);
        });
    };
    const chips = images.map((image) => ({
        key: image.path,
        label: `Image ${image.number}`,
        name: image.name,
        attaching: false,
    }));

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
            <ImageChips chips={chips} onRemove={(path) => setImages((current) => current.filter((image) => image.path !== path))} />
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
                buttonEnabled={!empty && !busy}
                onPress={() => void submit()}
                onFiles={addFiles}
                onPaths={addPaths}
                onAttach={() => void bridge.chooseImages().then(addPaths)}
                attachEnabled={!busy}
                barStart={<NewApprovalPill mode={approvalMode} onPick={setApprovalMode} disabled={busy} />}
                barEnd={<ModelPills controls={models} />}
            />
        </div>
    );
}

async function createSession(
    bridge: DesktopBridge,
    folder: string | undefined,
    approvalMode: string | undefined,
): Promise<CreateSessionResult> {
    try {
        return await bridge.createSession(folder, approvalMode);
    } catch {
        return { ok: false, reason: CREATE_FAILED };
    }
}
