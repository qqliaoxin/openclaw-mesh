use axum::{
    extract::{State, ws::{WebSocket, WebSocketUpgrade, Message}},
    response::IntoResponse,
    http::{header, StatusCode},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::Mutex;
use std::path::PathBuf;

use crate::p2p::MeshNode;
use crate::store::{Account, CapsuleFilter, Snapshot, Store};
use crate::task_bazaar::{Task, TaskBazaar, TaskBounty};
use crate::util::tokenize;

#[derive(Clone)]
pub struct AppState {
    pub store: Arc<Mutex<Store>>,
    pub task_bazaar: Arc<Mutex<TaskBazaar>>,
    pub node: Arc<MeshNode>,
    pub node_id: String,
    pub start_time: std::time::Instant,
    pub is_genesis: bool,
}

#[derive(Debug, Deserialize)]
pub struct TransferRequest {
    pub to_account_id: String,
    pub amount: i64,
    pub from_account_id: Option<String>,
    pub operator_account_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ImportRequest {
    pub account: Account,
}

#[derive(Debug, Deserialize)]
pub struct PublishCapsuleRequest {
    pub capsule: Value,
}

#[derive(Debug, Deserialize)]
pub struct PublishTaskRequest {
    pub description: String,
    pub bounty: Option<i64>,
    pub tags: Option<Vec<String>>,
    pub publisher: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct PurchaseCapsuleRequest {
    pub asset_id: String,
    pub buyer_node_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct QueryRequest {
    pub capsule_type: Option<String>,
    pub tags: Option<Vec<String>>,
    pub query: Option<String>,
    pub min_confidence: Option<f64>,
}

#[derive(Debug, Serialize)]
pub struct ApiResult<T> {
    pub success: bool,
    pub data: Option<T>,
    pub error: Option<String>,
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/", get(index))
        .route("/index.html", get(index))
        .route("/ws", get(ws_handler))
        .route("/api/status", get(status))
        .route("/api/account", get(account))
        .route("/api/account/export", get(export_account))
        .route("/api/account/import", post(import_account))
        .route("/api/account/transfer", post(transfer_account))
        .route("/api/memories", get(memories))
        .route("/api/tasks", get(tasks))
        .route("/api/peers", get(peers))
        .route("/api/tasks/:id/download", get(download_task))
        .route("/api/memory/:id", get(memory_by_id))
        .route("/api/stats", get(stats))
        .route("/api/memory/publish", post(publish_capsule))
        .route("/api/memory/query", post(query_capsules))
        .route("/api/task/publish", post(publish_task))
        .route("/api/capsule/purchase", post(purchase_capsule))
        .route("/api/snapshot", get(snapshot))
        .with_state(state)
}

async fn ws_handler(State(state): State<AppState>, ws: WebSocketUpgrade) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_ws(socket, state))
}

async fn handle_ws(mut socket: WebSocket, state: AppState) {
    let mut status_tick = tokio::time::interval(std::time::Duration::from_secs(5));
    let mut ping_tick = tokio::time::interval(std::time::Duration::from_secs(20));
    let initial = build_status(&state).await;
    let _ = socket.send(Message::Text(initial.to_string())).await;
    loop {
        tokio::select! {
            _ = status_tick.tick() => {
                let payload = build_status(&state).await;
                if socket.send(Message::Text(payload.to_string())).await.is_err() {
                    break;
                }
            }
            _ = ping_tick.tick() => {
                if socket.send(Message::Ping(Vec::new())).await.is_err() {
                    break;
                }
            }
            msg = socket.recv() => {
                match msg {
                    Some(Ok(Message::Ping(data))) => {
                        let _ = socket.send(Message::Pong(data)).await;
                    }
                    Some(Ok(Message::Text(text))) => {
                        if text.contains("\"type\":\"ping\"") || text.contains("\"type\": \"ping\"") {
                            let _ = socket.send(Message::Text(serde_json::json!({"type":"pong","ts": chrono::Utc::now().timestamp_millis()}).to_string())).await;
                        }
                    }
                    Some(Ok(_)) => {}
                    _ => break,
                }
            }
        }
    }
}

async fn build_status(state: &AppState) -> Value {
    let memory_count = {
        let store = state.store.lock().await;
        store.get_count()
    };
    let task_count = {
        let bazaar = state.task_bazaar.lock().await;
        bazaar.get_task_count()
    };
    json!({
        "type": "status",
        "data": {
            "nodeId": state.node_id.clone(),
            "peers": state.node.get_peers(),
            "memoryCount": memory_count,
            "taskCount": task_count,
            "uptime": state.start_time.elapsed().as_secs_f64()
        }
    })
}

async fn index() -> axum::response::Html<String> {
    let template = std::fs::read_to_string("web/server.js").unwrap_or_default();
    let start = template.find("return `").map(|i| i + 8).unwrap_or(0);
    let end = template.rfind("`;\n").unwrap_or(template.len());
    let mut html = template[start..end].to_string();
    html = html.replace("\\`", "`").replace("\\${", "${");
    html = html.replace(
        "ws://localhost:${this.port}",
        "ws://' + (window.location.hostname === '0.0.0.0' ? '127.0.0.1' : window.location.hostname) + (window.location.port ? ':' + window.location.port : '') + '/ws",
    );
    axum::response::Html(html)
}

async fn status(State(state): State<AppState>) -> Json<Value> {
    let store = state.store.lock().await;
    let task_count = state.task_bazaar.lock().await.get_task_count();
    Json(json!({
        "nodeId": state.node_id,
        "peers": state.node.get_peers(),
        "memoryCount": store.get_count(),
        "taskCount": task_count,
        "uptime": state.start_time.elapsed().as_secs_f64()
    }))
}

async fn account(State(state): State<AppState>) -> Json<Value> {
    let mut store = state.store.lock().await;
    let account = store.ensure_account(&state.node_id, "gep-lite-v1");
    match account {
        Ok(acc) => Json(json!(acc)),
        Err(err) => Json(json!({ "error": err })),
    }
}

async fn export_account(State(state): State<AppState>) -> Json<ApiResult<Account>> {
    let mut store = state.store.lock().await;
    match store.export_account(&state.node_id) {
        Ok(account) => Json(ApiResult { success: true, data: Some(account), error: None }),
        Err(err) => Json(ApiResult { success: false, data: None, error: Some(err) }),
    }
}

async fn import_account(
    State(state): State<AppState>,
    Json(payload): Json<ImportRequest>,
) -> Json<ApiResult<Account>> {
    let mut store = state.store.lock().await;
    match store.import_account(&state.node_id, &payload.account) {
        Ok(account) => Json(ApiResult { success: true, data: Some(account), error: None }),
        Err(err) => Json(ApiResult { success: false, data: None, error: Some(err) }),
    }
}

async fn transfer_account(
    State(state): State<AppState>,
    Json(payload): Json<TransferRequest>,
) -> Json<ApiResult<Value>> {
    let mut store = state.store.lock().await;
    let from_account = payload
        .from_account_id
        .clone()
        .or_else(|| store.get_account_id_by_node(&state.node_id).ok().flatten());
    let Some(from_account_id) = from_account else {
        return Json(ApiResult { success: false, data: None, error: Some("From account not found".to_string()) });
    };
    match store.transfer(
        &from_account_id,
        &payload.to_account_id,
        payload.amount,
        payload.operator_account_id.clone(),
    ) {
        Ok(_) => Json(ApiResult { success: true, data: Some(json!({"ok": true})), error: None }),
        Err(err) => Json(ApiResult { success: false, data: None, error: Some(err) }),
    }
}

async fn publish_capsule(
    State(state): State<AppState>,
    Json(payload): Json<PublishCapsuleRequest>,
) -> Json<ApiResult<Value>> {
    let asset_id = {
        let mut store = state.store.lock().await;
        store.store_capsule(&payload.capsule)
    };
    match asset_id {
        Ok(asset_id) => {
            let mut tokens = Vec::new();
            if let Some(tags) = payload.capsule.get("tags").and_then(|v| v.as_array()) {
                for tag in tags {
                    if let Some(tag_str) = tag.as_str() {
                        tokens.push(tag_str.to_ascii_lowercase());
                    }
                }
            }
            if let Some(content) = payload.capsule.get("content") {
                tokens.extend(tokenize(&content.to_string()));
            }
            let _ = state
                .node
                .dht_store(format!("capsule:{}", asset_id), payload.capsule.clone())
                .await;
            for token in tokens {
                let _ = state
                    .node
                    .dht_store(format!("token:{}", token), json!([asset_id]))
                    .await;
            }
            Json(ApiResult { success: true, data: Some(json!({ "asset_id": asset_id })), error: None })
        }
        Err(err) => Json(ApiResult { success: false, data: None, error: Some(err) }),
    }
}

async fn query_capsules(
    State(state): State<AppState>,
    Json(payload): Json<QueryRequest>,
) -> Json<ApiResult<Value>> {
    let filter = CapsuleFilter {
        capsule_type: payload.capsule_type,
        tags: payload.tags.unwrap_or_default(),
        query: payload.query,
        min_confidence: payload.min_confidence,
    };
    let filter_json = json!({
        "type": filter.capsule_type.clone(),
        "tags": filter.tags.clone(),
        "query": filter.query.clone(),
        "min_confidence": filter.min_confidence
    });
    if !filter.tags.is_empty() || filter.query.is_some() {
        if let Ok(capsules) = state.node.query_memories(filter_json).await {
            let mut store = state.store.lock().await;
            for capsule in capsules {
                let _ = store.store_capsule(&capsule);
            }
        }
    }
    let store = state.store.lock().await;
    match store.query_capsules(filter) {
        Ok(capsules) => Json(ApiResult { success: true, data: Some(json!({ "capsules": capsules })), error: None }),
        Err(err) => Json(ApiResult { success: false, data: None, error: Some(err) }),
    }
}

async fn snapshot(State(state): State<AppState>) -> Json<Snapshot> {
    let store = state.store.lock().await;
    let snapshot = store.get_snapshot().unwrap_or(Snapshot {
        capsules: vec![],
        accounts: vec![],
        account_index: vec![],
        ledger: vec![],
    });
    Json(snapshot)
}

async fn memories(State(state): State<AppState>) -> Json<Value> {
    let store = state.store.lock().await;
    let filter = CapsuleFilter {
        capsule_type: None,
        tags: vec![],
        query: None,
        min_confidence: None,
    };
    let mut memories = store.query_capsules(filter).unwrap_or_default();
    if !state.is_genesis {
        for capsule in memories.iter_mut() {
            if let Some(obj) = capsule.capsule.as_object_mut() {
                obj.insert("content".to_string(), Value::Null);
            }
        }
    }
    memories.truncate(50);
    Json(json!(memories))
}

async fn memory_by_id(State(state): State<AppState>, axum::extract::Path(id): axum::extract::Path<String>) -> Json<Value> {
    let store = state.store.lock().await;
    match store.get_capsule(&id) {
        Ok(Some(mut capsule)) => {
            if !state.is_genesis {
                if let Some(obj) = capsule.as_object_mut() {
                    obj.insert("content".to_string(), Value::Null);
                }
            }
            Json(json!(capsule))
        }
        Ok(None) => Json(json!(null)),
        Err(err) => Json(json!({ "error": err })),
    }
}

async fn tasks(State(state): State<AppState>) -> Json<Value> {
    let bazaar = state.task_bazaar.lock().await;
    Json(json!(bazaar.get_tasks()))
}

async fn peers(State(state): State<AppState>) -> Json<Value> {
    Json(json!(state.node.get_peers()))
}

async fn stats(State(state): State<AppState>) -> Json<Value> {
    let store = state.store.lock().await;
    let task_stats = state.task_bazaar.lock().await.get_stats();
    let balance = state.task_bazaar.lock().await.get_balance().await.unwrap_or(crate::task_bazaar::BalanceStats {
        available: 0,
        locked: 0,
    });
    Json(json!({
        "memories": { "count": store.get_count() },
        "tasks": task_stats,
        "balance": balance
    }))
}

async fn publish_task(
    State(state): State<AppState>,
    Json(payload): Json<PublishTaskRequest>,
) -> Json<Value> {
    let bounty_amount = payload.bounty.unwrap_or(100);
    let task = Task {
        task_id: String::new(),
        description: payload.description,
        task_type: None,
        bounty: TaskBounty { amount: bounty_amount, token: "CLAW".to_string() },
        tags: payload.tags.unwrap_or_default(),
        publisher: payload.publisher.unwrap_or_else(|| state.node_id.clone()),
        status: "open".to_string(),
        submissions: vec![],
        bids: vec![],
        published_at: String::new(),
        voting_started_at: None,
        assigned_to: None,
        assigned_at: None,
        winner: None,
        completed_at: None,
    };
    let result = state.task_bazaar.lock().await.publish_task(task).await;
    match result {
        Ok(task_id) => {
            let task = state.task_bazaar.lock().await.get_task(&task_id);
            if let Some(task) = task.clone() {
                let _ = state.node.broadcast_task(serde_json::json!(task)).await;
            }
            Json(json!({ "success": true, "task": task, "taskId": task_id }))
        }
        Err(err) => Json(json!({ "error": err })),
    }
}

async fn purchase_capsule(
    State(state): State<AppState>,
    Json(payload): Json<PurchaseCapsuleRequest>,
) -> Json<Value> {
    let buyer_node_id = payload.buyer_node_id.unwrap_or_else(|| state.node_id.clone());
    let mut store = state.store.lock().await;
    let operator_account_id = store.genesis_operator_account_id.clone();
    let capsule = match store.get_capsule(&payload.asset_id) {
        Ok(Some(capsule)) => capsule,
        Ok(None) => return Json(json!({ "error": "Capsule not found" })),
        Err(err) => return Json(json!({ "error": err })),
    };
    let price = capsule
        .get("price")
        .and_then(|v| v.get("amount"))
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    if price > 0 {
        let creator = capsule
            .get("attribution")
            .and_then(|v| v.get("creator"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if !creator.is_empty() && creator != buyer_node_id {
            let buyer_account = store.ensure_account(&buyer_node_id, "gep-lite-v1").ok();
            let creator_account = store.ensure_account(creator, "gep-lite-v1").ok();
            if let (Some(buyer_account), Some(creator_account)) = (buyer_account, creator_account) {
                let share = capsule
                    .get("price")
                    .and_then(|v| v.get("creatorShare"))
                    .and_then(|v| v.as_f64())
                    .unwrap_or(0.9);
                let creator_amount = (price as f64 * share).floor() as i64;
                let platform_amount = price - creator_amount;
                let _ = store.transfer(&buyer_account.account_id, &creator_account.account_id, creator_amount, None);
                if platform_amount > 0 {
                    let genesis = store.ensure_account("node_genesis", "genesis").ok();
                    if let Some(genesis) = genesis {
                        let _ = store.transfer(&buyer_account.account_id, &genesis.account_id, platform_amount, operator_account_id.clone());
                    }
                }
            }
        }
    }
    Json(json!({ "success": true, "capsule": capsule }))
}

async fn download_task(axum::extract::Path(id): axum::extract::Path<String>) -> axum::response::Response {
    let base = PathBuf::from("task-workspace").join("completed");
    if !base.exists() {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "Package not found", "taskId": id }))).into_response();
    }
    let mut zip_path: Option<PathBuf> = None;
    if let Ok(entries) = std::fs::read_dir(&base) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                if let Some(name) = path.file_name().and_then(|v| v.to_str()) {
                    if name.contains(&id) {
                        let candidate = path.join(format!("{}.zip", id));
                        if candidate.exists() {
                            zip_path = Some(candidate);
                            break;
                        }
                    }
                }
            }
        }
    }
    if let Some(zip_path) = zip_path {
        match std::fs::read(&zip_path) {
            Ok(bytes) => {
                let mut response = axum::response::Response::new(axum::body::Body::from(bytes));
                *response.status_mut() = StatusCode::OK;
                response.headers_mut().insert(header::CONTENT_TYPE, "application/zip".parse().unwrap());
                response.headers_mut().insert(
                    header::CONTENT_DISPOSITION,
                    format!("attachment; filename=\"{}.zip\"", id).parse().unwrap(),
                );
                response.into_response()
            }
            Err(_) => (StatusCode::NOT_FOUND, Json(json!({ "error": "Package not found", "taskId": id }))).into_response(),
        }
    } else {
        (StatusCode::NOT_FOUND, Json(json!({ "error": "Package not found", "taskId": id }))).into_response()
    }
}
