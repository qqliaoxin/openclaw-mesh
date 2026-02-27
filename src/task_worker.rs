use crate::p2p::{MeshNode, WireMessage};
use crate::task_bazaar::{Task, TaskBazaar, TaskBid};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use tokio::sync::Mutex;
use tokio::time::{sleep, Duration};

pub struct TaskWorker {
    node_id: String,
    mesh: Arc<MeshNode>,
    task_bazaar: Arc<Mutex<TaskBazaar>>,
    bidding_tasks: HashMap<String, i64>,
    active_tasks: HashSet<String>,
}

impl TaskWorker {
    pub fn new(node_id: String, mesh: Arc<MeshNode>, task_bazaar: Arc<Mutex<TaskBazaar>>) -> Self {
        Self {
            node_id,
            mesh,
            task_bazaar,
            bidding_tasks: HashMap::new(),
            active_tasks: HashSet::new(),
        }
    }

    pub async fn start(mut self) {
        loop {
            self.check_tasks().await;
            self.process_voting().await;
            sleep(Duration::from_secs(5)).await;
        }
    }

    async fn check_tasks(&mut self) {
        let tasks = { self.task_bazaar.lock().await.get_tasks() };
        for task in tasks.into_iter().filter(|t| t.status == "open") {
            if self.active_tasks.contains(&task.task_id) {
                continue;
            }
            if self.bidding_tasks.contains_key(&task.task_id) {
                continue;
            }
            self.submit_bid(task).await;
        }
    }

    async fn submit_bid(&mut self, task: Task) {
        let bid_amount = (task.bounty.amount as f64 * 0.9) as i64;
        let bid = TaskBid {
            node_id: self.node_id.clone(),
            amount: bid_amount,
            timestamp: chrono::Utc::now().timestamp_millis(),
        };
        self.bidding_tasks.insert(task.task_id.clone(), bid.timestamp);
        let mut bazaar = self.task_bazaar.lock().await;
        let updated = bazaar.add_bid(&task.task_id, bid.clone());
        if updated.is_some() {
            let message = WireMessage {
                message_type: "task_bid".to_string(),
                payload: serde_json::json!({ "taskId": task.task_id, "bid": bid }),
                message_id: None,
                hops_left: Some(4),
                request_id: None,
                node_id: None,
                port: None,
                timestamp: Some(chrono::Utc::now().timestamp_millis()),
            };
            let _ = self.mesh.broadcast(message, None).await;
        }
    }

    async fn process_voting(&mut self) {
        let tasks = { self.task_bazaar.lock().await.get_tasks() };
        for task in tasks.into_iter().filter(|t| t.status == "voting") {
            let coordinator = task.publisher.clone();
            if coordinator != self.node_id {
                continue;
            }
            let started = task.voting_started_at.unwrap_or(task.bids.first().map(|b| b.timestamp).unwrap_or(0));
            let age = chrono::Utc::now().timestamp_millis() - started;
            if age < 5000 {
                continue;
            }
            let winner = { self.task_bazaar.lock().await.determine_winner(&task) };
            if let Some(winner) = winner {
                let assigned_at = chrono::Utc::now().timestamp_millis();
                {
                    let mut bazaar = self.task_bazaar.lock().await;
                    bazaar.update_task(&task.task_id, serde_json::json!({
                        "status": "assigned",
                        "assigned_to": winner.node_id,
                        "assigned_at": assigned_at
                    }));
                }
                let message = WireMessage {
                    message_type: "task_assigned".to_string(),
                    payload: serde_json::json!({
                        "taskId": task.task_id,
                        "assignedTo": winner.node_id,
                        "assignedAt": assigned_at
                    }),
                    message_id: None,
                    hops_left: Some(4),
                    request_id: None,
                    node_id: None,
                    port: None,
                    timestamp: Some(chrono::Utc::now().timestamp_millis()),
                };
                let mesh = self.mesh.clone();
                let local_id = self.node_id.clone();
                let _ = mesh.broadcast(message, None).await;
                if winner.node_id == local_id {
                    self.active_tasks.insert(task.task_id.clone());
                    self.complete_task(task.task_id.clone()).await;
                } else {
                    self.bidding_tasks.remove(&task.task_id);
                }
            }
        }
    }

    async fn complete_task(&mut self, task_id: String) {
        let solution = serde_json::json!({
            "description": "Auto-solved by TaskWorker",
            "code": "return true;"
        });
        let result = self
            .task_bazaar
            .lock()
            .await
            .submit_solution(&task_id, solution, &self.node_id)
            .await;
        if result.is_ok() {
            let message = WireMessage {
                message_type: "task_completed".to_string(),
                payload: serde_json::json!({ "taskId": task_id, "winner": self.node_id }),
                message_id: None,
                hops_left: Some(4),
                request_id: None,
                node_id: None,
                port: None,
                timestamp: Some(chrono::Utc::now().timestamp_millis()),
            };
            let _ = self.mesh.broadcast(message, None).await;
        }
        self.active_tasks.remove(&task_id);
    }
}
