mod renamer;
mod undo;

use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::{Html, IntoResponse, Json},
    routing::{get, post},
    Router,
};
use renamer::{apply_rule, RenameRule};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;
use tower_http::services::ServeDir;
use undo::{RenameOp, UndoManager};

// Error type that always serializes as JSON
struct ApiError(StatusCode, String);

impl IntoResponse for ApiError {
    fn into_response(self) -> axum::response::Response {
        let body = serde_json::json!({ "error": self.1 });
        (self.0, Json(body)).into_response()
    }
}

impl From<(StatusCode, String)> for ApiError {
    fn from((code, msg): (StatusCode, String)) -> Self {
        Self(code, msg)
    }
}

struct AppState {
    undo_manager: UndoManager,
}

#[tokio::main]
async fn main() {
    let state = Arc::new(AppState {
        undo_manager: UndoManager::new(),
    });

    let app = Router::new()
        .route("/", get(serve_index))
        .route("/api/drives", get(list_drives))
        .route("/api/files", get(list_files))
        .route("/api/preview", post(preview_rename))
        .route("/api/rename", post(execute_rename))
        .route("/api/undo", post(undo_last))
        .route("/api/history", get(get_history))
        .nest_service("/static", ServeDir::new("static"))
        .with_state(state);

    let addr = "127.0.0.1:3080";
    println!("🚀 IRL Renammer démarré sur http://{addr}");
    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}

async fn serve_index() -> impl IntoResponse {
    let html = std::fs::read_to_string("static/index.html")
        .unwrap_or_else(|_| "Erreur: static/index.html introuvable".to_string());
    Html(html)
}

#[derive(Serialize)]
struct DriveInfo {
    letter: String,
    label: String,
    drive_type: String,
}

async fn list_drives() -> Json<Vec<DriveInfo>> {
    let mut drives = Vec::new();

    // Use PowerShell to get drive info (labels, types)
    let ps = std::process::Command::new("powershell.exe")
        .args(["-Command", "Get-CimInstance Win32_LogicalDisk | Select-Object DeviceID, VolumeName, DriveType, Size | ConvertTo-Csv -NoTypeInformation"])
        .output();

    let mut labels: std::collections::HashMap<String, (String, String)> = std::collections::HashMap::new();
    if let Ok(output) = ps {
        let text = String::from_utf8_lossy(&output.stdout);
        for line in text.lines().skip(1) {
            // CSV: "DeviceID","VolumeName","DriveType","Size"
            let cols: Vec<&str> = line.split(',').map(|s| s.trim().trim_matches('"')).collect();
            if cols.len() >= 3 {
                let device = cols[0].to_string();
                let vol_name = cols[1].to_string();
                let dtype = match cols[2] {
                    "2" => "Amovible",
                    "3" => "Disque local",
                    "4" => "Reseau",
                    "5" => "CD-ROM",
                    _ => "",
                };
                labels.insert(device, (vol_name, dtype.to_string()));
            }
        }
    }

    for letter in b'A'..=b'Z' {
        let drive = format!("{}:\\", letter as char);
        if PathBuf::from(&drive).exists() {
            let device_id = format!("{}:", letter as char);
            let (label, drive_type) = labels
                .get(&device_id)
                .cloned()
                .unwrap_or_default();
            drives.push(DriveInfo {
                letter: drive,
                label,
                drive_type,
            });
        }
    }
    Json(drives)
}

#[derive(Deserialize)]
struct FilesQuery {
    path: String,
}

#[derive(Serialize)]
struct FileEntry {
    name: String,
    is_dir: bool,
    size: u64,
}

async fn list_files(Query(q): Query<FilesQuery>) -> Result<Json<Vec<FileEntry>>, ApiError> {
    let path = PathBuf::from(&q.path);
    if !path.exists() {
        return Err(ApiError(StatusCode::NOT_FOUND, "Dossier introuvable".into()));
    }
    if !path.is_dir() {
        return Err(ApiError(StatusCode::BAD_REQUEST, "Le chemin n'est pas un dossier".into()));
    }

    let mut entries = Vec::new();
    let read_dir = std::fs::read_dir(&path)
        .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, format!("Erreur lecture: {e}")))?;

    for entry in read_dir.flatten() {
        let metadata = entry.metadata().unwrap_or_else(|_| std::fs::metadata(entry.path()).unwrap());
        entries.push(FileEntry {
            name: entry.file_name().to_string_lossy().into_owned(),
            is_dir: metadata.is_dir(),
            size: metadata.len(),
        });
    }

    entries.sort_by(|a, b| {
        b.is_dir.cmp(&a.is_dir).then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(Json(entries))
}

#[derive(Deserialize)]
struct PreviewRequest {
    path: String,
    filenames: Vec<String>,
    rule: RenameRule,
}

async fn preview_rename(
    Json(req): Json<PreviewRequest>,
) -> Result<Json<Vec<renamer::RenamePreview>>, ApiError> {
    apply_rule(&req.filenames, &req.rule)
        .map(Json)
        .map_err(|e| ApiError(StatusCode::BAD_REQUEST, e))
}

#[derive(Serialize)]
struct RenameResult {
    renamed: usize,
    errors: Vec<String>,
    record_id: u64,
}

async fn execute_rename(
    State(state): State<Arc<AppState>>,
    Json(req): Json<PreviewRequest>,
) -> Result<Json<RenameResult>, ApiError> {
    let previews = apply_rule(&req.filenames, &req.rule)
        .map_err(|e| ApiError(StatusCode::BAD_REQUEST, e))?;

    let dir = PathBuf::from(&req.path);
    let mut renamed = 0;
    let mut errors = Vec::new();
    let mut ops = Vec::new();

    for p in &previews {
        if !p.changed {
            continue;
        }
        let from = dir.join(&p.original);
        let to = dir.join(&p.renamed);

        if to.exists() {
            errors.push(format!("{} → {} : le fichier cible existe déjà", p.original, p.renamed));
            continue;
        }

        match std::fs::rename(&from, &to) {
            Ok(()) => {
                renamed += 1;
                ops.push(RenameOp {
                    from: p.original.clone(),
                    to: p.renamed.clone(),
                });
            }
            Err(e) => {
                errors.push(format!("{} → {} : {e}", p.original, p.renamed));
            }
        }
    }

    let record = state.undo_manager.record(req.path, ops);

    Ok(Json(RenameResult {
        renamed,
        errors,
        record_id: record.id,
    }))
}

async fn undo_last(
    State(state): State<Arc<AppState>>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let record = state
        .undo_manager
        .undo_last()
        .map_err(|e| ApiError(StatusCode::BAD_REQUEST, e))?;

    Ok(Json(serde_json::json!({
        "undone_id": record.id,
        "operations": record.operations.len(),
    })))
}

async fn get_history(
    State(state): State<Arc<AppState>>,
) -> Json<Vec<undo::RenameRecord>> {
    Json(state.undo_manager.get_history())
}
