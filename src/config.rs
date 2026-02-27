use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    pub name: String,
    pub node_id: String,
    pub port: u16,
    pub web_port: u16,
    pub bootstrap_nodes: Vec<String>,
    pub tags: Vec<String>,
    pub data_dir: String,
    pub master_url: Option<String>,
    pub is_genesis_node: bool,
    pub genesis_operator_account_id: Option<String>,
    #[serde(default = "default_dht_k")]
    pub dht_k: usize,
    #[serde(default = "default_dht_alpha")]
    pub dht_alpha: usize,
    #[serde(default = "default_dht_hops")]
    pub dht_hops: i32,
    pub created_at: String,
}

fn default_dht_k() -> usize {
    8
}

fn default_dht_alpha() -> usize {
    3
}

fn default_dht_hops() -> i32 {
    6
}

impl Config {
    pub fn default_path() -> PathBuf {
        let home = std::env::var("HOME")
            .or_else(|_| std::env::var("USERPROFILE"))
            .unwrap_or_else(|_| ".".to_string());
        PathBuf::from(home).join(".openclaw-mesh.json")
    }

    pub fn load(path: Option<PathBuf>) -> Option<Self> {
        let file = path.unwrap_or_else(Self::default_path);
        if !file.exists() {
            return None;
        }
        let text = fs::read_to_string(file).ok()?;
        serde_json::from_str(&text).ok()
    }

    pub fn save(&self, path: Option<PathBuf>) -> std::io::Result<()> {
        let file = path.unwrap_or_else(Self::default_path);
        let text = serde_json::to_string_pretty(self).unwrap();
        fs::write(file, text)
    }
}
