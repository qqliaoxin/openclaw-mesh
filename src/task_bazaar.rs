use crate::store::Store;
use crate::util::now_iso;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use tokio::sync::Mutex;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskBounty {
    pub amount: i64,
    pub token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskBid {
    pub node_id: String,
    pub amount: i64,
    pub timestamp: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub task_id: String,
    pub description: String,
    #[serde(rename = "type")]
    pub task_type: Option<String>,
    pub bounty: TaskBounty,
    pub tags: Vec<String>,
    pub publisher: String,
    pub status: String,
    pub submissions: Vec<serde_json::Value>,
    pub bids: Vec<TaskBid>,
    #[serde(alias = "published_at")]
    pub published_at: String,
    #[serde(alias = "voting_started_at")]
    pub voting_started_at: Option<i64>,
    #[serde(alias = "assigned_to")]
    pub assigned_to: Option<String>,
    #[serde(alias = "assigned_at")]
    pub assigned_at: Option<i64>,
    pub winner: Option<String>,
    #[serde(alias = "completed_at")]
    pub completed_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskStats {
    pub total: usize,
    pub open: usize,
    pub completed: usize,
    pub total_rewards: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BalanceStats {
    pub available: i64,
    pub locked: i64,
}

pub struct TaskBazaar {
    pub node_id: String,
    store: Arc<Mutex<Store>>,
    tasks: HashMap<String, Task>,
    completed_tasks: HashSet<String>,
}

impl TaskBazaar {
    pub fn new(node_id: String, store: Arc<Mutex<Store>>) -> Self {
        Self {
            node_id,
            store,
            tasks: HashMap::new(),
            completed_tasks: HashSet::new(),
        }
    }

    pub async fn publish_task(&mut self, mut task: Task) -> Result<String, String> {
        if task.description.trim().is_empty() {
            return Err("Invalid task: missing description".to_string());
        }
        if task.bounty.amount <= 0 {
            return Err("Invalid task: missing bounty".to_string());
        }
        if task.task_id.is_empty() {
            task.task_id = format!("task_{}", crate::util::random_hex(8));
        }
        if task.publisher.is_empty() {
            task.publisher = self.node_id.clone();
        }
        if task.bounty.token.is_empty() {
            task.bounty.token = "CLAW".to_string();
        }
        let published_at = now_iso();
        task.published_at = published_at;
        task.status = "open".to_string();
        task.submissions = Vec::new();
        task.bids = Vec::new();

        let mut store = self.store.lock().await;
        let publisher_account = store.ensure_account(&task.publisher, "gep-lite-v1")?;
        store.lock_escrow(&task.task_id, &publisher_account.account_id, task.bounty.amount, &task.bounty.token)?;

        let task_id = task.task_id.clone();
        self.tasks.insert(task_id.clone(), task);
        Ok(task_id)
    }

    pub async fn handle_new_task(&mut self, mut task: Task) {
        if self.tasks.contains_key(&task.task_id) {
            return;
        }
        task.status = "open".to_string();
        task.submissions = Vec::new();
        task.bids = Vec::new();
        self.tasks.insert(task.task_id.clone(), task);
    }

    pub async fn submit_solution(
        &mut self,
        task_id: &str,
        solution: serde_json::Value,
        solver_node_id: &str,
    ) -> Result<serde_json::Value, String> {
        let task = self.tasks.get_mut(task_id).ok_or("Task not found")?;
        if task.status != "open" && task.status != "assigned" {
            return Err("Task is not open".to_string());
        }
        if self.completed_tasks.contains(task_id) {
            return Ok(serde_json::json!({ "success": false, "reason": "Task already completed" }));
        }
        let valid = Self::validate_solution(task, &solution);
        if !valid {
            return Ok(serde_json::json!({ "success": false, "reason": "Invalid solution" }));
        }
        self.completed_tasks.insert(task_id.to_string());
        task.status = "completed".to_string();
        task.winner = Some(solver_node_id.to_string());
        task.completed_at = Some(now_iso());

        let mut store = self.store.lock().await;
        let winner_account = store.ensure_account(solver_node_id, "gep-lite-v1")?;
        let reward = store.release_escrow(task_id, &winner_account.account_id)?;
        Ok(serde_json::json!({ "success": true, "winner": true, "reward": reward }))
    }

    pub fn update_task(&mut self, task_id: &str, updates: serde_json::Value) -> Option<Task> {
        let task = self.tasks.get_mut(task_id)?;
        if let Some(status) = updates.get("status").and_then(|v| v.as_str()) {
            task.status = status.to_string();
        }
        if let Some(bids) = updates.get("bids").and_then(|v| v.as_array()) {
            task.bids = bids
                .iter()
                .filter_map(|b| serde_json::from_value::<TaskBid>(b.clone()).ok())
                .collect();
        }
        if let Some(assigned) = updates.get("assigned_to").and_then(|v| v.as_str()) {
            task.assigned_to = Some(assigned.to_string());
        }
        if let Some(at) = updates.get("assigned_at").and_then(|v| v.as_i64()) {
            task.assigned_at = Some(at);
        }
        if let Some(vote) = updates.get("voting_started_at").and_then(|v| v.as_i64()) {
            task.voting_started_at = Some(vote);
        }
        Some(task.clone())
    }

    pub fn get_tasks(&self) -> Vec<Task> {
        let mut tasks: Vec<Task> = self.tasks.values().cloned().collect();
        tasks.sort_by(|a, b| b.published_at.cmp(&a.published_at));
        tasks
    }

    pub fn get_task(&self, task_id: &str) -> Option<Task> {
        self.tasks.get(task_id).cloned()
    }

    pub fn get_task_count(&self) -> usize {
        self.tasks.len()
    }

    pub fn get_stats(&self) -> TaskStats {
        let tasks: Vec<Task> = self.tasks.values().cloned().collect();
        TaskStats {
            total: tasks.len(),
            open: tasks.iter().filter(|t| t.status == "open").count(),
            completed: tasks.iter().filter(|t| t.status == "completed").count(),
            total_rewards: tasks
                .iter()
                .filter(|t| t.status == "completed")
                .map(|t| t.bounty.amount)
                .sum(),
        }
    }

    pub async fn get_balance(&self) -> Result<BalanceStats, String> {
        let store = self.store.lock().await;
        let available = store.get_balance(&self.node_id)?;
        let node_account_id = store.get_account_id_by_node(&self.node_id)?.unwrap_or_default();
        let locked = store
            .list_escrows()?
            .into_iter()
            .filter(|e| e.from_account_id == node_account_id)
            .map(|e| e.amount)
            .sum();
        Ok(BalanceStats { available, locked })
    }

    pub fn add_bid(&mut self, task_id: &str, bid: TaskBid) -> Option<Task> {
        let task = self.tasks.get_mut(task_id)?;
        if task.bids.iter().any(|b| b.node_id == bid.node_id) {
            return Some(task.clone());
        }
        task.bids.push(bid);
        if task.status == "open" {
            task.status = "voting".to_string();
            task.voting_started_at = Some(chrono::Utc::now().timestamp_millis());
        }
        Some(task.clone())
    }

    pub fn determine_winner(&self, task: &Task) -> Option<TaskBid> {
        if task.bids.is_empty() {
            return None;
        }
        let mut bids = task.bids.clone();
        bids.sort_by(|a, b| {
            if a.amount != b.amount {
                a.amount.cmp(&b.amount)
            } else {
                a.timestamp.cmp(&b.timestamp)
            }
        });
        bids.first().cloned()
    }

    fn validate_solution(task: &Task, solution: &serde_json::Value) -> bool {
        if solution.get("code").is_none() && solution.get("description").is_none() {
            return false;
        }
        if let Some(task_type) = &task.task_type {
            if task_type == "code" {
                if let Some(code) = solution.get("code").and_then(|v| v.as_str()) {
                    return code.len() > 10;
                }
            }
        }
        true
    }
}
