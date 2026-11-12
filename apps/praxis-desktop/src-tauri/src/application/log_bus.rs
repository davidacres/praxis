//! Host-neutral log bus and disk persistence under `<userData>/logs/application.log`.
use std::collections::VecDeque;
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use praxis_host::HostContext;
use serde_json::{Value, json};

use super::{Result, failure};

const LOG_FILE_NAME: &str = "application.log";
#[allow(dead_code)]
const MAX_LOG_BYTES: u64 = 1024 * 1024;
const DEFAULT_CAPACITY: usize = 500;

/// The bus of a profile, shared by the `log:getRecent` handler and everything that writes to it.
pub fn shared(root: &Path) -> std::sync::Arc<LogBus> {
    static BUSES: std::sync::OnceLock<Mutex<std::collections::HashMap<PathBuf, std::sync::Arc<LogBus>>>> = std::sync::OnceLock::new();
    let mut all = BUSES.get_or_init(Default::default).lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    std::sync::Arc::clone(all.entry(root.to_path_buf()).or_insert_with(|| std::sync::Arc::new(LogBus::new(root))))
}

/// Appends one line to the profile's application log.
pub fn log(host: &HostContext, line: &str) {
    shared(&host.config().user_data_dir).append(host, line);
}

pub struct LogBus {
    state: Mutex<LogBusState>,
    #[allow(dead_code)]
    log_dir: PathBuf,
}

struct LogBusState {
    lines: VecDeque<String>,
}

impl LogBus {
    pub fn new(root: &Path) -> Self {
        let log_dir = root.join("logs");
        let lines = read_recent_lines(&log_dir, DEFAULT_CAPACITY);
        Self {
            state: Mutex::new(LogBusState {
                lines: lines.into_iter().collect(),
            }),
            log_dir,
        }
    }

    pub fn recent(&self) -> Vec<String> {
        let Ok(state) = self.state.lock() else {
            return Vec::new();
        };
        state.lines.iter().cloned().collect()
    }

    pub fn append(&self, host: &HostContext, line: &str) {
        let clean_line = line.strip_suffix('\n').unwrap_or(line).to_string();
        if let Ok(mut state) = self.state.lock() {
            if state.lines.len() >= DEFAULT_CAPACITY {
                state.lines.pop_front();
            }
            state.lines.push_back(clean_line.clone());
        }
        self.persist_line(&clean_line);
        host.events().emit("log:appended", Some(json!(clean_line)));
    }

    fn persist_line(&self, line: &str) {
        let _ = fs::create_dir_all(&self.log_dir);
        let log_file = self.log_dir.join(LOG_FILE_NAME);
        if let Ok(metadata) = fs::metadata(&log_file)
            && metadata.len() > MAX_LOG_BYTES
        {
            let backup = self.log_dir.join(format!("{LOG_FILE_NAME}.1"));
            let _ = fs::rename(&log_file, backup);
        }
        if let Ok(encoded) = serde_json::to_string(line)
            && let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&log_file)
        {
            let _ = writeln!(file, "{encoded}");
        }
    }

    pub fn dispatch(&self, channel: &str, _args: &[Value]) -> Result<Value> {
        match channel {
            "log:getRecent" => Ok(json!(self.recent())),
            _ => Err(failure(format!("Unsupported log channel: {channel}"))),
        }
    }
}

fn read_recent_lines(log_dir: &Path, limit: usize) -> Vec<String> {
    let log_file = log_dir.join(LOG_FILE_NAME);
    let Ok(file) = fs::File::open(log_file) else {
        return Vec::new();
    };
    let reader = BufReader::new(file);
    let mut all_lines = Vec::new();
    for row in reader.lines().map_while(std::result::Result::ok) {
        if row.trim().is_empty() {
            continue;
        }
        if let Ok(Value::String(text)) = serde_json::from_str(&row) {
            all_lines.push(text);
        }
    }
    if all_lines.len() > limit {
        all_lines.split_off(all_lines.len() - limit)
    } else {
        all_lines
    }
}
