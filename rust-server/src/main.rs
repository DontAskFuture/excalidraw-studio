mod models;
mod storage;

use std::net::SocketAddr;
use std::path::{Path, PathBuf};

use axum::extract::{DefaultBodyLimit, Path as AxumPath, State};
use axum::http::StatusCode;
use axum::routing::{get, patch, post, put};
use axum::{Json, Router};
use serde_json::Value;
use tower_http::compression::CompressionLayer;
use tower_http::services::{ServeDir, ServeFile};

use crate::models::{
    AppError, CreateProjectReq, CreateSceneReq, OkResp, PickFolderResp, ProjectFile,
    ProjectsListResponse, RenameProjectReq, RevealReq, SaveSceneCodeReq, SaveSceneCodeResp,
    SaveSceneResp, SceneCodeResponse, SceneMeta, SceneSavePayload, StorageConfigResponse,
    UpdateSceneMetaReq, UpdateSceneMetaResp, UpdateStorageConfigReq,
};
use crate::storage::Storage;

#[derive(Clone)]
struct AppState {
    storage: Storage,
}

#[tokio::main(worker_threads = 2)]
async fn main() {
    let (dist_dir, data_dir) = resolve_dirs();
    let host = std::env::var("HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(3001);

    let storage = Storage::new(data_dir.clone()).expect("Failed to initialize data directory");
    storage
        .bootstrap_if_empty()
        .await
        .expect("Failed to bootstrap default workspace");

    let active_data = storage.data_dir_str();
    let state = AppState { storage };
    let app = build_router(state, dist_dir.clone());

    let addr: SocketAddr = format!("{host}:{port}")
        .parse()
        .expect("Invalid HOST:PORT listen address");
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .unwrap_or_else(|e| panic!("Failed to bind {addr}: {e}"));

    println!(
        "Listening on http://{addr} (dist={}, data={})",
        dist_dir.display(),
        active_data
    );
    let _ = std::io::Write::flush(&mut std::io::stdout());

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .expect("Server error");
}

fn resolve_dirs() -> (PathBuf, PathBuf) {
    let env_dist = std::env::var("EXCALIDRAW_DIST_DIR").ok().map(PathBuf::from);
    let env_data = std::env::var("EXCALIDRAW_DATA_DIR").ok().map(PathBuf::from);

    let exe_root = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent()?.parent()?.parent().map(Path::to_path_buf));

    let dist_dir = env_dist.unwrap_or_else(|| {
        let cwd_dist = PathBuf::from("dist");
        if cwd_dist.join("index.html").exists() {
            cwd_dist
        } else if let Some(ref root) = exe_root {
            let candidate = root.join("dist");
            if candidate.join("index.html").exists() {
                return candidate;
            }
            cwd_dist
        } else {
            cwd_dist
        }
    });

    let data_dir = env_data.unwrap_or_else(|| {
        if PathBuf::from("dist").join("index.html").exists() {
            PathBuf::from("data")
        } else if let Some(ref root) = exe_root {
            if root.join("dist").join("index.html").exists() {
                return root.join("data");
            }
            PathBuf::from("data")
        } else {
            PathBuf::from("data")
        }
    });

    (dist_dir, data_dir)
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };

    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut sig) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            sig.recv().await;
        }
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
}

fn build_router(state: AppState, dist_dir: PathBuf) -> Router {
    let index_path = dist_dir.join("index.html");
    let static_service = ServeDir::new(&dist_dir).not_found_service(ServeFile::new(index_path));

    Router::new()
        .route("/api/projects", get(list_projects).post(create_project))
        .route(
            "/api/projects/:project",
            patch(rename_project).delete(delete_project),
        )
        .route("/api/projects/:project/scenes", post(create_scene))
        .route(
            "/api/projects/:project/scenes/:scene",
            get(get_scene)
                .put(save_scene)
                .patch(update_scene_meta)
                .delete(delete_scene),
        )
        .route(
            "/api/projects/:project/assets/:asset_id",
            put(save_asset),
        )
        .route(
            "/api/projects/:project/scenes/:scene/code",
            get(get_scene_code).put(save_scene_code),
        )
        .route(
            "/api/storage/config",
            get(get_storage_config).put(update_storage_config),
        )
        .route("/api/storage/pick-folder", post(pick_storage_folder))
        .route("/api/reveal", post(reveal_in_finder))
        .fallback_service(static_service)
        .layer(DefaultBodyLimit::max(32 * 1024 * 1024))
        .layer(CompressionLayer::new())
        .with_state(state)
}

async fn list_projects(
    State(state): State<AppState>,
) -> Result<Json<ProjectsListResponse>, AppError> {
    let projects = state.storage.list_projects().await?;
    Ok(Json(ProjectsListResponse {
        data_dir: state.storage.data_dir_str(),
        default_data_dir: state.storage.default_data_dir_str(),
        is_custom_data_dir: state.storage.is_custom_data_dir(),
        projects,
    }))
}

async fn create_project(
    State(state): State<AppState>,
    Json(req): Json<CreateProjectReq>,
) -> Result<Json<ProjectFile>, AppError> {
    let created = state.storage.create_project(&req.name).await?;
    Ok(Json(created))
}

async fn rename_project(
    State(state): State<AppState>,
    AxumPath(project): AxumPath<String>,
    Json(req): Json<RenameProjectReq>,
) -> Result<Json<ProjectFile>, AppError> {
    let updated = state.storage.rename_project(&project, &req.name).await?;
    Ok(Json(updated))
}

async fn delete_project(
    State(state): State<AppState>,
    AxumPath(project): AxumPath<String>,
) -> Result<StatusCode, AppError> {
    state.storage.delete_project(&project).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn create_scene(
    State(state): State<AppState>,
    AxumPath(project): AxumPath<String>,
    Json(req): Json<CreateSceneReq>,
) -> Result<Json<SceneMeta>, AppError> {
    let created = state.storage.create_scene(&project, req).await?;
    Ok(Json(created))
}

async fn update_scene_meta(
    State(state): State<AppState>,
    AxumPath((project, scene)): AxumPath<(String, String)>,
    Json(req): Json<UpdateSceneMetaReq>,
) -> Result<Json<UpdateSceneMetaResp>, AppError> {
    let updated = state
        .storage
        .update_scene_meta(&project, &scene, req)
        .await?;
    Ok(Json(updated))
}

async fn delete_scene(
    State(state): State<AppState>,
    AxumPath((project, scene)): AxumPath<(String, String)>,
) -> Result<StatusCode, AppError> {
    state.storage.delete_scene(&project, &scene).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn get_scene(
    State(state): State<AppState>,
    AxumPath((project, scene)): AxumPath<(String, String)>,
) -> Result<Json<Value>, AppError> {
    let doc = state.storage.get_scene(&project, &scene).await?;
    Ok(Json(doc))
}

async fn save_scene(
    State(state): State<AppState>,
    AxumPath((project, scene)): AxumPath<(String, String)>,
    Json(payload): Json<SceneSavePayload>,
) -> Result<Json<SaveSceneResp>, AppError> {
    let updated_at = state.storage.save_scene(&project, &scene, payload).await?;
    let saved_path = state
        .storage
        .scene_path(&project, &scene)
        .to_string_lossy()
        .into_owned();
    Ok(Json(SaveSceneResp {
        ok: true,
        updated_at,
        saved_path,
    }))
}

async fn save_asset(
    State(state): State<AppState>,
    AxumPath((project, asset_id)): AxumPath<(String, String)>,
    Json(data): Json<Value>,
) -> Result<Json<OkResp>, AppError> {
    state.storage.save_asset(&project, &asset_id, data).await?;
    Ok(Json(OkResp { ok: true }))
}

async fn get_scene_code(
    State(state): State<AppState>,
    AxumPath((project, scene)): AxumPath<(String, String)>,
) -> Result<Json<SceneCodeResponse>, AppError> {
    let code = state.storage.get_scene_code(&project, &scene).await?;
    Ok(Json(code))
}

async fn save_scene_code(
    State(state): State<AppState>,
    AxumPath((project, scene)): AxumPath<(String, String)>,
    Json(req): Json<SaveSceneCodeReq>,
) -> Result<Json<SaveSceneCodeResp>, AppError> {
    let resp = state.storage.save_scene_code(&project, &scene, req).await?;
    Ok(Json(resp))
}

async fn get_storage_config(
    State(state): State<AppState>,
) -> Result<Json<StorageConfigResponse>, AppError> {
    Ok(Json(state.storage.storage_config_status()))
}

async fn update_storage_config(
    State(state): State<AppState>,
    Json(req): Json<UpdateStorageConfigReq>,
) -> Result<Json<StorageConfigResponse>, AppError> {
    let status = state.storage.update_storage_dir(req).await?;
    Ok(Json(status))
}

async fn pick_storage_folder() -> Result<Json<PickFolderResp>, AppError> {
    #[cfg(target_os = "macos")]
    {
        let chosen = tokio::task::spawn_blocking(|| {
            let output = std::process::Command::new("osascript")
                .args([
                    "-e",
                    "POSIX path of (choose folder with prompt \"Select Excalidraw Autosave Folder\")",
                ])
                .output();
            match output {
                Ok(out) if out.status.success() => {
                    let raw = String::from_utf8_lossy(&out.stdout).trim().to_string();
                    if raw.is_empty() {
                        None
                    } else if raw.len() > 1 {
                        Some(raw.trim_end_matches('/').to_string())
                    } else {
                        Some(raw)
                    }
                }
                _ => None,
            }
        })
        .await
        .map_err(|e| AppError::Internal(format!("Folder picker task failed: {e}")))?;
        return Ok(Json(PickFolderResp { path: chosen }));
    }

    #[cfg(not(target_os = "macos"))]
    {
        Ok(Json(PickFolderResp { path: None }))
    }
}

async fn reveal_in_finder(
    State(state): State<AppState>,
    body: Option<Json<RevealReq>>,
) -> Result<Json<OkResp>, AppError> {
    let req = body.map(|Json(r)| r).unwrap_or_default();
    let target = match (req.project, req.scene) {
        (Some(p), Some(s)) if !p.trim().is_empty() && !s.trim().is_empty() => {
            Some(state.storage.scene_path_checked(p.trim(), s.trim())?)
        }
        _ => None,
    };

    #[cfg(target_os = "macos")]
    {
        if let Some(file_path) = target {
            std::process::Command::new("open")
                .arg("-R")
                .arg(&file_path)
                .status()
                .map_err(|e| AppError::Internal(format!("Failed to launch Finder: {e}")))?;
        } else {
            std::process::Command::new("open")
                .arg(state.storage.projects_dir())
                .status()
                .map_err(|e| AppError::Internal(format!("Failed to open data folder: {e}")))?;
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = target;

    Ok(Json(OkResp { ok: true }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_SEQ: AtomicU64 = AtomicU64::new(1);

    struct TestHarness {
        base_url: String,
        root_dir: PathBuf,
        data_dir: PathBuf,
        client: reqwest::Client,
    }

    impl Drop for TestHarness {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root_dir);
        }
    }

    async fn spawn_test_server() -> TestHarness {
        let seq = TEST_SEQ.fetch_add(1, Ordering::Relaxed);
        let root_dir = std::env::temp_dir().join(format!(
            "excalidraw-rust-server-test-{}-{seq}",
            std::process::id()
        ));
        let dist_dir = root_dir.join("dist");
        let data_dir = root_dir.join("data");
        fs::create_dir_all(&dist_dir).unwrap();
        fs::write(
            dist_dir.join("index.html"),
            "<!doctype html><html><body>Excalidraw Studio Test</body></html>",
        )
        .unwrap();

        let storage = Storage::new(data_dir.clone()).unwrap();
        storage.bootstrap_if_empty().await.unwrap();
        let app = build_router(AppState { storage }, dist_dir);

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        TestHarness {
            base_url: format!("http://{addr}"),
            root_dir,
            data_dir,
            client: reqwest::Client::new(),
        }
    }

    #[tokio::test]
    async fn bootstrap_and_static_serving() {
        let h = spawn_test_server().await;

        let html = h
            .client
            .get(&h.base_url)
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap();
        assert!(html.contains("Excalidraw Studio Test"));

        let list: Value = h
            .client
            .get(format!("{}/api/projects", h.base_url))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let data_dir_str = list["data_dir"].as_str().unwrap();
        assert!(!data_dir_str.is_empty());
        assert!(Path::new(data_dir_str).is_absolute());
        let projects = list["projects"].as_array().unwrap();
        assert_eq!(projects.len(), 1);
        assert_eq!(projects[0]["slug"], "default");
        let scenes = projects[0]["scenes"].as_array().unwrap();
        assert_eq!(scenes[0]["slug"], "architecture");
        assert_eq!(scenes[1]["slug"], "scratchpad");

        let arch: Value = h
            .client
            .get(format!(
                "{}/api/projects/default/scenes/architecture",
                h.base_url
            ))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(arch["type"], "excalidraw");
        assert_eq!(arch["version"], 2);
        let elements = arch["elements"].as_array().unwrap();
        assert!(!elements.is_empty());
        for el in elements {
            let w = el["width"].as_f64().unwrap_or(0.0);
            let h_val = el["height"].as_f64().unwrap_or(0.0);
            assert!(w > 0.0 || h_val > 0.0);
        }
    }

    #[tokio::test]
    async fn project_scene_crud_and_asset_autosave() {
        let h = spawn_test_server().await;

        let proj: Value = h
            .client
            .post(format!("{}/api/projects", h.base_url))
            .json(&json!({ "name": "Payments Redesign" }))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(proj["slug"], "payments-redesign");

        let scene: Value = h
            .client
            .post(format!(
                "{}/api/projects/payments-redesign/scenes",
                h.base_url
            ))
            .json(&json!({ "name": "Checkout Flow" }))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(scene["slug"], "checkout-flow");

        let asset_res = h
            .client
            .put(format!(
                "{}/api/projects/payments-redesign/assets/imgAsset_123",
                h.base_url
            ))
            .json(&json!({
                "mimeType": "image/png",
                "id": "imgAsset_123",
                "dataURL": "data:image/png;base64,iVBORw0KGgo=",
                "created": 12345
            }))
            .send()
            .await
            .unwrap();
        assert!(asset_res.status().is_success());

        let save_res: Value = h
            .client
            .put(format!(
                "{}/api/projects/payments-redesign/scenes/checkout-flow",
                h.base_url
            ))
            .json(&json!({
                "elements": [
                    { "id": "el1", "type": "image", "fileId": "imgAsset_123", "width": 100, "height": 100, "isDeleted": false }
                ],
                "appState": { "viewBackgroundColor": "#fafafa" },
                "asset_ids": ["imgAsset_123"]
            }))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(save_res["ok"], true);
        let saved_path = save_res["saved_path"].as_str().unwrap();
        assert!(saved_path.ends_with("projects/payments-redesign/scenes/checkout-flow.excalidraw"));

        let disk_path = h
            .data_dir
            .join("projects/payments-redesign/scenes/checkout-flow.excalidraw");
        let disk_doc: Value = serde_json::from_slice(&fs::read(disk_path).unwrap()).unwrap();
        assert_eq!(disk_doc["files"]["imgAsset_123"]["id"], "imgAsset_123");

        let fetched: Value = h
            .client
            .get(format!(
                "{}/api/projects/payments-redesign/scenes/checkout-flow",
                h.base_url
            ))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(fetched["files"]["imgAsset_123"]["mimeType"], "image/png");
    }

    #[tokio::test]
    async fn move_scene_across_projects() {
        let h = spawn_test_server().await;

        let _: Value = h
            .client
            .post(format!("{}/api/projects", h.base_url))
            .json(&json!({ "name": "Project Alpha" }))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let _: Value = h
            .client
            .post(format!("{}/api/projects", h.base_url))
            .json(&json!({ "name": "Project Beta" }))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();

        let _: Value = h
            .client
            .post(format!("{}/api/projects/project-alpha/scenes", h.base_url))
            .json(&json!({
                "name": "Service Map",
                "elements": [
                    { "id": "img1", "type": "image", "fileId": "assetA", "width": 64, "height": 64, "isDeleted": false }
                ],
                "files": {
                    "assetA": { "id": "assetA", "mimeType": "image/png", "dataURL": "data:image/png;base64,AAA=" }
                }
            }))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();

        let moved: Value = h
            .client
            .patch(format!(
                "{}/api/projects/project-alpha/scenes/service-map",
                h.base_url
            ))
            .json(&json!({ "target_project": "project-beta" }))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(moved["project"], "project-beta");
        assert_eq!(moved["scene"]["slug"], "service-map");

        let old_status = h
            .client
            .get(format!(
                "{}/api/projects/project-alpha/scenes/service-map",
                h.base_url
            ))
            .send()
            .await
            .unwrap()
            .status();
        assert_eq!(old_status, reqwest::StatusCode::NOT_FOUND);

        let moved_doc: Value = h
            .client
            .get(format!(
                "{}/api/projects/project-beta/scenes/service-map",
                h.base_url
            ))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(moved_doc["files"]["assetA"]["id"], "assetA");
        assert!(h
            .data_dir
            .join("projects/project-beta/assets/assetA.json")
            .exists());
    }

    #[tokio::test]
    async fn companion_mermaid_plantuml_disk_sync() {
        let h = spawn_test_server().await;

        let initial_mmd = "flowchart LR\n  A[\"Browser\"] --> B[\"Rust API\"]\n";
        let initial_puml = "@startuml\nleft to right direction\nrectangle \"Browser\" as A\nrectangle \"Rust API\" as B\nA --> B\n@enduml\n";

        let save_res: Value = h
            .client
            .put(format!(
                "{}/api/projects/default/scenes/architecture",
                h.base_url
            ))
            .json(&json!({
                "elements": [
                    { "id": "A", "type": "rectangle", "x": 0, "y": 0, "width": 120, "height": 60, "isDeleted": false }
                ],
                "appState": { "viewBackgroundColor": "#ffffff" },
                "asset_ids": [],
                "mermaid": initial_mmd,
                "plantuml": initial_puml
            }))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(save_res["ok"], true);

        let mmd_disk = h
            .data_dir
            .join("projects/default/scenes/architecture.mmd");
        let puml_disk = h
            .data_dir
            .join("projects/default/scenes/architecture.puml");
        assert_eq!(fs::read_to_string(&mmd_disk).unwrap(), initial_mmd);
        assert_eq!(fs::read_to_string(&puml_disk).unwrap(), initial_puml);

        let code_res: Value = h
            .client
            .get(format!(
                "{}/api/projects/default/scenes/architecture/code",
                h.base_url
            ))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(code_res["mermaid"], initial_mmd);
        assert_eq!(code_res["plantuml"], initial_puml);
        assert!(code_res["external_change"].is_null());

        // Simulate external editor saving an updated .mmd file strictly later (> 1200ms) than .excalidraw
        tokio::time::sleep(std::time::Duration::from_millis(1300)).await;
        let updated_mmd = "flowchart LR\n  A[\"Browser\"] --> C[\"Cache\"]\n";
        fs::write(&mmd_disk, updated_mmd).unwrap();

        let ext_res: Value = h
            .client
            .get(format!(
                "{}/api/projects/default/scenes/architecture/code",
                h.base_url
            ))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(ext_res["external_change"], "mermaid");
        assert_eq!(ext_res["mermaid"], updated_mmd);
    }

    #[tokio::test]
    async fn change_default_autosave_path_and_persist() {
        let h = spawn_test_server().await;

        let initial_cfg: Value = h
            .client
            .get(format!("{}/api/storage/config", h.base_url))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(initial_cfg["is_custom_data_dir"], false);
        let default_dir = initial_cfg["default_data_dir"]
            .as_str()
            .unwrap()
            .to_string();

        let custom_dir = h.root_dir.join("custom-autosave");
        let updated: Value = h
            .client
            .put(format!("{}/api/storage/config", h.base_url))
            .json(&json!({
                "data_dir": custom_dir.to_string_lossy(),
                "copy_existing": true
            }))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(updated["is_custom_data_dir"], true);
        let canonical_custom = fs::canonicalize(&custom_dir).unwrap();
        assert_eq!(
            updated["data_dir"],
            canonical_custom.to_string_lossy().as_ref()
        );
        assert!(custom_dir
            .join("projects/default/scenes/architecture.excalidraw")
            .exists());

        let save_res: Value = h
            .client
            .put(format!(
                "{}/api/projects/default/scenes/scratchpad",
                h.base_url
            ))
            .json(&json!({
                "elements": [
                    { "id": "box1", "type": "rectangle", "x": 10, "y": 20, "width": 100, "height": 50, "isDeleted": false }
                ],
                "appState": { "viewBackgroundColor": "#ffffff" },
                "asset_ids": []
            }))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(save_res["ok"], true);
        let saved_path = save_res["saved_path"].as_str().unwrap();
        assert!(saved_path.starts_with(canonical_custom.to_string_lossy().as_ref()));

        // Verify custom path persists across Storage re-instantiation (server restarts)
        let reloaded = Storage::new(h.data_dir.clone()).unwrap();
        assert!(reloaded.is_custom_data_dir());
        assert_eq!(reloaded.data_dir_str(), canonical_custom.to_string_lossy());

        // Verify resetting back to default restores default_dir cleanly
        let reset: Value = h
            .client
            .put(format!("{}/api/storage/config", h.base_url))
            .json(&json!({
                "data_dir": null,
                "copy_existing": false
            }))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(reset["is_custom_data_dir"], false);
        assert_eq!(reset["data_dir"], default_dir);
    }
}
