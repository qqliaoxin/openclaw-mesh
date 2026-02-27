use crate::util::{now_iso, random_hex, sha256_hex, tokenize};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sled::{Db, Tree};
use std::collections::{HashSet};
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub account_id: String,
    pub node_id: String,
    pub algorithm: String,
    pub seed_hash: String,
    pub created_at: String,
    pub imported_at: Option<String>,
    pub balance: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LedgerEntry {
    pub index: u64,
    pub prev_hash: String,
    pub hash: String,
    pub timestamp: i64,
    pub entry_type: String,
    pub account_id: Option<String>,
    pub node_id: Option<String>,
    pub from: Option<String>,
    pub to: Option<String>,
    pub amount: i64,
    pub meta: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CapsuleSnapshot {
    pub asset_id: String,
    pub capsule: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Snapshot {
    pub capsules: Vec<CapsuleSnapshot>,
    pub accounts: Vec<Account>,
    pub account_index: Vec<(String, String)>,
    pub ledger: Vec<LedgerEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Escrow {
    pub task_id: String,
    pub from_account_id: String,
    pub amount: i64,
    pub token: String,
    pub created_at: String,
}

#[derive(Debug, Clone)]
pub struct CapsuleFilter {
    pub capsule_type: Option<String>,
    pub tags: Vec<String>,
    pub query: Option<String>,
    pub min_confidence: Option<f64>,
}

pub struct Store {
    #[allow(dead_code)]
    pub node_id: String,
    pub is_genesis_node: bool,
    pub genesis_operator_account_id: Option<String>,
    #[allow(dead_code)]
    pub data_dir: String,
    #[allow(dead_code)]
    db: Db,
    accounts: Tree,
    account_index: Tree,
    ledger: Tree,
    capsules: Tree,
    capsule_index: Tree,
    escrows: Tree,
}

impl Store {
    pub fn open(
        data_dir: String,
        node_id: String,
        is_genesis_node: bool,
        genesis_operator_account_id: Option<String>,
    ) -> Result<Self, String> {
        fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
        let db_path = PathBuf::from(&data_dir).join("kv");
        let db = sled::open(db_path).map_err(|e| e.to_string())?;
        let accounts = db.open_tree("accounts").map_err(|e| e.to_string())?;
        let account_index = db.open_tree("account_index").map_err(|e| e.to_string())?;
        let ledger = db.open_tree("ledger").map_err(|e| e.to_string())?;
        let capsules = db.open_tree("capsules").map_err(|e| e.to_string())?;
        let capsule_index = db.open_tree("capsule_index").map_err(|e| e.to_string())?;
        let escrows = db.open_tree("escrows").map_err(|e| e.to_string())?;
        let mut store = Self {
            node_id,
            is_genesis_node,
            genesis_operator_account_id,
            data_dir,
            db,
            accounts,
            account_index,
            ledger,
            capsules,
            capsule_index,
            escrows,
        };
        if store.is_genesis_node {
            store.ensure_genesis_account()?;
        }
        Ok(store)
    }

    pub fn ensure_account(&mut self, node_id: &str, algorithm: &str) -> Result<Account, String> {
        if let Some(account_id) = self.get_account_id_by_node(node_id)? {
            return self.get_account(&account_id);
        }
        let account_id = format!("acct_{}", random_hex(8));
        let account = Account {
            account_id: account_id.clone(),
            node_id: node_id.to_string(),
            algorithm: algorithm.to_string(),
            seed_hash: sha256_hex(&format!("{}:{}", node_id, account_id)),
            created_at: now_iso(),
            imported_at: None,
            balance: 0,
        };
        self.put_account(&account)?;
        self.account_index
            .insert(node_id.as_bytes(), account_id.as_bytes())
            .map_err(|e| e.to_string())?;
        Ok(account)
    }

    pub fn export_account(&mut self, node_id: &str) -> Result<Account, String> {
        let account = self.ensure_account(node_id, "gep-lite-v1")?;
        Ok(account)
    }

    pub fn import_account(&mut self, node_id: &str, payload: &Account) -> Result<Account, String> {
        let mut imported = payload.clone();
        imported.node_id = node_id.to_string();
        imported.imported_at = Some(now_iso());
        self.put_account(&imported)?;
        self.account_index
            .insert(node_id.as_bytes(), imported.account_id.as_bytes())
            .map_err(|e| e.to_string())?;
        Ok(imported)
    }

    pub fn transfer(
        &mut self,
        from_account_id: &str,
        to_account_id: &str,
        amount: i64,
        operator_account_id: Option<String>,
    ) -> Result<(), String> {
        if amount <= 0 {
            return Err("Invalid amount".to_string());
        }
        let genesis_account = self.ensure_genesis_account()?;
        if from_account_id == genesis_account.account_id {
            let operator = self.genesis_operator_account_id.clone().ok_or("Genesis operator not configured")?;
            if Some(operator) != operator_account_id {
                return Err("Genesis account operator not authorized".to_string());
            }
        }
        let mut from_account = self.get_account(from_account_id)?;
        let mut to_account = self.get_account(to_account_id)?;
        if from_account.balance < amount {
            return Err("Insufficient balance".to_string());
        }
        from_account.balance -= amount;
        to_account.balance += amount;
        self.put_account(&from_account)?;
        self.put_account(&to_account)?;
        self.append_ledger("transfer", Some(from_account_id), Some(to_account_id), amount, json!({}))?;
        Ok(())
    }

    pub fn lock_escrow(
        &mut self,
        task_id: &str,
        from_account_id: &str,
        amount: i64,
        token: &str,
    ) -> Result<(), String> {
        if amount <= 0 {
            return Err("Invalid escrow amount".to_string());
        }
        let mut from_account = self.get_account(from_account_id)?;
        if from_account.balance < amount {
            return Err("Insufficient balance".to_string());
        }
        from_account.balance -= amount;
        self.put_account(&from_account)?;
        let escrow = Escrow {
            task_id: task_id.to_string(),
            from_account_id: from_account_id.to_string(),
            amount,
            token: token.to_string(),
            created_at: now_iso(),
        };
        let data = serde_json::to_vec(&escrow).map_err(|e| e.to_string())?;
        self.escrows
            .insert(task_id.as_bytes(), data)
            .map_err(|e| e.to_string())?;
        self.append_ledger(
            "escrow_locked",
            Some(from_account_id),
            None,
            amount,
            json!({ "taskId": task_id, "token": token }),
        )?;
        Ok(())
    }

    pub fn release_escrow(&mut self, task_id: &str, winner_account_id: &str) -> Result<i64, String> {
        let escrow = match self
            .escrows
            .get(task_id.as_bytes())
            .map_err(|e| e.to_string())?
        {
            Some(value) => serde_json::from_slice::<Escrow>(&value).map_err(|e| e.to_string())?,
            None => return Ok(0),
        };
        let mut winner = self.get_account(winner_account_id)?;
        winner.balance += escrow.amount;
        self.put_account(&winner)?;
        self.escrows.remove(task_id.as_bytes()).map_err(|e| e.to_string())?;
        self.append_ledger(
            "escrow_released",
            None,
            Some(winner_account_id),
            escrow.amount,
            json!({ "taskId": task_id, "token": escrow.token }),
        )?;
        Ok(escrow.amount)
    }

    pub fn get_balance(&self, node_id: &str) -> Result<i64, String> {
        let account_id = self
            .get_account_id_by_node(node_id)?
            .ok_or_else(|| "Account not found".to_string())?;
        let account = self.get_account(&account_id)?;
        Ok(account.balance)
    }

    pub fn store_capsule(&mut self, capsule: &Value) -> Result<String, String> {
        let serialized = serde_json::to_string(capsule).map_err(|e| e.to_string())?;
        let asset_id = sha256_hex(&serialized);
        self.capsules
            .insert(asset_id.as_bytes(), serialized.as_bytes())
            .map_err(|e| e.to_string())?;
        self.index_capsule(&asset_id, capsule)?;
        Ok(asset_id)
    }

    pub fn get_capsule(&self, asset_id: &str) -> Result<Option<Value>, String> {
        let value = match self.capsules.get(asset_id.as_bytes()).map_err(|e| e.to_string())? {
            Some(value) => value,
            None => return Ok(None),
        };
        let capsule: Value = serde_json::from_slice(&value).map_err(|e| e.to_string())?;
        Ok(Some(capsule))
    }

    pub fn query_capsules(&self, filter: CapsuleFilter) -> Result<Vec<CapsuleSnapshot>, String> {
        let mut candidate_ids: Option<HashSet<String>> = None;
        let mut tokens = Vec::new();
        if let Some(query) = &filter.query {
            tokens.extend(tokenize(query));
        }
        for tag in filter.tags.iter() {
            tokens.push(tag.to_ascii_lowercase());
        }
        for token in tokens {
            let ids = self.get_indexed_ids(&token)?;
            candidate_ids = match candidate_ids {
                None => Some(ids),
                Some(current) => Some(current.intersection(&ids).cloned().collect()),
            };
        }
        let mut results = Vec::new();
        match candidate_ids {
            Some(ids) => {
                for id in ids {
                    if let Some(snapshot) = self.get_capsule_snapshot(&id, &filter)? {
                        results.push(snapshot);
                    }
                }
            }
            None => {
                for item in self.capsules.iter() {
                    let (key, value) = item.map_err(|e| e.to_string())?;
                    let id = String::from_utf8(key.to_vec()).map_err(|e| e.to_string())?;
                    let capsule: Value = serde_json::from_slice(&value).map_err(|e| e.to_string())?;
                    if self.matches_capsule(&capsule, &filter) {
                        results.push(CapsuleSnapshot { asset_id: id, capsule });
                    }
                }
            }
        }
        Ok(results)
    }

    pub fn get_snapshot(&self) -> Result<Snapshot, String> {
        let mut capsules = Vec::new();
        for item in self.capsules.iter() {
            let (key, value) = item.map_err(|e| e.to_string())?;
            let asset_id = String::from_utf8(key.to_vec()).map_err(|e| e.to_string())?;
            let capsule: Value = serde_json::from_slice(&value).map_err(|e| e.to_string())?;
            let mut capsule_value = capsule.clone();
            if let Some(obj) = capsule_value.as_object_mut() {
                obj.insert("content".to_string(), Value::Null);
            }
            capsules.push(CapsuleSnapshot { asset_id, capsule: capsule_value });
        }
        let accounts = self.list_accounts()?;
        let account_index = self.list_account_index()?;
        let ledger = self.list_ledger()?;
        Ok(Snapshot { capsules, accounts, account_index, ledger })
    }

    pub fn list_accounts(&self) -> Result<Vec<Account>, String> {
        let mut accounts = Vec::new();
        for item in self.accounts.iter() {
            let (_, value) = item.map_err(|e| e.to_string())?;
            let account: Account = serde_json::from_slice(&value).map_err(|e| e.to_string())?;
            accounts.push(account);
        }
        Ok(accounts)
    }

    pub fn list_escrows(&self) -> Result<Vec<Escrow>, String> {
        let mut escrows = Vec::new();
        for item in self.escrows.iter() {
            let (_, value) = item.map_err(|e| e.to_string())?;
            let escrow: Escrow = serde_json::from_slice(&value).map_err(|e| e.to_string())?;
            escrows.push(escrow);
        }
        Ok(escrows)
    }

    pub fn list_account_index(&self) -> Result<Vec<(String, String)>, String> {
        let mut index = Vec::new();
        for item in self.account_index.iter() {
            let (key, value) = item.map_err(|e| e.to_string())?;
            let node_id = String::from_utf8(key.to_vec()).map_err(|e| e.to_string())?;
            let account_id = String::from_utf8(value.to_vec()).map_err(|e| e.to_string())?;
            index.push((node_id, account_id));
        }
        Ok(index)
    }

    pub fn list_ledger(&self) -> Result<Vec<LedgerEntry>, String> {
        let mut ledger = Vec::new();
        for item in self.ledger.iter() {
            let (_, value) = item.map_err(|e| e.to_string())?;
            let entry: LedgerEntry = serde_json::from_slice(&value).map_err(|e| e.to_string())?;
            ledger.push(entry);
        }
        ledger.sort_by_key(|entry| entry.index);
        Ok(ledger)
    }

    pub fn get_count(&self) -> usize {
        self.capsules.len()
    }

    pub fn get_account_id_by_node(&self, node_id: &str) -> Result<Option<String>, String> {
        Ok(self
            .account_index
            .get(node_id.as_bytes())
            .map_err(|e| e.to_string())?
            .map(|value| String::from_utf8(value.to_vec()).ok())
            .flatten())
    }

    fn get_account(&self, account_id: &str) -> Result<Account, String> {
        let value = self
            .accounts
            .get(account_id.as_bytes())
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "Account not found".to_string())?;
        serde_json::from_slice(&value).map_err(|e| e.to_string())
    }

    fn put_account(&self, account: &Account) -> Result<(), String> {
        let data = serde_json::to_vec(account).map_err(|e| e.to_string())?;
        self.accounts
            .insert(account.account_id.as_bytes(), data)
            .map_err(|e| e.to_string())?;
        self.persist_account_json(account)?;
        Ok(())
    }

    fn persist_account_json(&self, account: &Account) -> Result<(), String> {
        let accounts_dir = PathBuf::from(&self.data_dir).join("accounts");
        fs::create_dir_all(&accounts_dir).map_err(|e| e.to_string())?;
        let json = serde_json::to_string_pretty(account).map_err(|e| e.to_string())?;
        let by_account_id = accounts_dir.join(format!("{}.json", account.account_id));
        fs::write(by_account_id, &json).map_err(|e| e.to_string())?;
        let by_node_id = accounts_dir.join(format!("{}.json", account.node_id));
        fs::write(by_node_id, &json).map_err(|e| e.to_string())?;
        if let Some(operator_id) = &self.genesis_operator_account_id {
            if operator_id == &account.account_id {
                let operator_file = PathBuf::from(&self.data_dir).join("genesis_operator_account.json");
                fs::write(operator_file, &json).map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    }

    fn append_ledger(
        &mut self,
        entry_type: &str,
        from: Option<&str>,
        to: Option<&str>,
        amount: i64,
        meta: Value,
    ) -> Result<LedgerEntry, String> {
        let (index, prev_hash) = self.ledger_head()?;
        let timestamp = chrono::Utc::now().timestamp_millis();
        let mut payload = serde_json::json!({
            "index": index,
            "prev_hash": prev_hash,
            "timestamp": timestamp,
            "entry_type": entry_type,
            "from": from,
            "to": to,
            "amount": amount,
            "meta": meta
        });
        let hash = sha256_hex(&payload.to_string());
        payload["hash"] = Value::String(hash.clone());
        let entry: LedgerEntry = serde_json::from_value(payload).map_err(|e| e.to_string())?;
        let key = index.to_be_bytes();
        let data = serde_json::to_vec(&entry).map_err(|e| e.to_string())?;
        self.ledger.insert(key, data).map_err(|e| e.to_string())?;
        Ok(entry)
    }

    fn ledger_head(&self) -> Result<(u64, String), String> {
        if let Some(item) = self.ledger.last().map_err(|e| e.to_string())? {
            let (_, value) = item;
            let entry: LedgerEntry = serde_json::from_slice(&value).map_err(|e| e.to_string())?;
            Ok((entry.index + 1, entry.hash))
        } else {
            Ok((0, "".to_string()))
        }
    }

    fn ensure_genesis_account(&mut self) -> Result<Account, String> {
        if let Some(account_id) = self.get_account_id_by_node("node_genesis")? {
            return self.get_account(&account_id);
        }
        let account = Account {
            account_id: "acct_genesis".to_string(),
            node_id: "node_genesis".to_string(),
            algorithm: "genesis".to_string(),
            seed_hash: sha256_hex("genesis"),
            created_at: now_iso(),
            imported_at: None,
            balance: 0,
        };
        self.put_account(&account)?;
        self.account_index
            .insert("node_genesis".as_bytes(), account.account_id.as_bytes())
            .map_err(|e| e.to_string())?;
        if self.ledger.is_empty() {
            let supply = std::env::var("OPENCLAW_GENESIS_SUPPLY")
                .ok()
                .and_then(|v| v.parse::<i64>().ok())
                .unwrap_or(1_000_000);
            let mut entry = self.append_ledger("mint", None, Some(&account.account_id), supply, json!({}))?;
            entry.account_id = Some(account.account_id.clone());
            let key = entry.index.to_be_bytes();
            let data = serde_json::to_vec(&entry).map_err(|e| e.to_string())?;
            self.ledger.insert(key, data).map_err(|e| e.to_string())?;
            let mut updated = account.clone();
            updated.balance += supply;
            self.put_account(&updated)?;
            Ok(updated)
        } else {
            Ok(account)
        }
    }

    fn index_capsule(&mut self, asset_id: &str, capsule: &Value) -> Result<(), String> {
        let mut tokens = Vec::new();
        if let Some(tags) = capsule.get("tags").and_then(|v| v.as_array()) {
            for tag in tags {
                if let Some(tag_str) = tag.as_str() {
                    tokens.push(tag_str.to_ascii_lowercase());
                }
            }
        }
        if let Some(content) = capsule.get("content") {
            let content_text = content.to_string();
            tokens.extend(tokenize(&content_text));
        }
        tokens.sort();
        tokens.dedup();
        for token in tokens {
            let mut ids = self.get_indexed_ids(&token)?;
            ids.insert(asset_id.to_string());
            let data = serde_json::to_vec(&ids.iter().cloned().collect::<Vec<_>>()).map_err(|e| e.to_string())?;
            self.capsule_index
                .insert(token.as_bytes(), data)
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    fn get_indexed_ids(&self, token: &str) -> Result<HashSet<String>, String> {
        if let Some(value) = self
            .capsule_index
            .get(token.as_bytes())
            .map_err(|e| e.to_string())?
        {
            let ids: Vec<String> = serde_json::from_slice(&value).map_err(|e| e.to_string())?;
            Ok(ids.into_iter().collect())
        } else {
            Ok(HashSet::new())
        }
    }

    fn get_capsule_snapshot(&self, asset_id: &str, filter: &CapsuleFilter) -> Result<Option<CapsuleSnapshot>, String> {
        let value = match self.capsules.get(asset_id.as_bytes()).map_err(|e| e.to_string())? {
            Some(value) => value,
            None => return Ok(None),
        };
        let capsule: Value = serde_json::from_slice(&value).map_err(|e| e.to_string())?;
        if !self.matches_capsule(&capsule, filter) {
            return Ok(None);
        }
        Ok(Some(CapsuleSnapshot { asset_id: asset_id.to_string(), capsule }))
    }

    fn matches_capsule(&self, capsule: &Value, filter: &CapsuleFilter) -> bool {
        if let Some(capsule_type) = &filter.capsule_type {
            let value = capsule.get("type").and_then(|v| v.as_str()).unwrap_or("");
            if value != capsule_type {
                return false;
            }
        }
        if let Some(conf) = filter.min_confidence {
            let value = capsule
                .get("confidence")
                .and_then(|v| v.as_f64())
                .unwrap_or(0.0);
            if value < conf {
                return false;
            }
        }
        if !filter.tags.is_empty() {
            let tags: HashSet<String> = capsule
                .get("tags")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|t| t.as_str().map(|s| s.to_ascii_lowercase()))
                        .collect()
                })
                .unwrap_or_default();
            for tag in filter.tags.iter() {
                if !tags.contains(&tag.to_ascii_lowercase()) {
                    return false;
                }
            }
        }
        true
    }
}
