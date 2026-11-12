//! The pinned code-intelligence embedding model bundle: status, download and removal
//! (port of the retired `semanticModelManager.ts` / `semanticModelDownload.ts`).
//!
//! The model, revision and checksums mirror `services/code-intelligence/models/bge-small-manifest.json`,
//! which the service verifies; changing any of them is a release decision.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};

use praxis_host::HostContext;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::runtime::block_on;
use super::{Result, failure};

const MODEL_ID: &str = "BAAI/bge-small-en-v1.5";
const MODEL_REVISION: &str = "5c38ec7c405ec4b44b94cc5a9bb96e735b38267a";

struct Asset {
    name: &'static str,
    path: &'static str,
    size: u64,
    sha256: &'static str,
}

const ASSETS: [Asset; 2] = [
    Asset { name: "vocab.txt", path: "vocab.txt", size: 231_508, sha256: "07eced375cec144d27c900241f3e339478dec958f92fddbc551f295c992038a3" },
    Asset { name: "model.onnx", path: "onnx/model.onnx", size: 133_093_490, sha256: "828e1496d7fabb79cfa4dcd84fa38625c0d3d21da474a00f08db0f559940cf35" },
];
const TOTAL_BYTES: u64 = 231_508 + 133_093_490;

static DOWNLOADING: AtomicBool = AtomicBool::new(false);
static PROGRESS: AtomicU32 = AtomicU32::new(0);
static FINGERPRINT: Mutex<Option<String>> = Mutex::new(None);

fn manifest() -> Value {
    json!({
        "version": 1, "modelId": MODEL_ID, "revision": MODEL_REVISION,
        "modelSha256": ASSETS[1].sha256, "vocabSha256": ASSETS[0].sha256,
        "dimensions": 384, "maximumTokens": 256, "tokenizer": "bert-uncased-wordpiece-v3",
        "pooling": "cls", "normalization": "l2", "metric": "cosine",
        "queryPrefix": "Represent this sentence for searching relevant passages: ", "documentPrefix": "",
        "representationVersion": 2, "license": "MIT"
    })
}

pub fn model_directory(user_data_dir: &Path) -> PathBuf {
    if let Ok(bundle) = std::env::var("PRAXIS_MODEL_BUNDLE") {
        if !bundle.is_empty() && Path::new(&bundle).exists() {
            return PathBuf::from(bundle);
        }
    }
    user_data_dir.join("models").join("semantic-search")
}

fn has_model_files(dir: &Path) -> bool {
    ["manifest.json", "model.onnx", "vocab.txt"].iter().all(|name| dir.join(name).exists())
}

fn is_installed(dir: &Path) -> bool {
    if !has_model_files(dir) {
        return false;
    }
    let Some(installed) = fs::read_to_string(dir.join("manifest.json")).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()) else {
        return false;
    };
    installed["modelId"] == MODEL_ID && installed["revision"] == MODEL_REVISION
}

pub fn status(user_data_dir: &Path) -> Value {
    let dir = model_directory(user_data_dir);
    let installed = is_installed(&dir);
    let fingerprint = FINGERPRINT.lock().ok().and_then(|f| f.clone());
    let mut size = 0;
    if installed {
        size = ["model.onnx", "vocab.txt"].iter().filter_map(|n| fs::metadata(dir.join(n)).ok()).map(|m| m.len()).sum::<u64>();
    }
    let mut value = json!({
        "installed": installed,
        "active": installed && fingerprint.is_some(),
        "sizeBytes": size,
        "downloading": DOWNLOADING.load(Ordering::SeqCst),
        "progressPercent": PROGRESS.load(Ordering::SeqCst),
        "updateAvailable": has_model_files(&dir) && !installed,
        "modelId": MODEL_ID
    });
    if let Some(fingerprint) = fingerprint {
        value["fingerprint"] = json!(fingerprint);
    }
    if installed {
        value["architecture"] = json!("BERT / bge-small (ONNX)");
    }
    value
}

fn emit(host: &HostContext, downloaded: u64) {
    let percent = ((downloaded as f64 / TOTAL_BYTES as f64) * 100.0).round().min(100.0) as u32;
    PROGRESS.store(percent, Ordering::SeqCst);
    host.events().emit("ai:semanticModelProgress", Some(json!({ "bytesDownloaded": downloaded, "totalBytes": TOTAL_BYTES, "percent": percent })));
}

async fn fetch(host: &HostContext, asset: &Asset, dest: &Path, done: &mut u64) -> std::result::Result<(), String> {
    let base = std::env::var("PRAXIS_MODEL_BASE_URL").unwrap_or_else(|_| format!("https://huggingface.co/{MODEL_ID}/resolve/{MODEL_REVISION}"));
    let url = format!("{}/{}", base.trim_end_matches('/'), asset.path);
    let client = reqwest::Client::builder().user_agent("Praxis-Desktop").timeout(std::time::Duration::from_secs(600)).build().map_err(|e| e.to_string())?;
    let mut response = client.get(&url).send().await.map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("Download failed with status {}: {url}", response.status().as_u16()));
    }
    let partial = dest.with_extension(format!("{}.partial", dest.extension().and_then(|e| e.to_str()).unwrap_or("")));
    let mut file = fs::File::create(&partial).map_err(|e| e.to_string())?;
    let mut hash = Sha256::new();
    let mut count = 0u64;
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        file.write_all(&chunk).map_err(|e| e.to_string())?;
        hash.update(&chunk);
        count += chunk.len() as u64;
        *done += chunk.len() as u64;
        emit(host, *done);
    }
    drop(file);
    if count != asset.size {
        let _ = fs::remove_file(&partial);
        return Err(format!("Size mismatch for {}: expected {}, got {count}", asset.name, asset.size));
    }
    let actual: String = hash.finalize().iter().map(|b| format!("{b:02x}")).collect();
    if actual != asset.sha256 {
        let _ = fs::remove_file(&partial);
        return Err(format!("Checksum mismatch for {}: expected {}, got {actual}", asset.name, asset.sha256));
    }
    fs::rename(&partial, dest).map_err(|e| e.to_string())
}

pub fn download(host: &HostContext, user_data_dir: &Path) -> Result<Value> {
    if DOWNLOADING.swap(true, Ordering::SeqCst) {
        return Err(failure("Model download is already in progress."));
    }
    PROGRESS.store(0, Ordering::SeqCst);
    let dir = model_directory(user_data_dir);
    let outcome = (|| -> std::result::Result<(), String> {
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let mut done = 0u64;
        for asset in &ASSETS {
            let dest = dir.join(asset.name);
            if fs::metadata(&dest).map(|m| m.len() == asset.size).unwrap_or(false) {
                done += asset.size;
                emit(host, done);
                continue;
            }
            block_on(fetch(host, asset, &dest, &mut done))?;
        }
        let text = serde_json::to_string_pretty(&manifest()).map_err(|e| e.to_string())?;
        fs::write(dir.join("manifest.json"), text).map_err(|e| e.to_string())?;
        PROGRESS.store(100, Ordering::SeqCst);
        host.events().emit("ai:semanticModelProgress", Some(json!({ "bytesDownloaded": TOTAL_BYTES, "totalBytes": TOTAL_BYTES, "percent": 100 })));
        Ok(())
    })();
    DOWNLOADING.store(false, Ordering::SeqCst);
    outcome.map_err(failure)?;
    Ok(Value::Null)
}

pub fn delete(user_data_dir: &Path) -> Value {
    let dir = model_directory(user_data_dir);
    if dir.exists() {
        let _ = fs::remove_dir_all(&dir);
    }
    if let Ok(mut f) = FINGERPRINT.lock() {
        *f = None;
    }
    Value::Null
}
