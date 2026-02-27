use rand::seq::SliceRandom;
use crate::util::tokenize;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, oneshot};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WireMessage {
    #[serde(rename = "type")]
    pub message_type: String,
    pub payload: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hops_left: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timestamp: Option<i64>,
}

#[derive(Debug, Clone)]
pub struct InboundMessage {
    pub peer_id: String,
    pub message: WireMessage,
}

#[derive(Clone)]
pub struct MeshNode {
    pub node_id: String,
    pub port: u16,
    pub bootstrap_nodes: Vec<String>,
    peers: Arc<Mutex<HashMap<String, PeerHandle>>>,
    pending_pings: Arc<Mutex<HashMap<String, PendingPing>>>,
    seen_messages: Arc<Mutex<HashMap<String, i64>>>,
    query_waiters: Arc<Mutex<HashMap<String, oneshot::Sender<Value>>>>,
    dht_waiters: Arc<Mutex<HashMap<String, oneshot::Sender<Option<Value>>>>>,
    dht_routes: Arc<Mutex<HashMap<String, String>>>,
    dht_store: Arc<Mutex<HashMap<String, Value>>>,
    inbound_tx: mpsc::UnboundedSender<InboundMessage>,
    seen_ttl_ms: i64,
    max_seen_messages: usize,
    default_fanout: usize,
    task_fanout: usize,
    default_hops: i32,
    task_hops: i32,
    dht_k: usize,
    dht_alpha: usize,
    dht_max_hops: i32,
}

#[derive(Clone)]
struct PeerHandle {
    sender: mpsc::UnboundedSender<String>,
    rtt: Option<i64>,
    addr: String,
}

struct PendingPing {
    peer_id: String,
    sent_at: i64,
}

#[derive(Debug, Clone)]
pub struct DhtConfig {
    pub k: usize,
    pub alpha: usize,
    pub max_hops: i32,
}

impl MeshNode {
    pub fn new(
        node_id: String,
        port: u16,
        bootstrap_nodes: Vec<String>,
        inbound_tx: mpsc::UnboundedSender<InboundMessage>,
        dht_config: DhtConfig,
    ) -> Self {
        Self {
            node_id,
            port,
            bootstrap_nodes,
            peers: Arc::new(Mutex::new(HashMap::new())),
            pending_pings: Arc::new(Mutex::new(HashMap::new())),
            seen_messages: Arc::new(Mutex::new(HashMap::new())),
            query_waiters: Arc::new(Mutex::new(HashMap::new())),
            dht_waiters: Arc::new(Mutex::new(HashMap::new())),
            dht_routes: Arc::new(Mutex::new(HashMap::new())),
            dht_store: Arc::new(Mutex::new(HashMap::new())),
            inbound_tx,
            seen_ttl_ms: 300_000,
            max_seen_messages: 10_000,
            default_fanout: 6,
            task_fanout: 8,
            default_hops: 3,
            task_hops: 4,
            dht_k: dht_config.k,
            dht_alpha: dht_config.alpha,
            dht_max_hops: dht_config.max_hops,
        }
    }

    pub async fn start(&mut self) -> Result<u16, String> {
        let addr = format!("0.0.0.0:{}", self.port);
        let listener = TcpListener::bind(&addr).await.map_err(|e| e.to_string())?;
        let local_port = listener.local_addr().map_err(|e| e.to_string())?.port();
        let peers = self.peers.clone();
        let pending_pings = self.pending_pings.clone();
        let seen_messages = self.seen_messages.clone();
        let query_waiters = self.query_waiters.clone();
        let dht_waiters = self.dht_waiters.clone();
        let dht_routes = self.dht_routes.clone();
        let dht_store = self.dht_store.clone();
        let inbound_tx = self.inbound_tx.clone();
        let node_id = self.node_id.clone();
        let port = local_port;
        let default_hops = self.default_hops;
        let task_hops = self.task_hops;
        let default_fanout = self.default_fanout;
        let task_fanout = self.task_fanout;
        let dht_k = self.dht_k;
        let dht_alpha = self.dht_alpha;
        let dht_max_hops = self.dht_max_hops;
        tokio::spawn(async move {
            loop {
                if let Ok((stream, remote_addr)) = listener.accept().await {
                    let peers = peers.clone();
                    let pending_pings = pending_pings.clone();
                    let seen_messages = seen_messages.clone();
                    let query_waiters = query_waiters.clone();
                    let dht_waiters = dht_waiters.clone();
                    let dht_routes = dht_routes.clone();
                    let dht_store = dht_store.clone();
                    let inbound_tx = inbound_tx.clone();
                    let node_id = node_id.clone();
                    tokio::spawn(async move {
                        let _ = Self::handle_connection(
                            stream,
                            remote_addr.to_string(),
                            node_id,
                            port,
                            peers,
                            pending_pings,
                            seen_messages,
                            query_waiters,
                            dht_waiters,
                            dht_routes,
                            dht_store,
                            inbound_tx,
                            default_hops,
                            task_hops,
                            default_fanout,
                            task_fanout,
                            dht_k,
                            dht_alpha,
                            dht_max_hops,
                        )
                        .await;
                    });
                }
            }
        });
        for peer in self.bootstrap_nodes.clone() {
            let node_id = self.node_id.clone();
            let peers = self.peers.clone();
            let pending_pings = self.pending_pings.clone();
            let seen_messages = self.seen_messages.clone();
            let query_waiters = self.query_waiters.clone();
            let dht_waiters = self.dht_waiters.clone();
            let dht_routes = self.dht_routes.clone();
            let dht_store = self.dht_store.clone();
            let inbound_tx = self.inbound_tx.clone();
            let default_hops = self.default_hops;
            let task_hops = self.task_hops;
            let default_fanout = self.default_fanout;
            let task_fanout = self.task_fanout;
            let dht_k = self.dht_k;
            let dht_alpha = self.dht_alpha;
            let dht_max_hops = self.dht_max_hops;
            tokio::spawn(async move {
                let _ = Self::connect(
                    peer,
                    node_id,
                    local_port,
                    peers,
                    pending_pings,
                    seen_messages,
                    query_waiters,
                    dht_waiters,
                    dht_routes,
                    dht_store,
                    inbound_tx,
                    default_hops,
                    task_hops,
                    default_fanout,
                    task_fanout,
                    dht_k,
                    dht_alpha,
                    dht_max_hops,
                )
                .await;
            });
        }
        self.start_heartbeat();
        Ok(local_port)
    }

    #[allow(dead_code)]
    pub async fn broadcast_capsule(&self, capsule: Value) -> Result<(), String> {
        let message = WireMessage {
            message_type: "capsule".to_string(),
            payload: capsule,
            message_id: None,
            hops_left: Some(self.default_hops),
            request_id: None,
            node_id: None,
            port: None,
            timestamp: Some(chrono::Utc::now().timestamp_millis()),
        };
        self.broadcast(message, None).await
    }

    pub async fn broadcast_task(&self, task: Value) -> Result<(), String> {
        let message = WireMessage {
            message_type: "task".to_string(),
            payload: task,
            message_id: None,
            hops_left: Some(self.task_hops),
            request_id: None,
            node_id: None,
            port: None,
            timestamp: Some(chrono::Utc::now().timestamp_millis()),
        };
        self.broadcast(message, None).await
    }

    pub async fn broadcast(&self, mut message: WireMessage, exclude_peer: Option<String>) -> Result<(), String> {
        let message_id = self.ensure_message_id(&mut message);
        self.mark_message_seen(&message_id);
        let fanout = match message.message_type.as_str() {
            "task" | "task_bid" | "task_assigned" | "task_completed" => self.task_fanout,
            _ => self.default_fanout,
        };
        let peers = self.select_peers(fanout, exclude_peer);
        for peer in peers {
            self.send_to_peer_sync(&peer, &message)?;
        }
        Ok(())
    }

    #[allow(dead_code)]
    pub async fn broadcast_all(&self, mut message: WireMessage, exclude_peer: Option<String>) -> Result<(), String> {
        let message_id = self.ensure_message_id(&mut message);
        self.mark_message_seen(&message_id);
        let peers = self.peers.lock().unwrap();
        for (peer_id, _) in peers.iter() {
            if let Some(exclude) = &exclude_peer {
                if peer_id == exclude {
                    continue;
                }
            }
            self.send_to_peer_sync(peer_id, &message)?;
        }
        Ok(())
    }

    pub async fn query_memories(&self, filter: Value) -> Result<Vec<Value>, String> {
        let mut tokens = Vec::new();
        if let Some(query) = filter.get("query").and_then(|v| v.as_str()) {
            tokens.extend(tokenize(query));
        }
        if let Some(tags) = filter.get("tags").and_then(|v| v.as_array()) {
            for tag in tags {
                if let Some(tag_str) = tag.as_str() {
                    tokens.push(tag_str.to_ascii_lowercase());
                }
            }
        }
        if tokens.is_empty() {
            return Ok(vec![]);
        }
        let mut candidate_ids: Option<HashSet<String>> = None;
        for token in tokens {
            let key = format!("token:{}", token);
            let value = self.dht_find(key).await?;
            let ids = match value {
                Some(Value::Array(list)) => list
                    .into_iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect::<HashSet<_>>(),
                _ => HashSet::new(),
            };
            candidate_ids = match candidate_ids {
                None => Some(ids),
                Some(current) => Some(current.intersection(&ids).cloned().collect()),
            };
        }
        let mut results = Vec::new();
        if let Some(ids) = candidate_ids {
            for asset_id in ids {
                let capsule_key = format!("capsule:{}", asset_id);
                if let Some(value) = self.dht_find(capsule_key).await? {
                    if Self::matches_capsule_filter(&value, &filter) {
                        results.push(value);
                    }
                }
            }
        }
        Ok(results)
    }

    pub async fn dht_store(&self, key: String, value: Value) -> Result<(), String> {
        Self::store_dht_value(&self.dht_store, &key, value.clone());
        let peers = Self::select_closest_peers(&self.peers, &key, self.dht_k.max(1), None);
        for peer in peers {
            if peer == self.node_id {
                continue;
            }
            let message = WireMessage {
                message_type: "dht_store".to_string(),
                payload: json!({ "key": key, "value": value }),
                message_id: None,
                hops_left: None,
                request_id: None,
                node_id: None,
                port: None,
                timestamp: Some(chrono::Utc::now().timestamp_millis()),
            };
            let _ = self.send_to_peer_sync(&peer, &message);
        }
        Ok(())
    }

    pub async fn dht_find(&self, key: String) -> Result<Option<Value>, String> {
        if let Some(value) = self.dht_store.lock().unwrap().get(&key).cloned() {
            return Ok(Some(value));
        }
        let request_id = crate::util::random_token(12);
        let (tx, rx) = oneshot::channel();
        self.dht_waiters.lock().unwrap().insert(request_id.clone(), tx);
        let peers = Self::select_closest_peers(&self.peers, &key, self.dht_alpha.max(1), None);
        for peer in peers {
            let message = WireMessage {
                message_type: "dht_find".to_string(),
                payload: json!({ "key": key, "origin": self.node_id }),
                message_id: None,
                hops_left: Some(self.dht_max_hops),
                request_id: Some(request_id.clone()),
                node_id: None,
                port: None,
                timestamp: Some(chrono::Utc::now().timestamp_millis()),
            };
            let _ = self.send_to_peer_sync(&peer, &message);
        }
        let response = tokio::time::timeout(std::time::Duration::from_secs(5), rx)
            .await
            .map_err(|_| "DHT query timeout".to_string())?
            .map_err(|_| "DHT query failed".to_string())?;
        Ok(response)
    }

    pub fn get_peers(&self) -> Vec<Value> {
        let peers = self.peers.lock().unwrap();
        peers
            .iter()
            .filter_map(|(peer_id, handle)| {
                if !peer_id.starts_with("node_") {
                    return None;
                }
                Some(json!({
                    "nodeId": peer_id,
                    "ip": handle.addr,
                    "connectedAt": chrono::Utc::now().timestamp_millis()
                }))
            })
            .collect()
    }

    async fn connect(
        addr: String,
        node_id: String,
        port: u16,
        peers: Arc<Mutex<HashMap<String, PeerHandle>>>,
        pending_pings: Arc<Mutex<HashMap<String, PendingPing>>>,
        seen_messages: Arc<Mutex<HashMap<String, i64>>>,
        query_waiters: Arc<Mutex<HashMap<String, oneshot::Sender<Value>>>>,
        dht_waiters: Arc<Mutex<HashMap<String, oneshot::Sender<Option<Value>>>>>,
        dht_routes: Arc<Mutex<HashMap<String, String>>>,
        dht_store: Arc<Mutex<HashMap<String, Value>>>,
        inbound_tx: mpsc::UnboundedSender<InboundMessage>,
        default_hops: i32,
        _task_hops: i32,
        default_fanout: usize,
        task_fanout: usize,
        _dht_k: usize,
        dht_alpha: usize,
        dht_max_hops: i32,
    ) -> Result<(), String> {
        let stream = TcpStream::connect(&addr).await.map_err(|e| e.to_string())?;
        Self::handle_connection(
            stream,
            addr,
            node_id,
            port,
            peers,
            pending_pings,
            seen_messages,
            query_waiters,
            dht_waiters,
            dht_routes,
            dht_store,
            inbound_tx,
            default_hops,
            _task_hops,
            default_fanout,
            task_fanout,
            _dht_k,
            dht_alpha,
            dht_max_hops,
        )
        .await
    }

    async fn handle_connection(
        stream: TcpStream,
        remote_key: String,
        node_id: String,
        port: u16,
        peers: Arc<Mutex<HashMap<String, PeerHandle>>>,
        pending_pings: Arc<Mutex<HashMap<String, PendingPing>>>,
        seen_messages: Arc<Mutex<HashMap<String, i64>>>,
        query_waiters: Arc<Mutex<HashMap<String, oneshot::Sender<Value>>>>,
        dht_waiters: Arc<Mutex<HashMap<String, oneshot::Sender<Option<Value>>>>>,
        dht_routes: Arc<Mutex<HashMap<String, String>>>,
        dht_store: Arc<Mutex<HashMap<String, Value>>>,
        inbound_tx: mpsc::UnboundedSender<InboundMessage>,
        default_hops: i32,
        _task_hops: i32,
        default_fanout: usize,
        task_fanout: usize,
        _dht_k: usize,
        dht_alpha: usize,
        dht_max_hops: i32,
    ) -> Result<(), String> {
        let (reader, mut writer) = stream.into_split();
        let mut reader = BufReader::new(reader);
        let (tx, mut rx) = mpsc::unbounded_channel::<String>();
        peers.lock().unwrap().insert(
            remote_key.clone(),
            PeerHandle {
                sender: tx.clone(),
                rtt: None,
                addr: remote_key.clone(),
            },
        );
        let handshake = WireMessage {
            message_type: "handshake".to_string(),
            payload: json!({}),
            message_id: None,
            hops_left: None,
            request_id: None,
            node_id: Some(node_id.clone()),
            port: Some(port),
            timestamp: Some(chrono::Utc::now().timestamp_millis()),
        };
        let handshake_text = serde_json::to_string(&handshake).map_err(|e| e.to_string())?;
        writer.write_all(handshake_text.as_bytes()).await.map_err(|e| e.to_string())?;
        writer.write_all(b"\n").await.map_err(|e| e.to_string())?;

        let peers_writer = peers.clone();
        tokio::spawn(async move {
            while let Some(msg) = rx.recv().await {
                if writer.write_all(msg.as_bytes()).await.is_err() {
                    break;
                }
                if writer.write_all(b"\n").await.is_err() {
                    break;
                }
            }
        });

        let mut line = String::new();
        let mut peer_id: Option<String> = None;
        loop {
            line.clear();
            let bytes = reader.read_line(&mut line).await.map_err(|e| e.to_string())?;
            if bytes == 0 {
                break;
            }
            let parsed: WireMessage = match serde_json::from_str(&line) {
                Ok(value) => value,
                Err(_) => continue,
            };
            let mut active_peer_id = peer_id.clone().unwrap_or_else(|| remote_key.clone());
            if parsed.message_type == "handshake" {
                if let Some(id) = parsed.node_id.clone() {
                    active_peer_id = id.clone();
                    peer_id = Some(id.clone());
                    if let Some(handle) = peers_writer.lock().unwrap().remove(&remote_key) {
                        peers_writer.lock().unwrap().insert(id.clone(), handle);
                    }
                    if !remote_key.contains(&node_id) {
                        let reply = WireMessage {
                            message_type: "handshake".to_string(),
                            payload: json!({}),
                            message_id: None,
                            hops_left: None,
                            request_id: None,
                            node_id: Some(node_id.clone()),
                            port: Some(port),
                            timestamp: Some(chrono::Utc::now().timestamp_millis()),
                        };
                        let reply_text = serde_json::to_string(&reply).map_err(|e| e.to_string())?;
                        let _ = tx.send(reply_text);
                    }
                }
            }
            let should_process = Self::should_process_message(&seen_messages, &parsed, default_hops);
            if !should_process {
                continue;
            }
            if parsed.message_type == "ping" {
                let pong = WireMessage {
                    message_type: "pong".to_string(),
                    payload: json!({}),
                    message_id: parsed.message_id.clone(),
                    hops_left: None,
                    request_id: None,
                    node_id: None,
                    port: None,
                    timestamp: Some(chrono::Utc::now().timestamp_millis()),
                };
                let pong_text = serde_json::to_string(&pong).map_err(|e| e.to_string())?;
                let _ = tx.send(pong_text);
                continue;
            }
            if parsed.message_type == "pong" {
                if let Some(ping_id) = parsed.message_id.clone() {
                    if let Some(pending) = pending_pings.lock().unwrap().remove(&ping_id) {
                        let rtt = chrono::Utc::now().timestamp_millis() - pending.sent_at;
                        if let Some(handle) = peers_writer.lock().unwrap().get_mut(&pending.peer_id) {
                            handle.rtt = Some(rtt);
                        }
                    }
                }
                continue;
            }
            if parsed.message_type == "query_response" {
                if let Some(request_id) = parsed.request_id.clone() {
                    if let Some(sender) = query_waiters.lock().unwrap().remove(&request_id) {
                        let _ = sender.send(parsed.payload.clone());
                    }
                }
                continue;
            }
            if parsed.message_type == "dht_store" {
                if let Some(key) = parsed.payload.get("key").and_then(|v| v.as_str()) {
                    if let Some(value) = parsed.payload.get("value") {
                        Self::store_dht_value(&dht_store, key, value.clone());
                    }
                }
                continue;
            }
            if parsed.message_type == "dht_find" {
                let key = parsed.payload.get("key").and_then(|v| v.as_str()).unwrap_or("").to_string();
                if key.is_empty() {
                    continue;
                }
                if let Some(request_id) = parsed.request_id.clone() {
                    dht_routes.lock().unwrap().insert(request_id.clone(), active_peer_id.clone());
                    if let Some(value) = dht_store.lock().unwrap().get(&key).cloned() {
                        let response = WireMessage {
                            message_type: "dht_value".to_string(),
                            payload: json!({ "key": key, "value": value }),
                            message_id: None,
                            hops_left: None,
                            request_id: Some(request_id),
                            node_id: None,
                            port: None,
                            timestamp: Some(chrono::Utc::now().timestamp_millis()),
                        };
                        let _ = Self::send_to_peer_static(&peers_writer, &active_peer_id, &response);
                        continue;
                    }
                }
                let hops_left = parsed.hops_left.unwrap_or(dht_max_hops);
                if hops_left <= 0 {
                    continue;
                }
                let mut relayed = parsed.clone();
                relayed.hops_left = Some(hops_left - 1);
                let peers = Self::select_closest_peers(&peers_writer, &key, dht_alpha.max(1), Some(active_peer_id));
                for peer in peers {
                    let _ = Self::send_to_peer_static(&peers_writer, &peer, &relayed);
                }
                continue;
            }
            if parsed.message_type == "dht_value" {
                if let Some(request_id) = parsed.request_id.clone() {
                    if let Some(sender) = dht_waiters.lock().unwrap().remove(&request_id) {
                        let value = parsed.payload.get("value").cloned();
                        let _ = sender.send(value);
                        dht_routes.lock().unwrap().remove(&request_id);
                        continue;
                    }
                    if let Some(prev) = dht_routes.lock().unwrap().remove(&request_id) {
                        let _ = Self::send_to_peer_static(&peers_writer, &prev, &parsed);
                        continue;
                    }
                }
            }
            let _ = inbound_tx.send(InboundMessage {
                peer_id: active_peer_id.clone(),
                message: parsed.clone(),
            });
            if Self::should_relay_message(&parsed) {
                let next_hops = parsed.hops_left.unwrap_or(default_hops) - 1;
                if next_hops >= 0 {
                    let mut relayed = parsed.clone();
                    relayed.hops_left = Some(next_hops);
                    let fanout = if relayed.message_type == "task" { task_fanout } else { default_fanout };
                    let peers = Self::select_peers_static(&peers_writer, fanout, Some(active_peer_id));
                    for peer in peers {
                        let _ = Self::send_to_peer_static(&peers_writer, &peer, &relayed);
                    }
                }
            }
        }
        if let Some(id) = peer_id {
            peers_writer.lock().unwrap().remove(&id);
        }
        Ok(())
    }

    pub async fn send_to_peer(&self, peer_id: &str, message: WireMessage) -> Result<(), String> {
        self.send_to_peer_sync(peer_id, &message)
    }

    fn send_to_peer_sync(&self, peer_id: &str, message: &WireMessage) -> Result<(), String> {
        Self::send_to_peer_static(&self.peers, peer_id, message)
    }

    fn send_to_peer_static(
        peers: &Arc<Mutex<HashMap<String, PeerHandle>>>,
        peer_id: &str,
        message: &WireMessage,
    ) -> Result<(), String> {
        let mut peers = peers.lock().unwrap();
        let handle = match peers.get(peer_id) {
            Some(handle) => handle.clone(),
            None => return Ok(()),
        };
        let text = serde_json::to_string(message).map_err(|e| e.to_string())?;
        if handle.sender.send(text).is_err() {
            peers.remove(peer_id);
        }
        Ok(())
    }

    fn ensure_message_id(&self, message: &mut WireMessage) -> String {
        if let Some(id) = &message.message_id {
            return id.clone();
        }
        let id = crate::util::random_token(12);
        message.message_id = Some(id.clone());
        id
    }

    fn mark_message_seen(&self, message_id: &str) {
        let mut seen = self.seen_messages.lock().unwrap();
        let now = chrono::Utc::now().timestamp_millis();
        seen.insert(message_id.to_string(), now);
        Self::cleanup_seen_messages(&mut seen, now, self.seen_ttl_ms, self.max_seen_messages);
    }

    fn cleanup_seen_messages(
        seen: &mut HashMap<String, i64>,
        now: i64,
        ttl_ms: i64,
        max_seen: usize,
    ) {
        seen.retain(|_, seen_at| now - *seen_at <= ttl_ms);
        while seen.len() > max_seen {
            if let Some(oldest) = seen.keys().next().cloned() {
                seen.remove(&oldest);
            } else {
                break;
            }
        }
    }

    fn should_process_message(
        seen_messages: &Arc<Mutex<HashMap<String, i64>>>,
        message: &WireMessage,
        default_hops: i32,
    ) -> bool {
        let id = match &message.message_id {
            Some(id) => id.clone(),
            None => return true,
        };
        let mut seen = seen_messages.lock().unwrap();
        if seen.contains_key(&id) {
            return false;
        }
        let now = chrono::Utc::now().timestamp_millis();
        seen.insert(id, now);
        Self::cleanup_seen_messages(&mut seen, now, 300_000, 10_000);
        if message.hops_left.unwrap_or(default_hops) < 0 {
            return false;
        }
        true
    }

    fn should_relay_message(message: &WireMessage) -> bool {
        if message.message_type == "handshake" || message.message_type == "ping" || message.message_type == "pong" {
            return false;
        }
        if message.message_type == "query" || message.message_type == "query_response" {
            return false;
        }
        if message.message_type.starts_with("dht_") {
            return false;
        }
        true
    }

    fn select_peers(&self, fanout: usize, exclude_peer: Option<String>) -> Vec<String> {
        Self::select_peers_static(&self.peers, fanout, exclude_peer)
    }

    fn select_closest_peers(
        peers: &Arc<Mutex<HashMap<String, PeerHandle>>>,
        key: &str,
        count: usize,
        exclude_peer: Option<String>,
    ) -> Vec<String> {
        let peers = peers.lock().unwrap();
        let key_hash = crate::util::hash_to_u64(key);
        let mut candidates: Vec<(String, u64)> = Vec::new();
        for (peer_id, _) in peers.iter() {
            if let Some(exclude) = &exclude_peer {
                if peer_id == exclude {
                    continue;
                }
            }
            if !peer_id.starts_with("node_") {
                continue;
            }
            let peer_hash = crate::util::hash_to_u64(peer_id);
            let distance = peer_hash ^ key_hash;
            candidates.push((peer_id.clone(), distance));
        }
        candidates.sort_by_key(|(_, dist)| *dist);
        candidates
            .into_iter()
            .take(count)
            .map(|(peer_id, _)| peer_id)
            .collect()
    }

    fn select_peers_static(
        peers: &Arc<Mutex<HashMap<String, PeerHandle>>>,
        fanout: usize,
        exclude_peer: Option<String>,
    ) -> Vec<String> {
        let peers = peers.lock().unwrap();
        let mut with_stats: Vec<(String, i64)> = Vec::new();
        let mut without_stats: Vec<String> = Vec::new();
        for (peer_id, handle) in peers.iter() {
            if let Some(exclude) = &exclude_peer {
                if peer_id == exclude {
                    continue;
                }
            }
            if let Some(rtt) = handle.rtt {
                with_stats.push((peer_id.clone(), rtt));
            } else {
                without_stats.push(peer_id.clone());
            }
        }
        with_stats.sort_by_key(|(_, rtt)| *rtt);
        if fanout == 0 {
            return with_stats.into_iter().map(|(id, _)| id).collect();
        }
        let mut ordered: Vec<String> = with_stats.into_iter().map(|(id, _)| id).collect();
        without_stats.shuffle(&mut rand::thread_rng());
        ordered.extend(without_stats);
        if fanout >= ordered.len() {
            ordered
        } else {
            ordered.into_iter().take(fanout).collect()
        }
    }

    fn store_dht_value(
        dht_store: &Arc<Mutex<HashMap<String, Value>>>,
        key: &str,
        value: Value,
    ) {
        let mut store = dht_store.lock().unwrap();
        match value {
            Value::Array(new_list) => {
                if let Some(existing) = store.get_mut(key) {
                    if let Value::Array(existing_list) = existing {
                        let mut seen: HashSet<String> = existing_list.iter().map(|v| v.to_string()).collect();
                        for item in &new_list {
                            let marker = item.to_string();
                            if !seen.contains(&marker) {
                                existing_list.push(item.clone());
                                seen.insert(marker);
                            }
                        }
                        return;
                    }
                }
                store.insert(key.to_string(), Value::Array(new_list));
            }
            other => {
                store.insert(key.to_string(), other);
            }
        }
    }

    fn matches_capsule_filter(capsule: &Value, filter: &Value) -> bool {
        if let Some(capsule_type) = filter.get("type").and_then(|v| v.as_str()) {
            let value = capsule.get("type").and_then(|v| v.as_str()).unwrap_or("");
            if value != capsule_type {
                return false;
            }
        }
        if let Some(conf) = filter.get("min_confidence").and_then(|v| v.as_f64()) {
            let value = capsule.get("confidence").and_then(|v| v.as_f64()).unwrap_or(0.0);
            if value < conf {
                return false;
            }
        }
        if let Some(tags) = filter.get("tags").and_then(|v| v.as_array()) {
            let capsule_tags: HashSet<String> = capsule
                .get("tags")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|t| t.as_str().map(|s| s.to_ascii_lowercase()))
                        .collect()
                })
                .unwrap_or_default();
            for tag in tags {
                if let Some(tag_str) = tag.as_str() {
                    if !capsule_tags.contains(&tag_str.to_ascii_lowercase()) {
                        return false;
                    }
                }
            }
        }
        true
    }

    fn start_heartbeat(&self) {
        let peers = self.peers.clone();
        let pending_pings = self.pending_pings.clone();
        tokio::spawn(async move {
            loop {
                let now = chrono::Utc::now().timestamp_millis();
                pending_pings.lock().unwrap().retain(|_, pending| now - pending.sent_at <= 15_000);
                let peer_ids: Vec<String> = peers.lock().unwrap().keys().cloned().collect();
                for peer_id in peer_ids {
                    let ping_id = crate::util::random_token(12);
                    pending_pings.lock().unwrap().insert(
                        ping_id.clone(),
                        PendingPing {
                            peer_id: peer_id.clone(),
                            sent_at: now,
                        },
                    );
                    let message = WireMessage {
                        message_type: "ping".to_string(),
                        payload: json!({}),
                        message_id: Some(ping_id),
                        hops_left: None,
                        request_id: None,
                        node_id: None,
                        port: None,
                        timestamp: Some(now),
                    };
                    let _ = Self::send_to_peer_static(&peers, &peer_id, &message);
                }
                tokio::time::sleep(std::time::Duration::from_secs(30)).await;
            }
        });
    }
}
