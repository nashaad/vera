import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { FileDiffMetadata } from "@pierre/diffs";

import { MAX_PATCH_FILES, type GitChangedFile, type GitFileList, type GitScope, type GitState } from "../../../../shared/git-wire.ts";
import type { ActiveSession } from "../activeSession.ts";
import { useTurnsEnded } from "../../views/useTurnsEnded.ts";
import { showToast } from "../../overlays/toasts.ts";
import {
    INITIAL_PATCH_FILES,
    MAX_CACHED_PATCH_BYTES,
    MAX_CACHED_PATCH_FILES,
    MORE_PATCH_FILES,
    needsOneFile,
    parseGitPatch,
    readGitFiles,
    treeOrderedFiles,
    readGitPatches,
    readGitState,
    readGitTexts,
    type CachedPatch,
} from "../gitChanges.ts";
import type { ChangesQuery, LoadStatus, PatchCache } from "./types.ts";

interface ChangesDataInput {
    readonly session: ActiveSession;
    readonly folder: string;
    readonly visible: boolean;
}

// The changed-file list and the patch cache. Patches load in the background, at most
// MAX_PATCH_FILES per request, and the oldest leave the cache once it is full.
export function useChangesData({ session, folder, visible }: ChangesDataInput) {
    const [scope, setScope] = useState<GitScope>("branch");
    const [destination, setDestination] = useState<string | null>(null);
    const [state, setState] = useState<GitState | undefined>();
    const [list, setList] = useState<GitFileList | undefined>();
    const [status, setStatus] = useState<LoadStatus>("idle");
    const [reason, setReason] = useState<string | undefined>();
    const [emptyText, setEmptyText] = useState<string | undefined>();
    const [selectedPath, setSelectedPath] = useState<string | null>(null);
    const [refresh, setRefresh] = useState(0);
    const [patchVersion, setPatchVersion] = useState(0);
    const [patchError, setPatchError] = useState<string | undefined>();

    const cache = useRef(new Map<string, CachedPatch>());
    const inflight = useRef(new Set<string>());
    const requested = useRef(new Set<string>());
    const generation = useRef(0);
    const listRef = useRef<GitFileList | undefined>(undefined);
    listRef.current = list;
    const query = useMemo<ChangesQuery>(() => ({
        scope,
        destination: scope === "branch" ? destination ?? state?.defaultDestination ?? null : null,
    }), [scope, destination, state]);
    const queryRef = useRef(query);
    queryRef.current = query;
    const running = session.watch.status !== "idle";
    const turnsEnded = useTurnsEnded(running);

    useEffect(() => {
        if (!visible) return undefined;
        let current = true;
        const run = ++generation.current;
        cache.current.clear();
        inflight.current.clear();
        requested.current.clear();
        setStatus("loading");
        setReason(undefined);
        setEmptyText(undefined);
        setPatchError(undefined);
        setList(undefined);
        setSelectedPath(null);
        setPatchVersion((version) => version + 1);
        const work = async (): Promise<void> => {
            const stateRead = await readGitState(session.bridge, folder);
            if (!current || run !== generation.current) return;
            if (!stateRead.ok) {
                setStatus("error");
                setReason(stateRead.reason);
                return;
            }
            const git = stateRead.value;
            setState(git);
            if (!git.repo) {
                setStatus("empty");
                setEmptyText("This folder is not a git repository.");
                return;
            }
            if (!git.hasCommits) {
                setStatus("empty");
                setEmptyText("This repository has no commits yet.");
                return;
            }
            const target = scope === "branch" ? destination ?? git.defaultDestination : null;
            if (scope === "branch" && target === null) {
                setStatus("empty");
                setEmptyText("Choose a destination branch.");
                return;
            }
            const filesRead = await readGitFiles(session.bridge, folder, scope, target);
            if (!current || run !== generation.current) return;
            if (!filesRead.ok) {
                setStatus("error");
                setReason(filesRead.reason);
                return;
            }
            const changes = filesRead.value;
            const ordered = treeOrderedFiles(changes.files);
            setList({ ...changes, files: ordered });
            if (changes.noMergeBase) {
                setStatus("empty");
                setEmptyText("These branches have no merge base.");
                return;
            }
            if (changes.total === 0) {
                setStatus("empty");
                setEmptyText(scope === "branch" ? "No changes against this destination." : "No uncommitted changes.");
                return;
            }
            setSelectedPath((currentPath) => ordered.some((file) => file.path === currentPath)
                ? currentPath
                : ordered[0]?.path ?? null);
            setStatus("ready");
        };
        void work();
        return () => {
            current = false;
        };
    }, [session.bridge, folder, scope, destination, visible, turnsEnded, refresh]);

    const trimCache = useCallback(() => {
        let bytes = 0;
        for (const entry of cache.current.values()) bytes += entry.bytes;
        for (const [path, entry] of [...cache.current.entries()]) {
            if (cache.current.size <= MAX_CACHED_PATCH_FILES && bytes <= MAX_CACHED_PATCH_BYTES) break;
            cache.current.delete(path);
            bytes -= entry.bytes;
        }
    }, []);

    const ensurePatches = useCallback(async (files: readonly GitChangedFile[], force = false): Promise<void> => {
        const targets: GitChangedFile[] = [];
        for (const file of files) {
            if (cache.current.has(file.path) || inflight.current.has(file.path)) continue;
            if (!force && requested.current.has(file.path)) continue;
            targets.push(file);
            requested.current.add(file.path);
            if (targets.length >= MAX_PATCH_FILES) break;
        }
        if (targets.length === 0) return;
        const run = generation.current;
        const asked = queryRef.current;
        for (const file of targets) inflight.current.add(file.path);
        const reply = await readGitPatches(session.bridge, folder, asked.scope, asked.destination, targets);
        for (const file of targets) inflight.current.delete(file.path);
        if (run !== generation.current) return;
        if (!reply.ok) {
            setPatchError(reply.reason);
            return;
        }
        const base = listRef.current?.base ?? "";
        const byPath = new Map(reply.value.map((patch) => [patch.path, patch]));
        let added = false;
        for (const file of targets) {
            const patch = byPath.get(file.path);
            if (patch === undefined) continue;
            const parsed = parseGitPatch(patch, asked.scope, base, file.path, file.prevPath);
            if (parsed === undefined) continue;
            cache.current.set(file.path, parsed);
            added = true;
        }
        if (added) {
            trimCache();
            setPatchVersion((version) => version + 1);
        }
    }, [session.bridge, folder, trimCache]);

    const firstFiles = useMemo(() => list?.files.slice(0, INITIAL_PATCH_FILES) ?? [], [list]);
    useEffect(() => {
        if (status !== "ready") return;
        void ensurePatches(firstFiles);
    }, [status, firstFiles, ensurePatches]);

    const oneFileMode = list !== undefined && needsOneFile(list);
    const currentIndex = list === undefined || selectedPath === null
        ? -1
        : list.files.findIndex((file) => file.path === selectedPath);
    const currentFile = currentIndex < 0 ? undefined : list?.files[currentIndex];

    useEffect(() => {
        if (!oneFileMode || status !== "ready" || currentFile === undefined) return;
        void ensurePatches([currentFile]);
    }, [oneFileMode, status, currentFile, ensurePatches]);

    const filesByPath = useMemo(() => new Map((list?.files ?? []).map((file) => [file.path, file])), [list]);

    const remaining = list === undefined
        ? 0
        : list.files.reduce((count, file) => count + (requested.current.has(file.path) ? 0 : 1), 0);

    const showMorePatches = useCallback((): void => {
        const files = listRef.current?.files ?? [];
        const next = files.filter((file) => !requested.current.has(file.path)).slice(0, MORE_PATCH_FILES);
        void ensurePatches(next);
    }, [ensurePatches]);

    const loadDiffFiles = async (fileDiff: FileDiffMetadata) => {
        const file = filesByPath.get(fileDiff.name);
        if (file === undefined) throw new Error("Unknown file.");
        const asked = queryRef.current;
        const reply = await readGitTexts(session.bridge, folder, asked.scope, asked.destination, file);
        if (reply.kind !== "texts" || !reply.ok) throw new Error(reply.ok ? "Could not read the changes." : reply.reason);
        if (reply.texts.oldTooLarge || reply.texts.newTooLarge) {
            showToast("This file is too large to expand.", "warning");
            throw new Error("This file is too large to expand.");
        }
        const oldSide = reply.texts.old ?? { name: file.path, contents: "", cacheKey: `git:empty:${file.path}` };
        const newSide = reply.texts.new ?? { name: file.path, contents: "", cacheKey: `git:empty:${file.path}` };
        return {
            oldFile: { name: oldSide.name, contents: oldSide.contents, cacheKey: oldSide.cacheKey },
            newFile: { name: newSide.name, contents: newSide.contents, cacheKey: newSide.cacheKey },
        };
    };

    return {
        scope,
        setScope: setScope as Dispatch<SetStateAction<GitScope>>,
        destination,
        setDestination: setDestination as Dispatch<SetStateAction<string | null>>,
        query,
        state,
        list,
        status,
        reason,
        emptyText,
        selectedPath,
        setSelectedPath,
        refresh,
        setRefresh,
        patchVersion,
        patchError,
        cache: cache as PatchCache,
        ensurePatches,
        showMorePatches,
        remaining,
        filesByPath,
        loadDiffFiles,
        oneFileMode,
        currentIndex,
        currentFile,
    };
}
