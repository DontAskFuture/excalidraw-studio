use std::time::{SystemTime, UNIX_EPOCH};

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

/// Returns current Unix timestamp in seconds (matches `studio-ui` `epochSecs * 1000`).
pub fn now_epoch_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SceneMeta {
    pub slug: String,
    pub name: String,
    pub updated_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectFile {
    pub slug: String,
    pub name: String,
    pub created_at: u64,
    pub updated_at: u64,
    #[serde(default)]
    pub scenes: Vec<SceneMeta>,
}

#[derive(Debug, Serialize)]
pub struct ProjectsListResponse {
    pub data_dir: String,
    pub default_data_dir: String,
    pub is_custom_data_dir: bool,
    pub projects: Vec<ProjectFile>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct StorageConfigFile {
    #[serde(default)]
    pub custom_data_dir: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct StorageConfigResponse {
    pub data_dir: String,
    pub default_data_dir: String,
    pub is_custom_data_dir: bool,
}

#[derive(Debug, Deserialize)]
pub struct UpdateStorageConfigReq {
    #[serde(default)]
    pub data_dir: Option<String>,
    #[serde(default)]
    pub copy_existing: bool,
}

#[derive(Debug, Serialize)]
pub struct PickFolderResp {
    pub path: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CreateProjectReq {
    pub name: String,
}

#[derive(Debug, Deserialize)]
pub struct RenameProjectReq {
    pub name: String,
}

#[derive(Debug, Deserialize)]
pub struct CreateSceneReq {
    pub name: String,
    #[serde(default = "default_empty_array")]
    pub elements: Value,
    #[serde(rename = "appState", default = "default_empty_object")]
    pub app_state: Value,
    #[serde(default)]
    pub files: Map<String, Value>,
}

fn default_empty_array() -> Value {
    Value::Array(Vec::new())
}

fn default_empty_object() -> Value {
    Value::Object(Map::new())
}

#[derive(Debug, Deserialize)]
pub struct UpdateSceneMetaReq {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub target_project: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct UpdateSceneMetaResp {
    pub project: String,
    pub scene: SceneMeta,
}

#[derive(Debug, Deserialize)]
pub struct SceneSavePayload {
    pub elements: Value,
    #[serde(rename = "appState", default = "default_empty_object")]
    pub app_state: Value,
    #[serde(default)]
    pub asset_ids: Vec<String>,
    #[serde(default)]
    pub mermaid: Option<String>,
    #[serde(default)]
    pub plantuml: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct SceneCodeResponse {
    pub mermaid: Option<String>,
    pub plantuml: Option<String>,
    pub mmd_path: String,
    pub puml_path: String,
    pub external_change: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
pub struct SaveSceneCodeReq {
    #[serde(default)]
    pub mermaid: Option<String>,
    #[serde(default)]
    pub plantuml: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct SaveSceneCodeResp {
    pub ok: bool,
    pub mmd_path: String,
    pub puml_path: String,
}

#[derive(Debug, Serialize)]
pub struct SaveSceneResp {
    pub ok: bool,
    pub updated_at: u64,
    pub saved_path: String,
}

#[derive(Debug, Serialize)]
pub struct OkResp {
    pub ok: bool,
}

#[derive(Debug, Deserialize, Default)]
pub struct RevealReq {
    #[serde(default)]
    pub project: Option<String>,
    #[serde(default)]
    pub scene: Option<String>,
}

#[derive(Debug)]
pub enum AppError {
    BadRequest(String),
    NotFound(String),
    Internal(String),
}

impl From<std::io::Error> for AppError {
    fn from(err: std::io::Error) -> Self {
        AppError::Internal(err.to_string())
    }
}

impl From<serde_json::Error> for AppError {
    fn from(err: serde_json::Error) -> Self {
        AppError::BadRequest(format!("Invalid JSON payload: {err}"))
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, message) = match self {
            AppError::BadRequest(m) => (StatusCode::BAD_REQUEST, m),
            AppError::NotFound(m) => (StatusCode::NOT_FOUND, m),
            AppError::Internal(m) => (StatusCode::INTERNAL_SERVER_ERROR, m),
        };
        (status, Json(json!({ "error": message }))).into_response()
    }
}
