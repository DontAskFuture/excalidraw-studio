use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, RwLock as StdRwLock};

use serde_json::{json, Map, Value};
use tokio::sync::Mutex;

use crate::models::{
    now_epoch_secs, AppError, CreateSceneReq, ProjectFile, SaveSceneCodeReq, SaveSceneCodeResp,
    SceneCodeResponse, SceneMeta, SceneSavePayload, StorageConfigFile, StorageConfigResponse,
    UpdateSceneMetaReq, UpdateSceneMetaResp, UpdateStorageConfigReq,
};

static TMP_SEQ: AtomicU64 = AtomicU64::new(1);

#[derive(Clone)]
pub struct Storage {
    default_data_dir: PathBuf,
    active_data_dir: Arc<StdRwLock<PathBuf>>,
    lock: Arc<Mutex<()>>,
}

impl Storage {
    pub fn new(default_data_dir: PathBuf) -> Result<Self, AppError> {
        fs::create_dir_all(default_data_dir.join("projects"))?;
        let default_data_dir = fs::canonicalize(&default_data_dir).unwrap_or(default_data_dir);

        let mut initial_dir = default_data_dir.clone();
        let cfg_path = default_data_dir.join(".storage_config.json");
        if cfg_path.exists() {
            if let Ok(bytes) = fs::read(&cfg_path) {
                if let Ok(cfg) = serde_json::from_slice::<StorageConfigFile>(&bytes) {
                    if let Some(raw) = cfg.custom_data_dir.as_deref().map(str::trim) {
                        if !raw.is_empty() {
                            if let Ok(prepared) = resolve_and_prepare_data_dir(raw) {
                                initial_dir = prepared;
                            }
                        }
                    }
                }
            }
        }

        Ok(Self {
            default_data_dir,
            active_data_dir: Arc::new(StdRwLock::new(initial_dir)),
            lock: Arc::new(Mutex::new(())),
        })
    }

    pub fn current_data_dir(&self) -> PathBuf {
        self.active_data_dir.read().unwrap().clone()
    }

    pub fn data_dir_str(&self) -> String {
        self.current_data_dir().to_string_lossy().into_owned()
    }

    pub fn default_data_dir_str(&self) -> String {
        self.default_data_dir.to_string_lossy().into_owned()
    }

    pub fn is_custom_data_dir(&self) -> bool {
        self.current_data_dir() != self.default_data_dir
    }

    pub fn storage_config_status(&self) -> StorageConfigResponse {
        StorageConfigResponse {
            data_dir: self.data_dir_str(),
            default_data_dir: self.default_data_dir_str(),
            is_custom_data_dir: self.is_custom_data_dir(),
        }
    }

    pub fn scene_path_checked(&self, project: &str, scene: &str) -> Result<PathBuf, AppError> {
        validate_slug(project, "project")?;
        validate_slug(scene, "scene")?;
        let path = self.scene_path(project, scene);
        if !path.exists() {
            return Err(AppError::NotFound(format!(
                "Scene file missing for '{project}/{scene}'"
            )));
        }
        Ok(path)
    }

    pub fn projects_dir(&self) -> PathBuf {
        self.current_data_dir().join("projects")
    }

    pub fn project_dir(&self, project: &str) -> PathBuf {
        self.projects_dir().join(project)
    }

    pub fn project_meta_path(&self, project: &str) -> PathBuf {
        self.project_dir(project).join("project.json")
    }

    pub fn scenes_dir(&self, project: &str) -> PathBuf {
        self.project_dir(project).join("scenes")
    }

    pub fn scene_path(&self, project: &str, scene: &str) -> PathBuf {
        self.scenes_dir(project).join(format!("{scene}.excalidraw"))
    }

    pub fn mermaid_path(&self, project: &str, scene: &str) -> PathBuf {
        self.scenes_dir(project).join(format!("{scene}.mmd"))
    }

    pub fn plantuml_path(&self, project: &str, scene: &str) -> PathBuf {
        self.scenes_dir(project).join(format!("{scene}.puml"))
    }

    pub fn assets_dir(&self, project: &str) -> PathBuf {
        self.project_dir(project).join("assets")
    }

    pub fn asset_path(&self, project: &str, asset_id: &str) -> PathBuf {
        self.assets_dir(project).join(format!("{asset_id}.json"))
    }

    pub fn storage_config_path(&self) -> PathBuf {
        self.default_data_dir.join(".storage_config.json")
    }

    pub async fn bootstrap_if_empty(&self) -> Result<(), AppError> {
        let _guard = self.lock.lock().await;
        self.bootstrap_unlocked()
    }

    fn bootstrap_unlocked(&self) -> Result<(), AppError> {
        if !self.scan_projects_unlocked()?.is_empty() {
            return Ok(());
        }

        let now = now_epoch_secs();
        let slug = "default".to_string();
        self.ensure_project_dirs(&slug)?;

        let arch_scene = bootstrap_architecture_scene(now);
        let scratch_scene = json!({
            "type": "excalidraw",
            "version": 2,
            "source": "http://localhost:3001",
            "elements": [],
            "appState": { "viewBackgroundColor": "#ffffff" },
            "files": {}
        });

        atomic_write_json(&self.scene_path(&slug, "architecture"), &arch_scene, false)?;
        atomic_write_json(&self.scene_path(&slug, "scratchpad"), &scratch_scene, false)?;

        let project = ProjectFile {
            slug: slug.clone(),
            name: "Default Workspace".to_string(),
            created_at: now,
            updated_at: now,
            scenes: vec![
                SceneMeta {
                    slug: "architecture".to_string(),
                    name: "System Architecture".to_string(),
                    updated_at: now,
                },
                SceneMeta {
                    slug: "scratchpad".to_string(),
                    name: "Scratchpad".to_string(),
                    updated_at: now,
                },
            ],
        };
        atomic_write_json(&self.project_meta_path(&slug), &project, false)?;
        Ok(())
    }

    pub async fn update_storage_dir(
        &self,
        req: UpdateStorageConfigReq,
    ) -> Result<StorageConfigResponse, AppError> {
        let _guard = self.lock.lock().await;

        let custom_raw = req
            .data_dir
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);

        let target_dir = match &custom_raw {
            None => self.default_data_dir.clone(),
            Some(raw) => resolve_and_prepare_data_dir(raw)?,
        };

        let prev_dir = self.current_data_dir();
        if target_dir != prev_dir && target_dir.starts_with(prev_dir.join("projects")) {
            return Err(AppError::BadRequest(
                "Autosave path cannot be inside the current projects directory".to_string(),
            ));
        }

        if target_dir != prev_dir && req.copy_existing {
            let prev_projects = prev_dir.join("projects");
            let next_projects = target_dir.join("projects");
            fs::create_dir_all(&next_projects)?;
            if prev_projects.exists() {
                for entry in fs::read_dir(&prev_projects)? {
                    let entry = entry?;
                    let src_proj = entry.path();
                    if !src_proj.is_dir() {
                        continue;
                    }
                    let Some(name) = src_proj.file_name() else {
                        continue;
                    };
                    let dst_proj = next_projects.join(name);
                    if !dst_proj.exists() {
                        copy_dir_non_destructive(&src_proj, &dst_proj)?;
                    }
                }
            }
        }

        let persisted_custom = if target_dir == self.default_data_dir {
            None
        } else {
            Some(target_dir.to_string_lossy().into_owned())
        };
        let cfg = StorageConfigFile {
            custom_data_dir: persisted_custom,
        };
        atomic_write_json(&self.storage_config_path(), &cfg, false)?;

        {
            let mut active = self.active_data_dir.write().unwrap();
            *active = target_dir;
        }

        self.bootstrap_unlocked()?;
        Ok(self.storage_config_status())
    }

    pub async fn list_projects(&self) -> Result<Vec<ProjectFile>, AppError> {
        let _guard = self.lock.lock().await;
        self.scan_projects_unlocked()
    }

    pub async fn create_project(&self, raw_name: &str) -> Result<ProjectFile, AppError> {
        let name = normalize_display_name(raw_name, "Untitled Project")?;
        let _guard = self.lock.lock().await;

        let base = slugify(&name);
        let slug = self.unique_project_slug_unlocked(&base);
        self.ensure_project_dirs(&slug)?;

        let now = now_epoch_secs();
        let project = ProjectFile {
            slug: slug.clone(),
            name,
            created_at: now,
            updated_at: now,
            scenes: Vec::new(),
        };
        atomic_write_json(&self.project_meta_path(&slug), &project, false)?;
        Ok(project)
    }

    pub async fn rename_project(
        &self,
        slug: &str,
        raw_name: &str,
    ) -> Result<ProjectFile, AppError> {
        validate_slug(slug, "project")?;
        let name = normalize_display_name(raw_name, "Untitled Project")?;
        let _guard = self.lock.lock().await;

        let mut project = self.read_project_unlocked(slug)?;
        project.name = name;
        project.updated_at = now_epoch_secs();
        atomic_write_json(&self.project_meta_path(slug), &project, false)?;
        Ok(project)
    }

    pub async fn delete_project(&self, slug: &str) -> Result<(), AppError> {
        validate_slug(slug, "project")?;
        let _guard = self.lock.lock().await;

        let dir = self.project_dir(slug);
        if !dir.exists() {
            return Err(AppError::NotFound(format!("Project '{slug}' not found")));
        }
        fs::remove_dir_all(dir)?;
        Ok(())
    }

    pub async fn create_scene(
        &self,
        project_slug: &str,
        req: CreateSceneReq,
    ) -> Result<SceneMeta, AppError> {
        validate_slug(project_slug, "project")?;
        let name = normalize_display_name(&req.name, "Untitled Diagram")?;
        let _guard = self.lock.lock().await;

        let mut project = self.read_project_unlocked(project_slug)?;
        self.ensure_project_dirs(project_slug)?;

        let existing: HashSet<String> = project.scenes.iter().map(|s| s.slug.clone()).collect();
        let scene_slug = unique_slug_in_set(&slugify(&name), &existing);

        for (asset_id, file_val) in &req.files {
            if validate_asset_id(asset_id).is_ok() {
                atomic_write_json(&self.asset_path(project_slug, asset_id), file_val, false)?;
            }
        }

        let elements = if req.elements.is_array() {
            req.elements
        } else {
            Value::Array(Vec::new())
        };
        let app_state = if req.app_state.is_object() {
            req.app_state
        } else {
            json!({ "viewBackgroundColor": "#ffffff" })
        };

        let doc = json!({
            "type": "excalidraw",
            "version": 2,
            "source": "http://localhost:3001",
            "elements": elements,
            "appState": app_state,
            "files": Value::Object(req.files),
        });
        atomic_write_json(&self.scene_path(project_slug, &scene_slug), &doc, false)?;

        let now = now_epoch_secs();
        let meta = SceneMeta {
            slug: scene_slug,
            name,
            updated_at: now,
        };
        project.scenes.push(meta.clone());
        project.updated_at = now;
        atomic_write_json(&self.project_meta_path(project_slug), &project, false)?;
        Ok(meta)
    }

    pub async fn update_scene_meta(
        &self,
        project_slug: &str,
        scene_slug: &str,
        req: UpdateSceneMetaReq,
    ) -> Result<UpdateSceneMetaResp, AppError> {
        validate_slug(project_slug, "project")?;
        validate_slug(scene_slug, "scene")?;
        let _guard = self.lock.lock().await;

        let mut src_project = self.read_project_unlocked(project_slug)?;
        let idx = src_project
            .scenes
            .iter()
            .position(|s| s.slug == scene_slug)
            .ok_or_else(|| {
                AppError::NotFound(format!(
                    "Scene '{scene_slug}' not found in '{project_slug}'"
                ))
            })?;

        let now = now_epoch_secs();
        let mut meta = src_project.scenes[idx].clone();
        if let Some(raw_name) = req.name {
            meta.name = normalize_display_name(&raw_name, &meta.name)?;
        }

        if let Some(target_slug) = req.target_project.filter(|t| t != project_slug) {
            validate_slug(&target_slug, "target_project")?;
            let mut dst_project = self.read_project_unlocked(&target_slug)?;
            self.ensure_project_dirs(&target_slug)?;

            let existing: HashSet<String> =
                dst_project.scenes.iter().map(|s| s.slug.clone()).collect();
            let new_scene_slug = unique_slug_in_set(&meta.slug, &existing);

            let src_scene_file = self.scene_path(project_slug, scene_slug);
            let dst_scene_file = self.scene_path(&target_slug, &new_scene_slug);

            // Copy referenced assets to destination project first so images stay intact.
            if src_scene_file.exists() {
                if let Ok(bytes) = fs::read(&src_scene_file) {
                    if let Ok(doc) = serde_json::from_slice::<Value>(&bytes) {
                        for asset_id in extract_asset_ids_from_doc(&doc) {
                            let src_asset = self.asset_path(project_slug, &asset_id);
                            let dst_asset = self.asset_path(&target_slug, &asset_id);
                            if src_asset.exists() && !dst_asset.exists() {
                                let asset_bytes = fs::read(&src_asset)?;
                                atomic_write_bytes(&dst_asset, &asset_bytes, false)?;
                            }
                        }
                    }
                    atomic_write_bytes(&dst_scene_file, &bytes, false)?;
                    let _ = fs::remove_file(&src_scene_file);
                }
            }

            // Move companion Mermaid / PlantUML files alongside the scene if present.
            for (src_code, dst_code) in [
                (
                    self.mermaid_path(project_slug, scene_slug),
                    self.mermaid_path(&target_slug, &new_scene_slug),
                ),
                (
                    self.plantuml_path(project_slug, scene_slug),
                    self.plantuml_path(&target_slug, &new_scene_slug),
                ),
            ] {
                if src_code.exists() {
                    let bytes = fs::read(&src_code)?;
                    atomic_write_bytes(&dst_code, &bytes, false)?;
                    let _ = fs::remove_file(&src_code);
                }
            }

            src_project.scenes.remove(idx);
            src_project.updated_at = now;
            atomic_write_json(&self.project_meta_path(project_slug), &src_project, false)?;

            meta.slug = new_scene_slug;
            meta.updated_at = now;
            dst_project.scenes.push(meta.clone());
            dst_project.updated_at = now;
            atomic_write_json(&self.project_meta_path(&target_slug), &dst_project, false)?;

            return Ok(UpdateSceneMetaResp {
                project: target_slug,
                scene: meta,
            });
        }

        meta.updated_at = now;
        src_project.scenes[idx] = meta.clone();
        src_project.updated_at = now;
        atomic_write_json(&self.project_meta_path(project_slug), &src_project, false)?;

        Ok(UpdateSceneMetaResp {
            project: project_slug.to_string(),
            scene: meta,
        })
    }

    pub async fn delete_scene(&self, project_slug: &str, scene_slug: &str) -> Result<(), AppError> {
        validate_slug(project_slug, "project")?;
        validate_slug(scene_slug, "scene")?;
        let _guard = self.lock.lock().await;

        let mut project = self.read_project_unlocked(project_slug)?;
        let idx = project
            .scenes
            .iter()
            .position(|s| s.slug == scene_slug)
            .ok_or_else(|| {
                AppError::NotFound(format!(
                    "Scene '{scene_slug}' not found in '{project_slug}'"
                ))
            })?;

        project.scenes.remove(idx);
        project.updated_at = now_epoch_secs();
        atomic_write_json(&self.project_meta_path(project_slug), &project, false)?;

        let scene_file = self.scene_path(project_slug, scene_slug);
        if scene_file.exists() {
            fs::remove_file(scene_file)?;
        }
        for code_file in [
            self.mermaid_path(project_slug, scene_slug),
            self.plantuml_path(project_slug, scene_slug),
        ] {
            if code_file.exists() {
                let _ = fs::remove_file(code_file);
            }
        }
        Ok(())
    }

    pub async fn get_scene(&self, project_slug: &str, scene_slug: &str) -> Result<Value, AppError> {
        validate_slug(project_slug, "project")?;
        validate_slug(scene_slug, "scene")?;
        let _guard = self.lock.lock().await;

        let project = self.read_project_unlocked(project_slug)?;
        if !project.scenes.iter().any(|s| s.slug == scene_slug) {
            return Err(AppError::NotFound(format!(
                "Scene '{scene_slug}' not found in '{project_slug}'"
            )));
        }

        let path = self.scene_path(project_slug, scene_slug);
        if !path.exists() {
            return Err(AppError::NotFound(format!(
                "Scene file missing for '{project_slug}/{scene_slug}'"
            )));
        }

        let bytes = fs::read(&path)?;
        let mut doc: Value = serde_json::from_slice(&bytes)?;

        // Hydrate any asset files referenced by elements from assets/<id>.json if missing.
        let asset_ids = extract_asset_ids_from_doc(&doc);
        if let Some(obj) = doc.as_object_mut() {
            let files_val = obj
                .entry("files".to_string())
                .or_insert_with(|| Value::Object(Map::new()));
            if !files_val.is_object() {
                *files_val = Value::Object(Map::new());
            }
            if let Some(files_map) = files_val.as_object_mut() {
                for id in asset_ids {
                    if !files_map.contains_key(&id) && validate_asset_id(&id).is_ok() {
                        let asset_file = self.asset_path(project_slug, &id);
                        if asset_file.exists() {
                            if let Ok(raw) = fs::read(&asset_file) {
                                if let Ok(val) = serde_json::from_slice::<Value>(&raw) {
                                    files_map.insert(id, val);
                                }
                            }
                        }
                    }
                }
            }
        }

        Ok(doc)
    }

    pub async fn save_scene(
        &self,
        project_slug: &str,
        scene_slug: &str,
        payload: SceneSavePayload,
    ) -> Result<u64, AppError> {
        validate_slug(project_slug, "project")?;
        validate_slug(scene_slug, "scene")?;
        let _guard = self.lock.lock().await;

        let mut project = self.read_project_unlocked(project_slug)?;
        let meta = project
            .scenes
            .iter_mut()
            .find(|s| s.slug == scene_slug)
            .ok_or_else(|| {
                AppError::NotFound(format!(
                    "Scene '{scene_slug}' not found in '{project_slug}'"
                ))
            })?;

        self.ensure_project_dirs(project_slug)?;
        let path = self.scene_path(project_slug, scene_slug);

        // Preserve any previously embedded file fallback if disk asset wasn't uploaded separately.
        let mut existing_files = Map::new();
        if path.exists() {
            if let Ok(raw) = fs::read(&path) {
                if let Ok(prev_doc) = serde_json::from_slice::<Value>(&raw) {
                    if let Some(prev_map) = prev_doc.get("files").and_then(|v| v.as_object()) {
                        existing_files = prev_map.clone();
                    }
                }
            }
        }

        let mut files_map = Map::new();
        let mut requested: HashSet<String> = payload.asset_ids.into_iter().collect();
        if let Some(arr) = payload.elements.as_array() {
            for el in arr {
                let is_deleted = el
                    .get("isDeleted")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                if !is_deleted {
                    if let Some(fid) = el.get("fileId").and_then(|v| v.as_str()) {
                        requested.insert(fid.to_string());
                    }
                }
            }
        }

        for id in requested {
            if validate_asset_id(&id).is_err() {
                continue;
            }
            let asset_file = self.asset_path(project_slug, &id);
            if asset_file.exists() {
                if let Ok(raw) = fs::read(&asset_file) {
                    if let Ok(val) = serde_json::from_slice::<Value>(&raw) {
                        files_map.insert(id, val);
                        continue;
                    }
                }
            }
            if let Some(prev_val) = existing_files.get(&id) {
                files_map.insert(id, prev_val.clone());
            }
        }

        let elements = if payload.elements.is_array() {
            payload.elements
        } else {
            return Err(AppError::BadRequest(
                "`elements` must be a JSON array".to_string(),
            ));
        };
        let app_state = if payload.app_state.is_object() {
            payload.app_state
        } else {
            Value::Object(Map::new())
        };

        let doc = json!({
            "type": "excalidraw",
            "version": 2,
            "source": "http://localhost:3001",
            "elements": elements,
            "appState": app_state,
            "files": Value::Object(files_map),
        });
        atomic_write_json(&path, &doc, false)?;

        if let Some(mmd) = payload.mermaid {
            atomic_write_bytes(&self.mermaid_path(project_slug, scene_slug), mmd.as_bytes(), false)?;
        }
        if let Some(puml) = payload.plantuml {
            atomic_write_bytes(&self.plantuml_path(project_slug, scene_slug), puml.as_bytes(), false)?;
        }

        let now = now_epoch_secs();
        meta.updated_at = now;
        project.updated_at = now;
        atomic_write_json(&self.project_meta_path(project_slug), &project, false)?;

        Ok(now)
    }

    pub async fn save_asset(
        &self,
        project_slug: &str,
        asset_id: &str,
        data: Value,
    ) -> Result<(), AppError> {
        validate_slug(project_slug, "project")?;
        validate_asset_id(asset_id)?;
        let _guard = self.lock.lock().await;

        let _ = self.read_project_unlocked(project_slug)?;
        self.ensure_project_dirs(project_slug)?;
        atomic_write_json(&self.asset_path(project_slug, asset_id), &data, false)
    }

    pub async fn get_scene_code(
        &self,
        project_slug: &str,
        scene_slug: &str,
    ) -> Result<SceneCodeResponse, AppError> {
        validate_slug(project_slug, "project")?;
        validate_slug(scene_slug, "scene")?;
        let _guard = self.lock.lock().await;

        let project = self.read_project_unlocked(project_slug)?;
        if !project.scenes.iter().any(|s| s.slug == scene_slug) {
            return Err(AppError::NotFound(format!(
                "Scene '{scene_slug}' not found in '{project_slug}'"
            )));
        }

        let scene_path = self.scene_path(project_slug, scene_slug);
        let mmd_path = self.mermaid_path(project_slug, scene_slug);
        let puml_path = self.plantuml_path(project_slug, scene_slug);

        let mermaid = if mmd_path.exists() {
            Some(fs::read_to_string(&mmd_path)?)
        } else {
            None
        };
        let plantuml = if puml_path.exists() {
            Some(fs::read_to_string(&puml_path)?)
        } else {
            None
        };

        let mut external_change: Option<String> = None;
        if let Ok(scene_meta) = fs::metadata(&scene_path) {
            if let Ok(scene_mtime) = scene_meta.modified() {
                let threshold = scene_mtime
                    .checked_add(std::time::Duration::from_millis(1200))
                    .unwrap_or(scene_mtime);
                let mmd_mtime = fs::metadata(&mmd_path).and_then(|m| m.modified()).ok();
                let puml_mtime = fs::metadata(&puml_path).and_then(|m| m.modified()).ok();

                let mmd_newer = mmd_mtime.filter(|&t| t > threshold);
                let puml_newer = puml_mtime.filter(|&t| t > threshold);
                external_change = match (mmd_newer, puml_newer) {
                    (Some(mt), Some(pt)) => Some(if mt >= pt {
                        "mermaid".to_string()
                    } else {
                        "plantuml".to_string()
                    }),
                    (Some(_), None) => Some("mermaid".to_string()),
                    (None, Some(_)) => Some("plantuml".to_string()),
                    (None, None) => None,
                };
            }
        }

        Ok(SceneCodeResponse {
            mermaid,
            plantuml,
            mmd_path: mmd_path.to_string_lossy().into_owned(),
            puml_path: puml_path.to_string_lossy().into_owned(),
            external_change,
        })
    }

    pub async fn save_scene_code(
        &self,
        project_slug: &str,
        scene_slug: &str,
        req: SaveSceneCodeReq,
    ) -> Result<SaveSceneCodeResp, AppError> {
        validate_slug(project_slug, "project")?;
        validate_slug(scene_slug, "scene")?;
        let _guard = self.lock.lock().await;

        let project = self.read_project_unlocked(project_slug)?;
        if !project.scenes.iter().any(|s| s.slug == scene_slug) {
            return Err(AppError::NotFound(format!(
                "Scene '{scene_slug}' not found in '{project_slug}'"
            )));
        }
        self.ensure_project_dirs(project_slug)?;

        let mmd_path = self.mermaid_path(project_slug, scene_slug);
        let puml_path = self.plantuml_path(project_slug, scene_slug);
        if let Some(mmd) = req.mermaid {
            atomic_write_bytes(&mmd_path, mmd.as_bytes(), false)?;
        }
        if let Some(puml) = req.plantuml {
            atomic_write_bytes(&puml_path, puml.as_bytes(), false)?;
        }

        Ok(SaveSceneCodeResp {
            ok: true,
            mmd_path: mmd_path.to_string_lossy().into_owned(),
            puml_path: puml_path.to_string_lossy().into_owned(),
        })
    }

    fn ensure_project_dirs(&self, project: &str) -> Result<(), AppError> {
        fs::create_dir_all(self.scenes_dir(project))?;
        fs::create_dir_all(self.assets_dir(project))?;
        Ok(())
    }

    fn scan_projects_unlocked(&self) -> Result<Vec<ProjectFile>, AppError> {
        let root = self.projects_dir();
        if !root.exists() {
            return Ok(Vec::new());
        }
        let mut projects = Vec::new();
        for entry in fs::read_dir(root)? {
            let entry = entry?;
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let meta_path = path.join("project.json");
            if !meta_path.exists() {
                continue;
            }
            if let Ok(bytes) = fs::read(&meta_path) {
                if let Ok(proj) = serde_json::from_slice::<ProjectFile>(&bytes) {
                    projects.push(proj);
                }
            }
        }
        projects.sort_by(|a, b| {
            a.created_at
                .cmp(&b.created_at)
                .then_with(|| a.slug.cmp(&b.slug))
        });
        Ok(projects)
    }

    fn read_project_unlocked(&self, project: &str) -> Result<ProjectFile, AppError> {
        let meta_path = self.project_meta_path(project);
        if !meta_path.exists() {
            return Err(AppError::NotFound(format!(
                "Project '{project}' not found"
            )));
        }
        let bytes = fs::read(meta_path)?;
        let proj: ProjectFile = serde_json::from_slice(&bytes)?;
        Ok(proj)
    }

    fn unique_project_slug_unlocked(&self, base: &str) -> String {
        if !self.project_dir(base).exists() {
            return base.to_string();
        }
        for i in 2..10_000 {
            let candidate = format!("{base}-{i}");
            if !self.project_dir(&candidate).exists() {
                return candidate;
            }
        }
        format!("{base}-{}", now_epoch_secs())
    }
}

pub fn validate_slug(value: &str, label: &str) -> Result<(), AppError> {
    if value.is_empty() || value.len() > 120 {
        return Err(AppError::BadRequest(format!(
            "Invalid {label} slug length"
        )));
    }
    if !value
        .bytes()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_')
    {
        return Err(AppError::BadRequest(format!(
            "Invalid {label} slug '{value}'"
        )));
    }
    Ok(())
}

pub fn validate_asset_id(value: &str) -> Result<(), AppError> {
    if value.is_empty() || value.len() > 160 {
        return Err(AppError::BadRequest("Invalid asset ID length".to_string()));
    }
    if !value
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err(AppError::BadRequest(format!(
            "Invalid asset ID '{value}'"
        )));
    }
    Ok(())
}

pub fn slugify(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut prev_dash = false;
    for ch in raw.trim().chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
            prev_dash = false;
        } else if !prev_dash && !out.is_empty() {
            out.push('-');
            prev_dash = true;
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    if out.len() > 64 {
        out.truncate(64);
        while out.ends_with('-') {
            out.pop();
        }
    }
    if out.is_empty() {
        "untitled".to_string()
    } else {
        out
    }
}

fn normalize_display_name(raw: &str, fallback: &str) -> Result<String, AppError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(fallback.to_string());
    }
    if trimmed.len() > 160 {
        return Err(AppError::BadRequest(
            "Name must be 160 characters or fewer".to_string(),
        ));
    }
    Ok(trimmed.to_string())
}

fn unique_slug_in_set(base: &str, existing: &HashSet<String>) -> String {
    if !existing.contains(base) {
        return base.to_string();
    }
    for i in 2..10_000 {
        let candidate = format!("{base}-{i}");
        if !existing.contains(&candidate) {
            return candidate;
        }
    }
    format!("{base}-{}", now_epoch_secs())
}

fn extract_asset_ids_from_doc(doc: &Value) -> Vec<String> {
    let mut ids = HashSet::new();
    if let Some(elements) = doc.get("elements").and_then(|v| v.as_array()) {
        for el in elements {
            let is_deleted = el
                .get("isDeleted")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            if !is_deleted {
                if let Some(fid) = el.get("fileId").and_then(|v| v.as_str()) {
                    ids.insert(fid.to_string());
                }
            }
        }
    }
    ids.into_iter().collect()
}

pub fn atomic_write_json<T: serde::Serialize>(
    path: &Path,
    value: &T,
    restricted_mode: bool,
) -> Result<(), AppError> {
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|e| AppError::Internal(format!("JSON serialization failed: {e}")))?;
    atomic_write_bytes(path, &bytes, restricted_mode)
}

pub fn atomic_write_bytes(
    path: &Path,
    bytes: &[u8],
    restricted_mode: bool,
) -> Result<(), AppError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }

    let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let pid = std::process::id();
    let file_name = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("file");
    let tmp_path = path.with_file_name(format!(".{file_name}.tmp.{pid}.{seq}"));

    {
        let mut opts = OpenOptions::new();
        opts.create(true).write(true).truncate(true);
        #[cfg(unix)]
        if restricted_mode {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut file: File = opts.open(&tmp_path)?;
        file.write_all(bytes)?;
        file.sync_data()?;
    }

    #[cfg(unix)]
    if restricted_mode {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&tmp_path, fs::Permissions::from_mode(0o600));
    }

    fs::rename(&tmp_path, path)?;
    Ok(())
}

fn expand_user_path(raw: &str) -> PathBuf {
    let trimmed = raw.trim();
    if trimmed == "~" || trimmed.starts_with("~/") {
        if let Ok(home) = std::env::var("HOME") {
            if !home.is_empty() {
                if trimmed == "~" {
                    return PathBuf::from(home);
                }
                return PathBuf::from(home).join(&trimmed[2..]);
            }
        }
    }
    let path = PathBuf::from(trimmed);
    if path.is_absolute() {
        path
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    }
}

fn resolve_and_prepare_data_dir(raw: &str) -> Result<PathBuf, AppError> {
    if raw.trim().is_empty() {
        return Err(AppError::BadRequest(
            "Autosave path cannot be empty".to_string(),
        ));
    }
    let candidate = expand_user_path(raw);
    if candidate == Path::new("/") {
        return Err(AppError::BadRequest(
            "Autosave path cannot be filesystem root '/'".to_string(),
        ));
    }
    if candidate.exists() && !candidate.is_dir() {
        return Err(AppError::BadRequest(format!(
            "Path '{}' exists and is not a folder",
            candidate.display()
        )));
    }

    let projects_dir = candidate.join("projects");
    fs::create_dir_all(&projects_dir).map_err(|e| {
        AppError::BadRequest(format!(
            "Cannot create autosave folder '{}': {e}",
            candidate.display()
        ))
    })?;

    let probe_path = projects_dir.join(format!(".write_probe_{}", std::process::id()));
    OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&probe_path)
        .map_err(|e| {
            AppError::BadRequest(format!(
                "Autosave folder '{}' is not writable: {e}",
                candidate.display()
            ))
        })?;
    let _ = fs::remove_file(&probe_path);

    Ok(fs::canonicalize(&candidate).unwrap_or(candidate))
}

fn copy_dir_non_destructive(src: &Path, dst: &Path) -> Result<(), AppError> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        if file_type.is_symlink() {
            continue;
        }
        let name = entry.file_name();
        if name.to_string_lossy().contains(".tmp.") {
            continue;
        }
        let src_child = entry.path();
        let dst_child = dst.join(name);
        if file_type.is_dir() {
            copy_dir_non_destructive(&src_child, &dst_child)?;
        } else if file_type.is_file() && !dst_child.exists() {
            fs::copy(&src_child, &dst_child)?;
        }
    }
    Ok(())
}

/// Seeds a 4-zone diagram showing how the browser Excalidraw engine, Rust Axum server,
/// atomic local storage, and two-way Mermaid/PlantUML sync interact.
fn bootstrap_architecture_scene(now_secs: u64) -> Value {
    let updated_ms = now_secs.saturating_mul(1000);

    let make_rect = |id: &str,
                     index: &str,
                     x: f64,
                     y: f64,
                     w: f64,
                     h: f64,
                     stroke: &str,
                     bg: &str,
                     text_id: &str,
                     seed: u64| {
        json!({
            "id": id,
            "type": "rectangle",
            "x": x,
            "y": y,
            "width": w,
            "height": h,
            "angle": 0,
            "strokeColor": stroke,
            "backgroundColor": bg,
            "fillStyle": "solid",
            "strokeWidth": 2,
            "strokeStyle": "solid",
            "roughness": 1,
            "opacity": 100,
            "groupIds": [],
            "frameId": Value::Null,
            "index": index,
            "roundness": { "type": 3 },
            "seed": seed,
            "version": 1,
            "versionNonce": seed + 10,
            "isDeleted": false,
            "boundElements": [{ "id": text_id, "type": "text" }],
            "updated": updated_ms,
            "link": Value::Null,
            "locked": false
        })
    };

    let make_text = |id: &str,
                     index: &str,
                     x: f64,
                     y: f64,
                     w: f64,
                     h: f64,
                     stroke: &str,
                     text: &str,
                     container_id: Option<&str>,
                     seed: u64| {
        json!({
            "id": id,
            "type": "text",
            "x": x,
            "y": y,
            "width": w,
            "height": h,
            "angle": 0,
            "strokeColor": stroke,
            "backgroundColor": "transparent",
            "fillStyle": "solid",
            "strokeWidth": 2,
            "strokeStyle": "solid",
            "roughness": 1,
            "opacity": 100,
            "groupIds": [],
            "frameId": Value::Null,
            "index": index,
            "roundness": Value::Null,
            "seed": seed,
            "version": 1,
            "versionNonce": seed + 10,
            "isDeleted": false,
            "boundElements": Value::Null,
            "updated": updated_ms,
            "link": Value::Null,
            "locked": false,
            "text": text,
            "fontSize": 16,
            "fontFamily": 5,
            "textAlign": "center",
            "verticalAlign": "middle",
            "containerId": container_id,
            "originalText": text,
            "autoResize": true,
            "lineHeight": 1.25
        })
    };

    let make_arrow = |id: &str, index: &str, x: f64, y: f64, dx: f64, dy: f64, stroke: &str, seed: u64| {
        json!({
            "id": id,
            "type": "arrow",
            "x": x,
            "y": y,
            "width": dx.abs().max(1.0),
            "height": dy.abs(),
            "angle": 0,
            "strokeColor": stroke,
            "backgroundColor": "transparent",
            "fillStyle": "solid",
            "strokeWidth": 2,
            "strokeStyle": "solid",
            "roughness": 1,
            "opacity": 100,
            "groupIds": [],
            "frameId": Value::Null,
            "index": index,
            "roundness": { "type": 2 },
            "seed": seed,
            "version": 1,
            "versionNonce": seed + 10,
            "isDeleted": false,
            "boundElements": [],
            "updated": updated_ms,
            "link": Value::Null,
            "locked": false,
            "points": [[0.0, 0.0], [dx, dy]],
            "lastCommittedPoint": Value::Null,
            "startBinding": Value::Null,
            "endBinding": Value::Null,
            "startArrowhead": Value::Null,
            "endArrowhead": "arrow",
            "elbowed": false
        })
    };

    let elements = vec![
        make_rect(
            "box-browser",
            "a0",
            40.0,
            100.0,
            230.0,
            130.0,
            "#1971c2",
            "#e7f5ff",
            "txt-browser",
            101,
        ),
        make_text(
            "txt-browser",
            "a1",
            55.0,
            125.0,
            200.0,
            80.0,
            "#1971c2",
            "1. Browser Excalidraw UI\nSidebar + onChange\nexportScene(PNG/SVG)",
            Some("box-browser"),
            102,
        ),
        make_arrow("arr-1", "a2", 275.0, 165.0, 70.0, 0.0, "#495057", 103),
        make_rect(
            "box-rust",
            "a3",
            350.0,
            100.0,
            230.0,
            130.0,
            "#e67700",
            "#fff4e6",
            "txt-rust",
            104,
        ),
        make_text(
            "txt-rust",
            "a4",
            365.0,
            125.0,
            200.0,
            80.0,
            "#e67700",
            "2. Rust Axum Server\nStatic ServeDir + /api/*\nCoalescing Worker",
            Some("box-rust"),
            105,
        ),
        make_arrow("arr-2", "a5", 585.0, 140.0, 70.0, -35.0, "#2f9e44", 106),
        make_rect(
            "box-disk",
            "a6",
            660.0,
            40.0,
            230.0,
            120.0,
            "#2f9e44",
            "#ebfbee",
            "txt-disk",
            107,
        ),
        make_text(
            "txt-disk",
            "a7",
            675.0,
            60.0,
            200.0,
            80.0,
            "#2f9e44",
            "3. Local Atomic Store\nprojects/<slug>/scenes/\n.excalidraw + assets",
            Some("box-disk"),
            108,
        ),
        make_arrow("arr-3", "a8", 585.0, 195.0, 70.0, 35.0, "#7950f2", 109),
        make_rect(
            "box-codesync",
            "a9",
            660.0,
            195.0,
            230.0,
            120.0,
            "#7950f2",
            "#f3f0ff",
            "txt-codesync",
            110,
        ),
        make_text(
            "txt-codesync",
            "aA",
            675.0,
            215.0,
            200.0,
            80.0,
            "#7950f2",
            "4. Two-Way Code Sync\nMermaid (.mmd) & PlantUML\nLive Canvas <-> Code",
            Some("box-codesync"),
            111,
        ),
    ];

    json!({
        "type": "excalidraw",
        "version": 2,
        "source": "http://localhost:3001",
        "elements": elements,
        "appState": { "viewBackgroundColor": "#ffffff" },
        "files": {}
    })
}
