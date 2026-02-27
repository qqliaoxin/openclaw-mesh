use rand::{distributions::Alphanumeric, Rng};
use sha2::{Digest, Sha256};

pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

pub fn random_hex(bytes: usize) -> String {
    let mut rng = rand::thread_rng();
    let mut raw = vec![0u8; bytes];
    rng.fill(&mut raw[..]);
    hex::encode(raw)
}

pub fn random_token(len: usize) -> String {
    rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(len)
        .map(char::from)
        .collect()
}

pub fn sha256_hex(data: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data.as_bytes());
    let result = hasher.finalize();
    hex::encode(result)
}

pub fn hash_to_u64(data: &str) -> u64 {
    let mut hasher = Sha256::new();
    hasher.update(data.as_bytes());
    let result = hasher.finalize();
    let bytes = &result[..8];
    u64::from_be_bytes(bytes.try_into().unwrap())
}

pub fn tokenize(text: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    for ch in text.chars() {
        if ch.is_alphanumeric() || ch == '_' || ch == '-' {
            current.push(ch.to_ascii_lowercase());
        } else if !current.is_empty() {
            tokens.push(current.clone());
            current.clear();
        }
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    tokens
}
