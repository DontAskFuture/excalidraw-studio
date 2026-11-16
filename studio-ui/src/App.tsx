import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CaptureUpdateAction,
  Excalidraw,
  MainMenu,
  THEME,
  getCommonBounds,
  getNonDeletedElements,
  getSceneVersion,
  loadFromBlob,
  restoreAppState,
  restoreElements,
} from "@excalidraw/excalidraw";
import { cleanAppStateForExport } from "@excalidraw/excalidraw/appState";

import type {
  ExcalidrawElement,
  OrderedExcalidrawElement,
  Theme,
} from "@excalidraw/element/types";
import type {
  AppState,
  BinaryFiles,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";

import {
  api,
  type ProjectSummary,
  type SceneMeta,
} from "./api";
import {
  excalidrawToMermaid,
  excalidrawToPlantUml,
  mermaidToExcalidraw,
  plantUmlToExcalidraw,
  type SyncFormat,
} from "./diagramSync";

type SaveState = "saved" | "unsaved" | "saving" | "error";
type CodeSyncState = "synced" | "syncing" | "edited" | "error";

interface ActiveTarget {
  project: string;
  scene: string;
}

interface PendingSnapshot {
  project: string;
  scene: string;
  sig: string;
  elements: readonly OrderedExcalidrawElement[];
  appState: AppState;
  files: BinaryFiles;
  codeSnapshot?: {
    mermaid: string;
    plantuml: string;
  };
}

const AUTOSAVE_DEBOUNCE_MS = 600;
const CODE_TO_CANVAS_DEBOUNCE_MS = 450;
const CANVAS_TO_CODE_DEBOUNCE_MS = 280;

function computeSignature(
  elements: readonly ExcalidrawElement[],
  appState: Partial<AppState>,
): string {
  const version = getSceneVersion(elements);
  return [
    version,
    appState.viewBackgroundColor ?? "#ffffff",
    appState.gridModeEnabled ? "1" : "0",
    appState.gridSize ?? "",
    appState.gridStep ?? "",
  ].join("|");
}

function buildPersistableAppState(appState: AppState): Record<string, any> {
  return {
    ...cleanAppStateForExport(appState),
    scrollX: appState.scrollX,
    scrollY: appState.scrollY,
    zoom: appState.zoom,
  };
}

function collectUsedAssetIds(
  elements: readonly ExcalidrawElement[],
): string[] {
  const ids = new Set<string>();
  for (const el of elements) {
    if (!el.isDeleted && "fileId" in el && el.fileId) {
      ids.add(el.fileId);
    }
  }
  return Array.from(ids);
}

function readUrlTarget(): { project: string | null; scene: string | null } {
  const params = new URLSearchParams(window.location.search);
  return {
    project: params.get("project"),
    scene: params.get("scene"),
  };
}

function writeUrlTarget(project: string, scene: string) {
  const url = `/?project=${encodeURIComponent(project)}&scene=${encodeURIComponent(scene)}`;
  window.history.replaceState(null, "", url);
}

export default function App() {
  const [excalidrawAPI, setExcalidrawAPI] =
    useState<ExcalidrawImperativeAPI | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(
    () => new Set(),
  );
  const [activeTarget, setActiveTarget] = useState<ActiveTarget | null>(null);
  const [dataDir, setDataDir] = useState<string>("");
  const [defaultDataDir, setDefaultDataDir] = useState<string>("");
  const [isCustomDataDir, setIsCustomDataDir] = useState(false);
  const [showStorageModal, setShowStorageModal] = useState(false);
  const [copiedPath, setCopiedPath] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [codePanelOpen, setCodePanelOpen] = useState(false);
  const [activeCodeFormat, setActiveCodeFormat] =
    useState<SyncFormat>("mermaid");
  const [autoCodeSync, setAutoCodeSync] = useState(true);
  const [mermaidCode, setMermaidCode] = useState("");
  const [plantumlCode, setPlantumlCode] = useState("");
  const [codeSyncState, setCodeSyncState] = useState<CodeSyncState>("synced");
  const [codeError, setCodeError] = useState<string | null>(null);
  const [copiedCode, setCopiedCode] = useState(false);
  const [codePaths, setCodePaths] = useState<{
    mmd_path: string;
    puml_path: string;
  } | null>(null);
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = window.localStorage.getItem("studio-theme");
    return saved === THEME.DARK ? THEME.DARK : THEME.LIGHT;
  });

  // Refs for race-free debouncing, lifecycle flush, and loop prevention
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  apiRef.current = excalidrawAPI;

  const activeTargetRef = useRef<ActiveTarget | null>(null);
  activeTargetRef.current = activeTarget;

  const lastSavedSigRef = useRef<string>("");
  const pendingRef = useRef<PendingSnapshot | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const copyTimerRef = useRef<number | null>(null);
  const codeToCanvasTimerRef = useRef<number | null>(null);
  const canvasToCodeTimerRef = useRef<number | null>(null);
  const codeCopyTimerRef = useRef<number | null>(null);
  const uploadedAssetsByProjectRef = useRef<Map<string, Set<string>>>(
    new Map(),
  );
  const loadingSceneRef = useRef(false);
  const applyingCodeToCanvasRef = useRef(false);
  const mermaidCodeRef = useRef("");
  mermaidCodeRef.current = mermaidCode;
  const plantumlCodeRef = useRef("");
  plantumlCodeRef.current = plantumlCode;
  const autoCodeSyncRef = useRef(true);
  autoCodeSyncRef.current = autoCodeSync;
  const codeSyncTokenRef = useRef(0);
  const importTargetProjectRef = useRef<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const toggleTheme = useCallback(() => {
    setTheme((prev) => {
      const next = prev === THEME.DARK ? THEME.LIGHT : THEME.DARK;
      window.localStorage.setItem("studio-theme", next);
      return next;
    });
  }, []);

  const refreshProjects = useCallback(async () => {
    const res = await api.listProjects();
    if (res.data_dir) {
      setDataDir(res.data_dir);
    }
    if (res.default_data_dir) {
      setDefaultDataDir(res.default_data_dir);
    }
    setIsCustomDataDir(Boolean(res.is_custom_data_dir));
    setProjects(res.projects);
    return res.projects;
  }, []);

  const openCodePanel = useCallback(
    (format: SyncFormat) => {
      if (codePanelOpen && activeCodeFormat === format) {
        setCodePanelOpen(false);
      } else {
        setActiveCodeFormat(format);
        setCodePanelOpen(true);
      }
    },
    [activeCodeFormat, codePanelOpen],
  );

  const clearTimers = useCallback(() => {
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    if (codeToCanvasTimerRef.current !== null) {
      window.clearTimeout(codeToCanvasTimerRef.current);
      codeToCanvasTimerRef.current = null;
    }
    if (canvasToCodeTimerRef.current !== null) {
      window.clearTimeout(canvasToCodeTimerRef.current);
      canvasToCodeTimerRef.current = null;
    }
  }, []);

  const syncCodeFromElements = useCallback(
    (elements: readonly ExcalidrawElement[]) => {
      const mmd = excalidrawToMermaid(elements);
      const puml = excalidrawToPlantUml(elements);
      mermaidCodeRef.current = mmd;
      plantumlCodeRef.current = puml;
      setMermaidCode(mmd);
      setPlantumlCode(puml);
      setCodeError(null);
      setCodeSyncState("synced");
      return { mmd, puml };
    },
    [],
  );

  const flushPendingSave = useCallback(
    async (keepalive = false) => {
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      const snap = pendingRef.current;
      if (!snap) {
        return;
      }
      pendingRef.current = null;

      if (!keepalive) {
        setSaveState("saving");
        setSaveError(null);
      }

      try {
        const assetIds = collectUsedAssetIds(snap.elements);
        let uploadedSet = uploadedAssetsByProjectRef.current.get(snap.project);
        if (!uploadedSet) {
          uploadedSet = new Set<string>();
          uploadedAssetsByProjectRef.current.set(snap.project, uploadedSet);
        }

        if (!keepalive) {
          for (const assetId of assetIds) {
            const fileData = snap.files[assetId];
            if (fileData && !uploadedSet.has(assetId)) {
              await api.uploadAsset(snap.project, assetId, fileData);
              uploadedSet.add(assetId);
            }
          }
        }

        const mermaid =
          snap.codeSnapshot?.mermaid ?? excalidrawToMermaid(snap.elements);
        const plantuml =
          snap.codeSnapshot?.plantuml ?? excalidrawToPlantUml(snap.elements);

        const res = await api.saveScene(
          snap.project,
          snap.scene,
          {
            elements: snap.elements,
            appState: buildPersistableAppState(snap.appState),
            asset_ids: assetIds,
            mermaid,
            plantuml,
          },
          keepalive,
        );

        lastSavedSigRef.current = snap.sig;
        if (!keepalive) {
          setSaveState("saved");
          setProjects((prev) =>
            prev.map((p) =>
              p.slug !== snap.project
                ? p
                : {
                    ...p,
                    updated_at: res.updated_at,
                    scenes: p.scenes.map((sc) =>
                      sc.slug === snap.scene
                        ? { ...sc, updated_at: res.updated_at }
                        : sc,
                    ),
                  },
            ),
          );
        }
      } catch (err: any) {
        if (!keepalive) {
          pendingRef.current = snap;
          setSaveState("error");
          setSaveError(err?.message || "Failed to save");
        }
      }
    },
    [],
  );

  const applyCodeToCanvas = useCallback(
    async (format: SyncFormat, rawCode: string) => {
      const exApi = apiRef.current;
      const current = activeTargetRef.current;
      if (!exApi || !current) {
        return;
      }

      if (codeToCanvasTimerRef.current !== null) {
        window.clearTimeout(codeToCanvasTimerRef.current);
        codeToCanvasTimerRef.current = null;
      }
      if (canvasToCodeTimerRef.current !== null) {
        window.clearTimeout(canvasToCodeTimerRef.current);
        canvasToCodeTimerRef.current = null;
      }

      const token = ++codeSyncTokenRef.current;
      setCodeSyncState("syncing");

      try {
        const existingElements = exApi.getSceneElements();
        const wasEmpty = getNonDeletedElements(existingElements).length === 0;

        let convertedElements: any[];
        if (format === "mermaid") {
          convertedElements = await mermaidToExcalidraw(
            rawCode,
            existingElements,
          );
        } else {
          const res = await plantUmlToExcalidraw(rawCode, existingElements);
          convertedElements = res.elements;
        }

        if (
          token !== codeSyncTokenRef.current ||
          activeTargetRef.current?.project !== current.project ||
          activeTargetRef.current?.scene !== current.scene
        ) {
          return;
        }

        const restoredNext = restoreElements(convertedElements, null, {
          repairBindings: true,
          deleteInvisibleElements: true,
        });

        let nextMmd: string;
        let nextPuml: string;
        if (format === "mermaid") {
          nextMmd = rawCode;
          nextPuml = excalidrawToPlantUml(restoredNext);
          plantumlCodeRef.current = nextPuml;
          setPlantumlCode(nextPuml);
        } else {
          nextPuml = rawCode;
          nextMmd = excalidrawToMermaid(restoredNext);
          mermaidCodeRef.current = nextMmd;
          setMermaidCode(nextMmd);
        }

        applyingCodeToCanvasRef.current = true;
        try {
          exApi.updateScene({
            elements: restoredNext,
            captureUpdate: CaptureUpdateAction.IMMEDIATELY,
          });
          if (wasEmpty) {
            const visible = getNonDeletedElements(restoredNext);
            if (visible.length > 0) {
              exApi.setViewport({
                target: getCommonBounds(visible),
                fit: "scale-down",
                animation: false,
                offsets: { ui: true },
              });
            }
          }
        } finally {
          window.setTimeout(() => {
            applyingCodeToCanvasRef.current = false;
          }, 60);
        }

        setCodeError(null);
        setCodeSyncState("synced");

        const appState = exApi.getAppState();
        pendingRef.current = {
          project: current.project,
          scene: current.scene,
          sig: computeSignature(restoredNext, appState),
          elements: restoredNext,
          appState,
          files: exApi.getFiles(),
          codeSnapshot: { mermaid: nextMmd, plantuml: nextPuml },
        };
        await flushPendingSave(false);
      } catch (err: any) {
        if (token === codeSyncTokenRef.current) {
          setCodeError(err?.message || "Failed to parse diagram syntax");
          setCodeSyncState("error");
        }
      }
    },
    [flushPendingSave],
  );

  const handleCodeEditorChange = useCallback(
    (format: SyncFormat, nextText: string) => {
      if (format === "mermaid") {
        mermaidCodeRef.current = nextText;
        setMermaidCode(nextText);
      } else {
        plantumlCodeRef.current = nextText;
        setPlantumlCode(nextText);
      }

      if (codeToCanvasTimerRef.current !== null) {
        window.clearTimeout(codeToCanvasTimerRef.current);
        codeToCanvasTimerRef.current = null;
      }
      if (canvasToCodeTimerRef.current !== null) {
        window.clearTimeout(canvasToCodeTimerRef.current);
        canvasToCodeTimerRef.current = null;
      }

      if (autoCodeSyncRef.current) {
        setCodeSyncState("syncing");
        codeToCanvasTimerRef.current = window.setTimeout(() => {
          codeToCanvasTimerRef.current = null;
          void applyCodeToCanvas(format, nextText);
        }, CODE_TO_CANVAS_DEBOUNCE_MS);
      } else {
        setCodeSyncState("edited");
      }
    },
    [applyCodeToCanvas],
  );

  const handlePullFromCanvas = useCallback(() => {
    const exApi = apiRef.current;
    const current = activeTargetRef.current;
    if (!exApi || !current) {
      return;
    }
    if (codeToCanvasTimerRef.current !== null) {
      window.clearTimeout(codeToCanvasTimerRef.current);
      codeToCanvasTimerRef.current = null;
    }
    if (canvasToCodeTimerRef.current !== null) {
      window.clearTimeout(canvasToCodeTimerRef.current);
      canvasToCodeTimerRef.current = null;
    }
    codeSyncTokenRef.current++;

    const elements = exApi.getSceneElements();
    const { mmd, puml } = syncCodeFromElements(elements);
    const appState = exApi.getAppState();
    pendingRef.current = {
      project: current.project,
      scene: current.scene,
      sig: computeSignature(elements, appState),
      elements,
      appState,
      files: exApi.getFiles(),
      codeSnapshot: { mermaid: mmd, plantuml: puml },
    };
    void flushPendingSave(false);
  }, [flushPendingSave, syncCodeFromElements]);

  const handleCopyCode = useCallback(async () => {
    const text =
      activeCodeFormat === "mermaid"
        ? mermaidCodeRef.current
        : plantumlCodeRef.current;
    if (!text) {
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      setCopiedCode(true);
      if (codeCopyTimerRef.current !== null) {
        window.clearTimeout(codeCopyTimerRef.current);
      }
      codeCopyTimerRef.current = window.setTimeout(() => {
        setCopiedCode(false);
      }, 1800);
    } catch {
      // ignore clipboard errors when blocked
    }
  }, [activeCodeFormat]);

  const openScene = useCallback(
    async (projectSlug: string, sceneSlug: string) => {
      const exApi = apiRef.current;
      if (!exApi) {
        return;
      }

      await flushPendingSave(false);
      clearTimers();
      codeSyncTokenRef.current++;

      loadingSceneRef.current = true;
      try {
        const [doc, codeDoc] = await Promise.all([
          api.getScene(projectSlug, sceneSlug),
          api.getSceneCode(projectSlug, sceneSlug).catch(() => null),
        ]);
        setCodePaths(
          codeDoc
            ? { mmd_path: codeDoc.mmd_path, puml_path: codeDoc.puml_path }
            : null,
        );

        let restoredElements = restoreElements(doc.elements || [], null, {
          repairBindings: true,
          deleteInvisibleElements: true,
        });
        let needsCompanionSyncSave = !codeDoc?.mermaid || !codeDoc?.plantuml;

        if (codeDoc?.external_change === "mermaid" && codeDoc.mermaid?.trim()) {
          setActiveCodeFormat("mermaid");
          try {
            const converted = await mermaidToExcalidraw(
              codeDoc.mermaid,
              restoredElements,
            );
            restoredElements = restoreElements(converted, null, {
              repairBindings: true,
              deleteInvisibleElements: true,
            });
            const derivedPuml = excalidrawToPlantUml(restoredElements);
            mermaidCodeRef.current = codeDoc.mermaid;
            plantumlCodeRef.current = derivedPuml;
            setMermaidCode(codeDoc.mermaid);
            setPlantumlCode(derivedPuml);
            setCodeError(null);
            setCodeSyncState("synced");
            needsCompanionSyncSave = true;
          } catch (err: any) {
            const fallback = syncCodeFromElements(restoredElements);
            mermaidCodeRef.current = codeDoc.mermaid;
            plantumlCodeRef.current = fallback.puml;
            setMermaidCode(codeDoc.mermaid);
            setCodeError(
              `External .mmd parse error: ${err?.message || "Invalid syntax"}`,
            );
            setCodeSyncState("error");
            setCodePanelOpen(true);
            needsCompanionSyncSave = false;
          }
        } else if (
          codeDoc?.external_change === "plantuml" &&
          codeDoc.plantuml?.trim()
        ) {
          setActiveCodeFormat("plantuml");
          try {
            const converted = await plantUmlToExcalidraw(
              codeDoc.plantuml,
              restoredElements,
            );
            restoredElements = restoreElements(converted.elements, null, {
              repairBindings: true,
              deleteInvisibleElements: true,
            });
            const derivedMmd = excalidrawToMermaid(restoredElements);
            plantumlCodeRef.current = codeDoc.plantuml;
            mermaidCodeRef.current = derivedMmd;
            setPlantumlCode(codeDoc.plantuml);
            setMermaidCode(derivedMmd);
            setCodeError(null);
            setCodeSyncState("synced");
            needsCompanionSyncSave = true;
          } catch (err: any) {
            const fallback = syncCodeFromElements(restoredElements);
            plantumlCodeRef.current = codeDoc.plantuml;
            mermaidCodeRef.current = fallback.mmd;
            setPlantumlCode(codeDoc.plantuml);
            setCodeError(
              `External .puml parse error: ${err?.message || "Invalid syntax"}`,
            );
            setCodeSyncState("error");
            setCodePanelOpen(true);
            needsCompanionSyncSave = false;
          }
        } else {
          syncCodeFromElements(restoredElements);
        }

        const hasSavedViewport =
          doc.appState && typeof doc.appState.scrollX === "number";
        const restoredAppState = restoreAppState(
          doc.appState || {},
          exApi.getAppState(),
        );

        let uploadedSet = uploadedAssetsByProjectRef.current.get(projectSlug);
        if (!uploadedSet) {
          uploadedSet = new Set<string>();
          uploadedAssetsByProjectRef.current.set(projectSlug, uploadedSet);
        }
        for (const fileId of Object.keys(doc.files || {})) {
          uploadedSet.add(fileId);
        }

        lastSavedSigRef.current = computeSignature(
          restoredElements,
          restoredAppState,
        );
        pendingRef.current = null;

        exApi.updateScene({
          elements: restoredElements,
          appState: restoredAppState,
          captureUpdate: CaptureUpdateAction.IMMEDIATELY,
        });

        const filesArray = Object.values(doc.files || {});
        if (filesArray.length > 0) {
          exApi.addFiles(filesArray as any);
        }

        exApi.history.clear();

        if (!hasSavedViewport) {
          const visible = getNonDeletedElements(restoredElements);
          if (visible.length > 0) {
            exApi.setViewport({
              target: getCommonBounds(visible),
              fit: "scale-down",
              animation: false,
              offsets: { ui: true },
            });
          }
        }

        setActiveTarget({ project: projectSlug, scene: sceneSlug });
        setExpandedProjects((prev) => new Set(prev).add(projectSlug));
        setSaveState("saved");
        setSaveError(null);
        writeUrlTarget(projectSlug, sceneSlug);

        if (needsCompanionSyncSave) {
          void api
            .saveScene(projectSlug, sceneSlug, {
              elements: restoredElements,
              appState: buildPersistableAppState(restoredAppState as AppState),
              asset_ids: collectUsedAssetIds(restoredElements),
              mermaid: mermaidCodeRef.current,
              plantuml: plantumlCodeRef.current,
            })
            .catch(() => {
              // keep UI responsive even if initial companion sync fails
            });
        }
      } catch (err: any) {
        setSaveState("error");
        setSaveError(err?.message || "Failed to load diagram");
      } finally {
        window.setTimeout(() => {
          loadingSceneRef.current = false;
        }, 50);
      }
    },
    [clearTimers, flushPendingSave, syncCodeFromElements],
  );

  // Initial bootstrap once excalidrawAPI is ready
  useEffect(() => {
    if (!excalidrawAPI) {
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const loadedProjects = await refreshProjects();
        if (cancelled || loadedProjects.length === 0) {
          return;
        }

        const urlTarget = readUrlTarget();
        let chosenProject = loadedProjects.find(
          (p) => p.slug === urlTarget.project,
        );
        if (!chosenProject) {
          chosenProject = loadedProjects[0];
        }

        let chosenScene = chosenProject.scenes.find(
          (s) => s.slug === urlTarget.scene,
        );
        if (!chosenScene) {
          chosenScene = chosenProject.scenes[0];
        }

        if (!chosenScene) {
          chosenScene = await api.createScene(chosenProject.slug, {
            name: "Untitled Diagram",
            elements: [],
            appState: {},
          });
          await refreshProjects();
        }

        if (!cancelled) {
          await openScene(chosenProject.slug, chosenScene.slug);
        }
      } catch (err: any) {
        if (!cancelled) {
          setSaveState("error");
          setSaveError(err?.message || "Failed to initialize workspace");
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [excalidrawAPI, openScene, refreshProjects]);

  // Lifecycle flush on tab hide / close & toolbar code-sync events
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.hidden) {
        void flushPendingSave(true);
      }
    };
    const onPageHide = () => {
      void flushPendingSave(true);
    };
    const onOpenCodeSync = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      const fmt: SyncFormat = detail === "plantuml" ? "plantuml" : "mermaid";
      setActiveCodeFormat(fmt);
      setCodePanelOpen(true);
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("studio:open-code-sync", onOpenCodeSync);

    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("studio:open-code-sync", onOpenCodeSync);
    };
  }, [flushPendingSave]);

  const handleCanvasChange = useCallback(
    (
      elements: readonly OrderedExcalidrawElement[],
      appState: AppState,
      files: BinaryFiles,
    ) => {
      if (loadingSceneRef.current || applyingCodeToCanvasRef.current) {
        return;
      }
      const current = activeTargetRef.current;
      if (!current) {
        return;
      }

      const sig = computeSignature(elements, appState);
      if (sig === lastSavedSigRef.current && !pendingRef.current) {
        return;
      }
      if (pendingRef.current && pendingRef.current.sig === sig) {
        return;
      }

      pendingRef.current = {
        project: current.project,
        scene: current.scene,
        sig,
        elements,
        appState,
        files,
      };
      setSaveState("unsaved");

      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
      }
      saveTimerRef.current = window.setTimeout(() => {
        void flushPendingSave(false);
      }, AUTOSAVE_DEBOUNCE_MS);

      if (autoCodeSyncRef.current) {
        if (canvasToCodeTimerRef.current !== null) {
          window.clearTimeout(canvasToCodeTimerRef.current);
        }
        canvasToCodeTimerRef.current = window.setTimeout(() => {
          canvasToCodeTimerRef.current = null;
          if (!loadingSceneRef.current && !applyingCodeToCanvasRef.current) {
            syncCodeFromElements(elements);
          }
        }, CANVAS_TO_CODE_DEBOUNCE_MS);
      }
    },
    [flushPendingSave, syncCodeFromElements],
  );

  // Project & Diagram CRUD actions
  const handleCreateProject = async () => {
    const name = window.prompt("New project name:", "New Project");
    if (!name || !name.trim()) {
      return;
    }
    const created = await api.createProject(name.trim());
    const scene = await api.createScene(created.slug, {
      name: "Diagram 1",
      elements: [],
      appState: {},
    });
    await refreshProjects();
    await openScene(created.slug, scene.slug);
  };

  const handleRenameProject = async (project: ProjectSummary) => {
    const name = window.prompt("Rename project:", project.name);
    if (!name || !name.trim() || name.trim() === project.name) {
      return;
    }
    await api.renameProject(project.slug, name.trim());
    await refreshProjects();
  };

  const handleDeleteProject = async (project: ProjectSummary) => {
    if (
      !window.confirm(
        `Delete project "${project.name}" and all ${project.scenes.length} diagram(s) inside it?`,
      )
    ) {
      return;
    }
    await api.deleteProject(project.slug);
    const remaining = await refreshProjects();
    if (activeTarget?.project === project.slug) {
      pendingRef.current = null;
      const nextProj = remaining[0];
      if (nextProj) {
        let nextScene = nextProj.scenes[0];
        if (!nextScene) {
          nextScene = await api.createScene(nextProj.slug, {
            name: "Untitled Diagram",
            elements: [],
            appState: {},
          });
          await refreshProjects();
        }
        await openScene(nextProj.slug, nextScene.slug);
      }
    }
  };

  const handleCreateScene = async (projectSlug: string) => {
    const name = window.prompt("New diagram name:", "New Diagram");
    if (!name || !name.trim()) {
      return;
    }
    const scene = await api.createScene(projectSlug, {
      name: name.trim(),
      elements: [],
      appState: {},
    });
    await refreshProjects();
    await openScene(projectSlug, scene.slug);
  };

  const handleRenameScene = async (projectSlug: string, scene: SceneMeta) => {
    const name = window.prompt("Rename diagram:", scene.name);
    if (!name || !name.trim() || name.trim() === scene.name) {
      return;
    }
    await api.updateSceneMeta(projectSlug, scene.slug, { name: name.trim() });
    await refreshProjects();
  };

  const handleMoveScene = async (
    projectSlug: string,
    scene: SceneMeta,
    targetProjectSlug: string,
  ) => {
    if (!targetProjectSlug || targetProjectSlug === projectSlug) {
      return;
    }
    if (
      activeTarget?.project === projectSlug &&
      activeTarget?.scene === scene.slug
    ) {
      await flushPendingSave(false);
    }
    const res = await api.updateSceneMeta(projectSlug, scene.slug, {
      target_project: targetProjectSlug,
    });
    await refreshProjects();
    if (
      activeTarget?.project === projectSlug &&
      activeTarget?.scene === scene.slug
    ) {
      await openScene(res.project, res.scene.slug);
    }
  };

  const handleDeleteScene = async (projectSlug: string, scene: SceneMeta) => {
    if (!window.confirm(`Delete diagram "${scene.name}"?`)) {
      return;
    }
    await api.deleteScene(projectSlug, scene.slug);
    const updated = await refreshProjects();
    if (
      activeTarget?.project === projectSlug &&
      activeTarget?.scene === scene.slug
    ) {
      pendingRef.current = null;
      const proj = updated.find((p) => p.slug === projectSlug) || updated[0];
      if (proj) {
        let nextScene = proj.scenes[0];
        if (!nextScene) {
          nextScene = await api.createScene(proj.slug, {
            name: "Untitled Diagram",
            elements: [],
            appState: {},
          });
          await refreshProjects();
        }
        await openScene(proj.slug, nextScene.slug);
      }
    }
  };

  const triggerImportScene = (projectSlug: string) => {
    importTargetProjectRef.current = projectSlug;
    fileInputRef.current?.click();
  };

  const handleImportFile = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    const projectSlug = importTargetProjectRef.current;
    if (!file || !projectSlug) {
      return;
    }
    try {
      const loaded = await loadFromBlob(file, null, null);
      const baseName = file.name.replace(
        /\.(excalidraw\.png|excalidraw\.svg|excalidraw|json)$/i,
        "",
      );
      const created = await api.createScene(projectSlug, {
        name: baseName || "Imported Diagram",
        elements: [...loaded.elements],
        appState: loaded.appState ? cleanAppStateForExport(loaded.appState) : {},
        files: loaded.files || {},
      });
      await refreshProjects();
      await openScene(projectSlug, created.slug);
    } catch (err: any) {
      window.alert(
        `Could not import file: ${err?.message || "Invalid Excalidraw file"}`,
      );
    }
  };

  const activeProjectObj = useMemo(
    () => projects.find((p) => p.slug === activeTarget?.project) ?? null,
    [projects, activeTarget],
  );

  const activeSceneObj = useMemo(
    () =>
      activeProjectObj?.scenes.find((s) => s.slug === activeTarget?.scene) ??
      null,
    [activeProjectObj, activeTarget],
  );

  const activeFilePath = useMemo(() => {
    if (!dataDir) {
      return "";
    }
    const cleanRoot = dataDir.replace(/\/+$/, "");
    if (!activeTarget) {
      return cleanRoot;
    }
    return `${cleanRoot}/projects/${activeTarget.project}/scenes/${activeTarget.scene}.excalidraw`;
  }, [dataDir, activeTarget]);

  const shortTailPath = useMemo(() => {
    if (!dataDir) {
      return "";
    }
    const cleanRoot = dataDir.replace(/\/+$/, "");
    const parts = cleanRoot.split("/").filter(Boolean);
    const rootTail = parts.slice(-2).join("/");
    if (!activeTarget) {
      return rootTail;
    }
    return `${rootTail}/projects/${activeTarget.project}/scenes/${activeTarget.scene}.excalidraw`;
  }, [dataDir, activeTarget]);

  const activeCompanionCodePath = useMemo(() => {
    const raw =
      activeCodeFormat === "mermaid"
        ? codePaths?.mmd_path
        : codePaths?.puml_path;
    if (raw) {
      return raw;
    }
    if (!activeFilePath || !activeTarget) {
      return "";
    }
    const ext = activeCodeFormat === "mermaid" ? ".mmd" : ".puml";
    return activeFilePath.replace(/\.excalidraw$/, ext);
  }, [activeCodeFormat, activeFilePath, activeTarget, codePaths]);

  const activeCodeText =
    activeCodeFormat === "mermaid" ? mermaidCode : plantumlCode;

  const handleCopyPath = useCallback(async () => {
    if (!activeFilePath) {
      return;
    }
    try {
      await navigator.clipboard.writeText(activeFilePath);
      setCopiedPath(true);
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
      copyTimerRef.current = window.setTimeout(() => {
        setCopiedPath(false);
      }, 1800);
    } catch {
      // ignore clipboard errors when blocked
    }
  }, [activeFilePath]);

  const handleRevealInFinder = useCallback(() => {
    void api.revealInFinder(activeTargetRef.current ?? undefined);
  }, []);

  const handleApplyStoragePath = useCallback(
    async (nextDir: string | null, copyExisting: boolean) => {
      await flushPendingSave(false);
      const updated = await api.updateStorageConfig({
        data_dir: nextDir,
        copy_existing: copyExisting,
      });
      setDataDir(updated.data_dir);
      setDefaultDataDir(updated.default_data_dir);
      setIsCustomDataDir(updated.is_custom_data_dir);
      uploadedAssetsByProjectRef.current.clear();

      const nextProjects = await refreshProjects();
      const prev = activeTargetRef.current;
      let targetProj =
        nextProjects.find((p) => p.slug === prev?.project) ?? nextProjects[0];
      if (targetProj) {
        let targetScene =
          targetProj.scenes.find((s) => s.slug === prev?.scene) ??
          targetProj.scenes[0];
        if (!targetScene) {
          targetScene = await api.createScene(targetProj.slug, {
            name: "Untitled Diagram",
            elements: [],
            appState: {},
          });
          await refreshProjects();
        }
        await openScene(targetProj.slug, targetScene.slug);
      }
      setShowStorageModal(false);
    },
    [flushPendingSave, openScene, refreshProjects],
  );

  const toggleProjectExpand = (slug: string) => {
    setExpandedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) {
        next.delete(slug);
      } else {
        next.add(slug);
      }
      return next;
    });
  };

  return (
    <div className={`studio-shell ${theme === THEME.DARK ? "dark" : ""}`}>
      <input
        ref={fileInputRef}
        type="file"
        accept=".excalidraw,.json,.png,.svg"
        style={{ display: "none" }}
        onChange={handleImportFile}
      />

      {sidebarOpen && (
        <aside className="studio-sidebar">
          <div className="studio-sidebar-header">
            <div className="studio-brand">
              <span className="studio-brand-title">Excalidraw Studio</span>
              <span className="studio-brand-sub">Rust Local Workspace</span>
            </div>
            <div style={{ display: "flex", gap: 4 }}>
              <button
                type="button"
                className="studio-btn studio-btn-primary"
                onClick={handleCreateProject}
                title="Create new project"
              >
                + Project
              </button>
              <button
                type="button"
                className="studio-btn"
                onClick={() => setSidebarOpen(false)}
                title="Collapse sidebar"
              >
                ⟨
              </button>
            </div>
          </div>

          <div className="studio-autosave-card">
            <div className="studio-autosave-head">
              <span className="studio-autosave-title">
                <span className={`studio-dot ${saveState}`} />
                <span>
                  Local Autosave{isCustomDataDir ? " (Custom)" : ""} ·{" "}
                  {saveState === "saved"
                    ? "Saved"
                    : saveState === "saving"
                      ? "Saving…"
                      : saveState === "unsaved"
                        ? "Autosaving…"
                        : "Error"}
                </span>
              </span>
              <div style={{ display: "flex", gap: 4 }}>
                <button
                  type="button"
                  className="studio-btn studio-mini-btn"
                  disabled={!activeFilePath}
                  onClick={() => void handleCopyPath()}
                  title="Copy full autosave file path"
                >
                  {copiedPath ? "✓ Copied" : "Copy"}
                </button>
                <button
                  type="button"
                  className="studio-btn studio-mini-btn"
                  disabled={!activeFilePath}
                  onClick={handleRevealInFinder}
                  title="Reveal autosaved file in Finder"
                >
                  Finder
                </button>
                <button
                  type="button"
                  className="studio-btn studio-mini-btn"
                  onClick={() => setShowStorageModal(true)}
                  title="Change default autosave directory"
                >
                  Change…
                </button>
              </div>
            </div>
            <div
              className="studio-path-box"
              title={activeFilePath || "Loading autosave path…"}
            >
              {activeFilePath || "Loading workspace path…"}
            </div>
          </div>

          <div className="studio-autosave-card">
            <div className="studio-autosave-head">
              <span className="studio-autosave-title">Two-Way Code Sync</span>
              <span style={{ fontSize: 11, color: "var(--st-muted)" }}>
                Canvas ⇄ Code
              </span>
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <button
                type="button"
                className={`studio-btn studio-mini-btn ${
                  codePanelOpen && activeCodeFormat === "mermaid"
                    ? "studio-btn-primary"
                    : ""
                }`}
                style={{ flex: 1 }}
                onClick={() => openCodePanel("mermaid")}
                title="Open Mermaid (.mmd) two-way converter"
              >
                ⇄ Mermaid (.mmd)
              </button>
              <button
                type="button"
                className={`studio-btn studio-mini-btn ${
                  codePanelOpen && activeCodeFormat === "plantuml"
                    ? "studio-btn-primary"
                    : ""
                }`}
                style={{ flex: 1 }}
                onClick={() => openCodePanel("plantuml")}
                title="Open PlantUML (.puml) two-way converter"
              >
                ⇄ PlantUML (.puml)
              </button>
            </div>
          </div>

          <div className="studio-projects-scroll">
            {projects.map((proj) => {
              const isExpanded = expandedProjects.has(proj.slug);
              return (
                <div key={proj.slug} className="studio-project-card">
                  <div
                    className="studio-project-header"
                    onClick={() => toggleProjectExpand(proj.slug)}
                  >
                    <span className="studio-project-name" title={proj.name}>
                      <span>{isExpanded ? "▾" : "▸"}</span>
                      <span>{proj.name}</span>
                    </span>
                    <div
                      className="studio-project-actions"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <button
                        type="button"
                        className="studio-icon-btn"
                        title="New diagram in project"
                        onClick={() => {
                          setExpandedProjects((prev) =>
                            new Set(prev).add(proj.slug),
                          );
                          void handleCreateScene(proj.slug);
                        }}
                      >
                        +
                      </button>
                      <button
                        type="button"
                        className="studio-icon-btn"
                        title="Rename project"
                        onClick={() => void handleRenameProject(proj)}
                      >
                        ✎
                      </button>
                      {projects.length > 1 && (
                        <button
                          type="button"
                          className="studio-icon-btn"
                          title="Delete project"
                          onClick={() => void handleDeleteProject(proj)}
                        >
                          ✕
                        </button>
                      )}
                    </div>
                  </div>

                  {isExpanded && (
                    <div className="studio-scene-list">
                      {proj.scenes.map((sc) => {
                        const isActive =
                          activeTarget?.project === proj.slug &&
                          activeTarget?.scene === sc.slug;
                        return (
                          <div
                            key={sc.slug}
                            className={`studio-scene-row ${isActive ? "active" : ""}`}
                            onClick={() => void openScene(proj.slug, sc.slug)}
                          >
                            <span
                              className="studio-scene-title"
                              title={sc.name}
                            >
                              {sc.name}
                            </span>
                            <div
                              className="studio-project-actions"
                              onClick={(e) => e.stopPropagation()}
                            >
                              {projects.length > 1 && (
                                <select
                                  aria-label={`Move ${sc.name} to project`}
                                  className="studio-icon-btn"
                                  value=""
                                  title="Move diagram to another project"
                                  onChange={(e) => {
                                    if (e.target.value) {
                                      void handleMoveScene(
                                        proj.slug,
                                        sc,
                                        e.target.value,
                                      );
                                    }
                                  }}
                                >
                                  <option value="">⇄</option>
                                  {projects
                                    .filter((p) => p.slug !== proj.slug)
                                    .map((p) => (
                                      <option key={p.slug} value={p.slug}>
                                        Move → {p.name}
                                      </option>
                                    ))}
                                </select>
                              )}
                              <button
                                type="button"
                                className="studio-icon-btn"
                                title="Rename diagram"
                                onClick={() =>
                                  void handleRenameScene(proj.slug, sc)
                                }
                              >
                                ✎
                              </button>
                              <button
                                type="button"
                                className="studio-icon-btn"
                                title="Delete diagram"
                                onClick={() =>
                                  void handleDeleteScene(proj.slug, sc)
                                }
                              >
                                ✕
                              </button>
                            </div>
                          </div>
                        );
                      })}
                      <div className="studio-scene-toolbar">
                        <button
                          type="button"
                          className="studio-btn"
                          style={{ flex: 1 }}
                          onClick={() => void handleCreateScene(proj.slug)}
                        >
                          + Diagram
                        </button>
                        <button
                          type="button"
                          className="studio-btn"
                          onClick={() => triggerImportScene(proj.slug)}
                          title="Import .excalidraw / .excalidraw.png / .svg into this project"
                        >
                          Import
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </aside>
      )}

      <div className="studio-canvas-wrap">
        <Excalidraw
          onExcalidrawAPI={setExcalidrawAPI}
          onChange={handleCanvasChange}
          theme={theme}
          onThemeChange={(nextTheme) => {
            if (nextTheme === THEME.DARK || nextTheme === THEME.LIGHT) {
              setTheme(nextTheme);
              window.localStorage.setItem("studio-theme", nextTheme);
            }
          }}
          name={activeSceneObj?.name || "Excalidraw Diagram"}
          UIOptions={{
            canvasActions: {
              loadScene: true,
              export: { saveFileToDisk: true },
              saveAsImage: true,
              clearCanvas: true,
              toggleTheme: true,
            },
          }}
          renderTopRightUI={(isMobile) => {
            if (isMobile) {
              return null;
            }
            return (
              <div className="studio-top-right">
                {!sidebarOpen && (
                  <button
                    type="button"
                    className="studio-pill"
                    style={{ cursor: "pointer" }}
                    onClick={() => setSidebarOpen(true)}
                  >
                    ☰ Projects
                  </button>
                )}
                <div className="studio-pill" title="Active project & diagram">
                  <span>
                    {activeProjectObj?.name ?? "…"} /{" "}
                    <strong>{activeSceneObj?.name ?? "…"}</strong>
                  </span>
                </div>
                <div className="studio-pill-wrap">
                  <div
                    className="studio-pill"
                    title={
                      saveError ||
                      (activeFilePath
                        ? `Autosaved to ${activeFilePath} (click to copy)`
                        : "Local disk autosave status")
                    }
                    style={{ cursor: "pointer" }}
                    onClick={() => {
                      if (saveState === "unsaved" || saveState === "error") {
                        void flushPendingSave(false);
                      } else {
                        void handleCopyPath();
                      }
                    }}
                  >
                    <span className={`studio-dot ${saveState}`} />
                    <span>
                      {saveState === "saved"
                        ? copiedPath
                          ? "Copied path"
                          : "Saved"
                        : saveState === "saving"
                          ? "Saving…"
                          : saveState === "unsaved"
                            ? "Autosaving…"
                            : "Save error"}
                    </span>
                    {shortTailPath && (
                      <>
                        <span style={{ color: "var(--st-muted)" }}>·</span>
                        <span className="studio-pill-tail">
                          <bdi>{shortTailPath}</bdi>
                        </span>
                      </>
                    )}
                  </div>

                  {activeFilePath && (
                    <div className="studio-pill-popover">
                      <div className="studio-pill-popover-card">
                        <div className="studio-autosave-head">
                          <span className="studio-autosave-title">
                            Autosaved File Path
                          </span>
                          <span
                            style={{
                              fontSize: 11,
                              color: "var(--st-muted)",
                              fontWeight: 400,
                            }}
                          >
                            Atomic disk write
                          </span>
                        </div>
                        <div className="studio-path-box">{activeFilePath}</div>
                        <div style={{ display: "flex", gap: 6 }}>
                          <button
                            type="button"
                            className="studio-btn"
                            style={{ flex: 1 }}
                            onClick={() => void handleCopyPath()}
                          >
                            {copiedPath ? "✓ Copied Path" : "Copy Path"}
                          </button>
                          <button
                            type="button"
                            className="studio-btn"
                            style={{ flex: 1 }}
                            onClick={handleRevealInFinder}
                          >
                            Finder
                          </button>
                          <button
                            type="button"
                            className="studio-btn studio-btn-primary"
                            style={{ flex: 1 }}
                            onClick={() => setShowStorageModal(true)}
                          >
                            Change Path…
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  className="studio-pill"
                  style={{
                    cursor: "pointer",
                    borderColor:
                      codePanelOpen && activeCodeFormat === "mermaid"
                        ? "var(--st-accent)"
                        : undefined,
                    color:
                      codePanelOpen && activeCodeFormat === "mermaid"
                        ? "var(--st-accent)"
                        : undefined,
                  }}
                  onClick={() => openCodePanel("mermaid")}
                  title="Open Two-Way Mermaid (.mmd) Converter"
                >
                  ⇄ Mermaid
                </button>
                <button
                  type="button"
                  className="studio-pill"
                  style={{
                    cursor: "pointer",
                    borderColor:
                      codePanelOpen && activeCodeFormat === "plantuml"
                        ? "var(--st-accent)"
                        : undefined,
                    color:
                      codePanelOpen && activeCodeFormat === "plantuml"
                        ? "var(--st-accent)"
                        : undefined,
                  }}
                  onClick={() => openCodePanel("plantuml")}
                  title="Open Two-Way PlantUML (.puml) Converter"
                >
                  ⇄ PlantUML
                </button>
                <button
                  type="button"
                  className="studio-pill"
                  style={{ cursor: "pointer" }}
                  onClick={toggleTheme}
                >
                  {theme === THEME.DARK ? "☀ Light" : "☾ Dark"}
                </button>
              </div>
            );
          }}
        >
          <MainMenu>
            <MainMenu.DefaultItems.LoadScene />
            <MainMenu.DefaultItems.Export />
            <MainMenu.DefaultItems.SaveAsImage />
            <MainMenu.DefaultItems.SearchMenu />
            <MainMenu.DefaultItems.ClearCanvas />
            <MainMenu.Separator />
            <MainMenu.Item onSelect={() => setSidebarOpen((v) => !v)}>
              {sidebarOpen ? "Hide Projects Sidebar" : "Show Projects Sidebar"}
            </MainMenu.Item>
            <MainMenu.Item onSelect={() => setCodePanelOpen((v) => !v)}>
              Two-Way Mermaid / PlantUML Sync
            </MainMenu.Item>
            <MainMenu.Item onSelect={() => setShowStorageModal(true)}>
              Change Default Autosave Path…
            </MainMenu.Item>
            <MainMenu.Separator />
            <MainMenu.DefaultItems.ToggleTheme allowSystemTheme={false} />
            <MainMenu.DefaultItems.ChangeCanvasBackground />
            <MainMenu.DefaultItems.Help />
          </MainMenu>
        </Excalidraw>
      </div>

      {codePanelOpen && (
        <aside className="studio-code-panel">
          <div className="studio-code-header">
            <div className="studio-code-tabs" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={activeCodeFormat === "mermaid"}
                className={`studio-code-tab ${activeCodeFormat === "mermaid" ? "active" : ""}`}
                onClick={() => setActiveCodeFormat("mermaid")}
              >
                Mermaid (.mmd)
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeCodeFormat === "plantuml"}
                className={`studio-code-tab ${activeCodeFormat === "plantuml" ? "active" : ""}`}
                onClick={() => setActiveCodeFormat("plantuml")}
              >
                PlantUML (.puml)
              </button>
            </div>
            <button
              type="button"
              className="studio-btn studio-mini-btn"
              onClick={() => setCodePanelOpen(false)}
              title="Close code sync panel"
            >
              ✕
            </button>
          </div>

          <div className="studio-code-status">
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
              }}
            >
              <label className="studio-checkbox-row">
                <input
                  type="checkbox"
                  checked={autoCodeSync}
                  onChange={(e) => {
                    const next = e.target.checked;
                    autoCodeSyncRef.current = next;
                    setAutoCodeSync(next);
                    if (next) {
                      if (
                        codeSyncState === "edited" ||
                        codeSyncState === "error"
                      ) {
                        void applyCodeToCanvas(
                          activeCodeFormat,
                          activeCodeFormat === "mermaid"
                            ? mermaidCodeRef.current
                            : plantumlCodeRef.current,
                        );
                      } else if (apiRef.current) {
                        syncCodeFromElements(apiRef.current.getSceneElements());
                      }
                    }
                  }}
                />
                <span>Auto Two-Way Sync</span>
              </label>
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 5,
                  color: "var(--st-text)",
                  fontWeight: 500,
                }}
              >
                <span
                  className={`studio-dot ${
                    codeSyncState === "synced"
                      ? "saved"
                      : codeSyncState === "syncing"
                        ? "saving"
                        : codeSyncState === "edited"
                          ? "unsaved"
                          : "error"
                  }`}
                />
                {codeSyncState === "synced"
                  ? "Synced"
                  : codeSyncState === "syncing"
                    ? "Syncing…"
                    : codeSyncState === "edited"
                      ? "Manual (unapplied)"
                      : "Syntax error"}
              </span>
            </div>

            {activeCompanionCodePath && (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 6,
                }}
              >
                <span
                  title={activeCompanionCodePath}
                  style={{
                    fontFamily:
                      "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    flex: 1,
                  }}
                >
                  {activeCompanionCodePath}
                </span>
                <button
                  type="button"
                  className="studio-btn studio-mini-btn"
                  onClick={handleRevealInFinder}
                  title="Reveal scene & companion code files in Finder"
                >
                  Finder
                </button>
              </div>
            )}
          </div>

          <textarea
            className="studio-code-editor"
            spellCheck={false}
            value={activeCodeText}
            onChange={(e) =>
              handleCodeEditorChange(activeCodeFormat, e.target.value)
            }
            onKeyDown={(e) => {
              if (e.key === "Tab") {
                e.preventDefault();
                const target = e.currentTarget;
                const start = target.selectionStart;
                const end = target.selectionEnd;
                const nextValue = `${target.value.slice(0, start)}  ${target.value.slice(end)}`;
                handleCodeEditorChange(activeCodeFormat, nextValue);
                window.requestAnimationFrame(() => {
                  target.selectionStart = start + 2;
                  target.selectionEnd = start + 2;
                });
              }
            }}
            placeholder={
              activeCodeFormat === "mermaid"
                ? 'flowchart LR\n  A["Client"] --> B["API"]'
                : '@startuml\nrectangle "Client" as A\nrectangle "API" as B\nA --> B\n@enduml'
            }
          />

          {codeError && <div className="studio-code-error">{codeError}</div>}

          <div className="studio-code-footer">
            <button
              type="button"
              className="studio-btn studio-btn-primary"
              style={{ flex: 1 }}
              onClick={() =>
                void applyCodeToCanvas(activeCodeFormat, activeCodeText)
              }
            >
              Apply to Canvas
            </button>
            <button
              type="button"
              className="studio-btn"
              onClick={handlePullFromCanvas}
              title="Regenerate code from current Excalidraw canvas"
            >
              Pull from Canvas
            </button>
            <button
              type="button"
              className="studio-btn"
              onClick={() => void handleCopyCode()}
              title="Copy current code to clipboard"
            >
              {copiedCode ? "✓ Copied" : "Copy"}
            </button>
          </div>
        </aside>
      )}

      {showStorageModal && (
        <StorageSettingsModal
          currentDir={dataDir}
          defaultDir={defaultDataDir}
          isCustom={isCustomDataDir}
          activeProject={activeTarget?.project ?? "default"}
          activeScene={activeTarget?.scene ?? "architecture"}
          onClose={() => setShowStorageModal(false)}
          onApply={handleApplyStoragePath}
        />
      )}
    </div>
  );
}

function StorageSettingsModal({
  currentDir,
  defaultDir,
  isCustom,
  activeProject,
  activeScene,
  onClose,
  onApply,
}: {
  currentDir: string;
  defaultDir: string;
  isCustom: boolean;
  activeProject: string;
  activeScene: string;
  onClose: () => void;
  onApply: (nextDir: string | null, copyExisting: boolean) => Promise<void>;
}) {
  const [pathInput, setPathInput] = useState(currentDir);
  const [copyExisting, setCopyExisting] = useState(true);
  const [browsing, setBrowsing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const normalizedPreviewRoot = (pathInput.trim() || defaultDir).replace(
    /\/+$/,
    "",
  );
  const previewPath = normalizedPreviewRoot
    ? `${normalizedPreviewRoot}/projects/${activeProject}/scenes/${activeScene}.excalidraw`
    : "";

  const handleBrowse = async () => {
    setBrowsing(true);
    setError(null);
    try {
      const res = await api.pickStorageFolder();
      if (res.path) {
        setPathInput(res.path);
      }
    } catch (err: any) {
      setError(err?.message || "Failed to open folder picker");
    } finally {
      setBrowsing(false);
    }
  };

  const handleSave = async () => {
    const trimmed = pathInput.trim();
    if (!trimmed) {
      setError("Please enter a directory path or click Reset to Default");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onApply(trimmed, copyExisting);
    } catch (err: any) {
      setError(err?.message || "Failed to update autosave path");
      setSaving(false);
    }
  };

  const handleReset = async () => {
    setSaving(true);
    setError(null);
    try {
      await onApply(null, copyExisting);
    } catch (err: any) {
      setError(err?.message || "Failed to reset autosave path");
      setSaving(false);
    }
  };

  return (
    <div className="studio-modal-backdrop" onClick={onClose}>
      <div className="studio-modal" onClick={(e) => e.stopPropagation()}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <strong style={{ fontSize: 15 }}>Default Local Autosave Path</strong>
          <button type="button" className="studio-btn" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="studio-field">
          <label>
            Active Root Folder{" "}
            <span style={{ fontWeight: 400, color: "var(--st-muted)" }}>
              ({isCustom ? "Custom path" : "Server default"})
            </span>
          </label>
          <div className="studio-path-box">{currentDir}</div>
        </div>

        {defaultDir && (
          <div className="studio-field">
            <label>Built-in Default Folder</label>
            <div className="studio-path-box">{defaultDir}</div>
          </div>
        )}

        <div className="studio-field">
          <label>New Autosave Root Directory (supports ~ / absolute path)</label>
          <div style={{ display: "flex", gap: 6 }}>
            <input
              className="studio-input"
              style={{ flex: 1 }}
              value={pathInput}
              onChange={(e) => setPathInput(e.target.value)}
              placeholder="~/Documents/ExcalidrawWorkspace"
            />
            <button
              type="button"
              className="studio-btn"
              disabled={browsing || saving}
              onClick={() => void handleBrowse()}
              title="Browse for a folder using Finder"
            >
              {browsing ? "Opening…" : "Browse…"}
            </button>
          </div>
        </div>

        {previewPath && (
          <div className="studio-field">
            <label>Resulting Diagram & Code Files</label>
            <div className="studio-path-box">
              {previewPath}
              {"\n"}
              (+ companion .mmd &amp; .puml files)
            </div>
          </div>
        )}

        <label className="studio-checkbox-row">
          <input
            type="checkbox"
            checked={copyExisting}
            onChange={(e) => setCopyExisting(e.target.checked)}
          />
          <span>
            Copy existing projects &amp; diagrams into the new folder (non-destructive)
          </span>
        </label>

        {error && (
          <div style={{ fontSize: 12, color: "var(--st-red)" }}>{error}</div>
        )}

        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            gap: 8,
            flexWrap: "wrap",
          }}
        >
          <button
            type="button"
            className="studio-btn"
            disabled={saving || (!isCustom && pathInput.trim() === defaultDir)}
            onClick={() => void handleReset()}
          >
            Reset to Default
          </button>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className="studio-btn" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="studio-btn studio-btn-primary"
              disabled={saving}
              onClick={() => void handleSave()}
            >
              {saving ? "Saving…" : "Save Path"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
