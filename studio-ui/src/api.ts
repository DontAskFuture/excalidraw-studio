export interface SceneMeta {
  slug: string;
  name: string;
  updated_at: number;
}

export interface ProjectSummary {
  slug: string;
  name: string;
  created_at: number;
  updated_at: number;
  scenes: SceneMeta[];
}

export interface SceneDocument {
  type: string;
  version: number;
  source?: string;
  elements: any[];
  appState?: Record<string, any>;
  files?: Record<string, any>;
}

export interface SceneCodeResponse {
  mermaid?: string | null;
  plantuml?: string | null;
  mmd_path: string;
  puml_path: string;
  external_change?: "mermaid" | "plantuml" | null;
}

export interface StorageConfigStatus {
  data_dir: string;
  default_data_dir: string;
  is_custom_data_dir: boolean;
}

async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const data = await res.json();
      if (data?.error) {
        msg = data.error;
      }
    } catch {
      // ignore non-json error body
    }
    throw new Error(msg);
  }
  if (res.status === 204) {
    return undefined as T;
  }
  return (await res.json()) as T;
}

export const api = {
  listProjects: () =>
    apiJson<{
      data_dir: string;
      default_data_dir: string;
      is_custom_data_dir: boolean;
      projects: ProjectSummary[];
    }>("/api/projects"),

  createProject: (name: string) =>
    apiJson<ProjectSummary>("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    }),

  renameProject: (slug: string, name: string) =>
    apiJson<ProjectSummary>(`/api/projects/${encodeURIComponent(slug)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    }),

  deleteProject: (slug: string) =>
    apiJson<void>(`/api/projects/${encodeURIComponent(slug)}`, {
      method: "DELETE",
    }),

  createScene: (
    project: string,
    payload: {
      name: string;
      elements?: any[];
      appState?: Record<string, any>;
      files?: Record<string, any>;
    },
  ) =>
    apiJson<SceneMeta>(`/api/projects/${encodeURIComponent(project)}/scenes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),

  updateSceneMeta: (
    project: string,
    scene: string,
    payload: { name?: string; target_project?: string },
  ) =>
    apiJson<{ project: string; scene: SceneMeta }>(
      `/api/projects/${encodeURIComponent(project)}/scenes/${encodeURIComponent(scene)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
    ),

  deleteScene: (project: string, scene: string) =>
    apiJson<void>(
      `/api/projects/${encodeURIComponent(project)}/scenes/${encodeURIComponent(scene)}`,
      { method: "DELETE" },
    ),

  getScene: (project: string, scene: string) =>
    apiJson<SceneDocument>(
      `/api/projects/${encodeURIComponent(project)}/scenes/${encodeURIComponent(scene)}`,
    ),

  saveScene: (
    project: string,
    scene: string,
    payload: {
      elements: readonly any[];
      appState: Record<string, any>;
      asset_ids: string[];
      mermaid?: string;
      plantuml?: string;
    },
    keepalive = false,
  ) =>
    apiJson<{ ok: boolean; updated_at: number; saved_path?: string }>(
      `/api/projects/${encodeURIComponent(project)}/scenes/${encodeURIComponent(scene)}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        keepalive,
      },
    ),

  getSceneCode: (project: string, scene: string) =>
    apiJson<SceneCodeResponse>(
      `/api/projects/${encodeURIComponent(project)}/scenes/${encodeURIComponent(scene)}/code`,
    ),

  saveSceneCode: (
    project: string,
    scene: string,
    payload: { mermaid?: string; plantuml?: string },
  ) =>
    apiJson<{ ok: boolean; mmd_path: string; puml_path: string }>(
      `/api/projects/${encodeURIComponent(project)}/scenes/${encodeURIComponent(scene)}/code`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
    ),

  uploadAsset: (project: string, assetId: string, fileData: any) =>
    apiJson<{ ok: boolean }>(
      `/api/projects/${encodeURIComponent(project)}/assets/${encodeURIComponent(assetId)}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(fileData),
      },
    ),

  getStorageConfig: () => apiJson<StorageConfigStatus>("/api/storage/config"),

  updateStorageConfig: (payload: {
    data_dir?: string | null;
    copy_existing: boolean;
  }) =>
    apiJson<StorageConfigStatus>("/api/storage/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),

  pickStorageFolder: () =>
    apiJson<{ path: string | null }>("/api/storage/pick-folder", {
      method: "POST",
    }),

  revealInFinder: (target?: { project: string; scene: string }) =>
    apiJson<{ ok: boolean }>("/api/reveal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(target ?? {}),
    }),
};
