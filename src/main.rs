mod config;
mod p2p;
mod store;
mod task_bazaar;
mod task_worker;
mod util;
mod web;

use axum::Router;
use clap::{Parser, Subcommand};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::Mutex;

use config::Config;
use p2p::{DhtConfig, InboundMessage, MeshNode, WireMessage};
use store::{CapsuleFilter, Store};
use task_bazaar::{Task, TaskBazaar};
use task_worker::TaskWorker;
use web::AppState;

#[derive(Parser, Debug)]
#[command(name = "openclaw-mesh-rs")]
#[command(about = "OpenClaw Mesh Rust implementation")]
struct Cli {
    #[arg(long)]
    config: Option<PathBuf>,
    #[command(subcommand)]
    command: Option<Commands>,
}

#[derive(Subcommand, Debug)]
enum Commands {
    Init {
        #[arg(default_value = "MyNode")]
        name: String,
        #[arg(long, default_value_t = 0)]
        port: u16,
        #[arg(long, default_value_t = 3457)]
        web_port: u16,
        #[arg(long, default_value_t = 8)]
        dht_k: usize,
        #[arg(long, default_value_t = 3)]
        dht_alpha: usize,
        #[arg(long, default_value_t = 6)]
        dht_hops: i32,
        #[arg(long)]
        bootstrap: Option<String>,
        #[arg(long)]
        tags: Option<String>,
        #[arg(long)]
        master: Option<String>,
        #[arg(long)]
        genesis: bool,
    },
    Start,
}

#[tokio::main]
async fn main() {
    let cli = Cli::parse();
    match cli.command.unwrap_or(Commands::Start) {
        Commands::Init {
            name,
            port,
            web_port,
            dht_k,
            dht_alpha,
            dht_hops,
            bootstrap,
            tags,
            master,
            genesis,
        } => {
            let node_id = format!("node_{}", util::random_hex(8));
            let tags_vec = tags
                .map(|s| s.split(',').map(|t| t.trim().to_string()).collect::<Vec<_>>())
                .unwrap_or_default();
            let bootstrap_nodes = bootstrap.map(|b| vec![b]).unwrap_or_default();
            let mut cfg = Config {
                name,
                node_id: node_id.clone(),
                port,
                web_port,
                bootstrap_nodes,
                tags: tags_vec,
                data_dir: "./data".to_string(),
                master_url: master,
                is_genesis_node: genesis,
                genesis_operator_account_id: None,
                dht_k,
                dht_alpha,
                dht_hops,
                created_at: util::now_iso(),
            };
            // 创建 genesis 操作账户但不触发 LanceDB，使用 sled
            if genesis {
                let mut store = Store::open(
                    cfg.data_dir.clone(),
                    node_id.clone(),
                    true,
                    None,
                )
                .expect("open store");
                let operator = store.ensure_account(&node_id, "gep-lite-v1").expect("operator account");
                cfg.genesis_operator_account_id = Some(operator.account_id.clone());
                println!("🔐 Genesis operator account: {}", operator.account_id);
            }
            cfg.save(cli.config.clone()).expect("save config");
            println!("✅ Node initialized: {}", cfg.name);
            let path = cli.config.clone().unwrap_or_else(Config::default_path);
            println!("   Config: {}", path.display());
        }
        Commands::Start => {
            let cfg = Config::load(cli.config.clone()).expect("load config");
            let node_id = cfg.node_id.clone();
            let mut store = Store::open(
                cfg.data_dir.clone(),
                node_id.clone(),
                cfg.is_genesis_node,
                cfg.genesis_operator_account_id.clone(),
            )
            .expect("open store");

            // 确保当前节点账户存在
            let _ = store.ensure_account(&node_id, "gep-lite-v1");

            let store = Arc::new(Mutex::new(store));
            let task_bazaar = Arc::new(Mutex::new(TaskBazaar::new(node_id.clone(), store.clone())));
            let (inbound_tx, mut inbound_rx) = tokio::sync::mpsc::unbounded_channel::<InboundMessage>();
            let dht_config = DhtConfig {
                k: cfg.dht_k,
                alpha: cfg.dht_alpha,
                max_hops: cfg.dht_hops,
            };
            let mut mesh_node = MeshNode::new(node_id.clone(), cfg.port, cfg.bootstrap_nodes.clone(), inbound_tx, dht_config);
            if let Ok(port) = mesh_node.start().await {
                println!("📡 P2P node listening on port {}", port);
            }
            let mesh_node = Arc::new(mesh_node);

            let node_for_worker = mesh_node.clone();
            let bazaar_for_worker = task_bazaar.clone();
            let worker_node_id = node_id.clone();
            tokio::spawn(async move {
                let worker = TaskWorker::new(worker_node_id, node_for_worker, bazaar_for_worker);
                worker.start().await;
            });

            let store_for_inbound = store.clone();
            let bazaar_for_inbound = task_bazaar.clone();
            let node_for_inbound = mesh_node.clone();
            tokio::spawn(async move {
                while let Some(inbound) = inbound_rx.recv().await {
                    handle_inbound(inbound, store_for_inbound.clone(), bazaar_for_inbound.clone(), node_for_inbound.clone()).await;
                }
            });

            let state = AppState {
                store: store.clone(),
                task_bazaar: task_bazaar.clone(),
                node: mesh_node.clone(),
                node_id: node_id.clone(),
                start_time: std::time::Instant::now(),
                is_genesis: cfg.is_genesis_node,
            };
            let app: Router = web::router(state);
            let addr = SocketAddr::from(([0, 0, 0, 0], cfg.web_port));
            println!("🌐 WebUI server on http://127.0.0.1:{} (local)", cfg.web_port);
            println!("🌐 WebUI server on http://0.0.0.0:{} (all interfaces)", cfg.web_port);
            loop {
                let result = axum::Server::bind(&addr)
                    .serve(app.clone().into_make_service())
                    .await;
                if let Err(err) = result {
                    eprintln!("Web server stopped: {}", err);
                } else {
                    eprintln!("Web server stopped");
                }
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            }
        }
    }
}

async fn handle_inbound(
    inbound: InboundMessage,
    store: Arc<Mutex<Store>>,
    task_bazaar: Arc<Mutex<TaskBazaar>>,
    node: Arc<MeshNode>,
) {
    let message = inbound.message;
    match message.message_type.as_str() {
        "capsule" => {
            if let Ok(mut store) = store.try_lock() {
                let _ = store.store_capsule(&message.payload);
            } else {
                let mut store = store.lock().await;
                let _ = store.store_capsule(&message.payload);
            }
        }
        "task" => {
            if let Ok(task) = serde_json::from_value::<Task>(message.payload.clone()) {
                task_bazaar.lock().await.handle_new_task(task).await;
            }
        }
        "task_bid" => {
            let task_id = message.payload.get("taskId").and_then(|v| v.as_str()).unwrap_or("");
            if task_id.is_empty() {
                return;
            }
            let bid = message.payload.get("bid").cloned().unwrap_or(serde_json::json!({}));
            if let Ok(bid) = serde_json::from_value::<task_bazaar::TaskBid>(bid) {
                let mut bazaar = task_bazaar.lock().await;
                let updated = bazaar.add_bid(task_id, bid);
                if let Some(mut task) = updated {
                    if task.voting_started_at.is_none() {
                        task.voting_started_at = Some(chrono::Utc::now().timestamp_millis());
                        bazaar.update_task(task_id, serde_json::json!({ "voting_started_at": task.voting_started_at }));
                    }
                }
            }
        }
        "task_assigned" => {
            let task_id = message.payload.get("taskId").and_then(|v| v.as_str()).unwrap_or("");
            let assigned_to = message.payload.get("assignedTo").and_then(|v| v.as_str()).unwrap_or("");
            let assigned_at = message.payload.get("assignedAt").and_then(|v| v.as_i64()).unwrap_or(0);
            if !task_id.is_empty() {
                task_bazaar.lock().await.update_task(task_id, serde_json::json!({
                    "status": "assigned",
                    "assigned_to": assigned_to,
                    "assigned_at": assigned_at
                }));
            }
        }
        "task_completed" => {
            let task_id = message.payload.get("taskId").and_then(|v| v.as_str()).unwrap_or("");
            if !task_id.is_empty() {
                task_bazaar.lock().await.update_task(task_id, serde_json::json!({
                    "status": "completed"
                }));
            }
        }
        "query" => {
            let query_type = message.payload.get("type").and_then(|v| v.as_str()).unwrap_or("");
            if query_type == "memories" {
                let filter = message.payload.get("filter").cloned().unwrap_or(serde_json::json!({}));
                let capsule_filter = CapsuleFilter {
                    capsule_type: filter.get("type").and_then(|v| v.as_str()).map(|s| s.to_string()),
                    tags: filter.get("tags").and_then(|v| v.as_array()).map(|arr| {
                        arr.iter().filter_map(|t| t.as_str().map(|s| s.to_string())).collect()
                    }).unwrap_or_default(),
                    query: filter.get("query").and_then(|v| v.as_str()).map(|s| s.to_string()),
                    min_confidence: filter.get("min_confidence").and_then(|v| v.as_f64()),
                };
                let memories = store.lock().await.query_capsules(capsule_filter).unwrap_or_default();
                let response = WireMessage {
                    message_type: "query_response".to_string(),
                    payload: serde_json::json!({ "memories": memories }),
                    message_id: None,
                    hops_left: None,
                    request_id: message.request_id.clone(),
                    node_id: None,
                    port: None,
                    timestamp: Some(chrono::Utc::now().timestamp_millis()),
                };
                let _ = node.send_to_peer(&inbound.peer_id, response).await;
            }
        }
        _ => {}
    }
}
