use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::VecDeque;
use std::sync::Mutex;

pub const DEFAULT_BUFFER_SIZE: usize = 100;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserDiagnosticsBundleKey {
    pub project_id: String,
    pub run_id: String,
    pub service_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsoleDiagnosticEntry {
    pub level: String,
    pub message: String,
    pub at: String,
    pub redacted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkFailureEntry {
    pub url: String,
    pub method: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub at: String,
    pub redacted: bool,
}

#[derive(Debug)]
pub struct BrowserDiagnosticsRecorder {
    key: BrowserDiagnosticsBundleKey,
    console_buffer: Mutex<VecDeque<ConsoleDiagnosticEntry>>,
    network_buffer: Mutex<VecDeque<NetworkFailureEntry>>,
    dropped_console: Mutex<bool>,
    dropped_network: Mutex<bool>,
}

impl BrowserDiagnosticsRecorder {
    pub fn new(key: BrowserDiagnosticsBundleKey) -> Self {
        Self {
            key,
            console_buffer: Mutex::new(VecDeque::with_capacity(DEFAULT_BUFFER_SIZE)),
            network_buffer: Mutex::new(VecDeque::with_capacity(DEFAULT_BUFFER_SIZE)),
            dropped_console: Mutex::new(false),
            dropped_network: Mutex::new(false),
        }
    }

    pub fn record_console(&self, level: &str, message: &str) {
        if let Ok(mut buf) = self.console_buffer.lock() {
            if buf.len() >= DEFAULT_BUFFER_SIZE {
                buf.pop_front();
                if let Ok(mut dropped) = self.dropped_console.lock() {
                    *dropped = true;
                }
            }
            buf.push_back(ConsoleDiagnosticEntry {
                level: level.to_string(),
                message: message.to_string(),
                at: Utc::now().to_rfc3339(),
                redacted: false,
            });
        }
    }

    pub fn record_network_failure(
        &self,
        url: &str,
        method: &str,
        status: Option<u16>,
        error: Option<String>,
    ) {
        if let Ok(mut buf) = self.network_buffer.lock() {
            if buf.len() >= DEFAULT_BUFFER_SIZE {
                buf.pop_front();
                if let Ok(mut dropped) = self.dropped_network.lock() {
                    *dropped = true;
                }
            }
            buf.push_back(NetworkFailureEntry {
                url: url.to_string(),
                method: method.to_string(),
                status,
                error,
                at: Utc::now().to_rfc3339(),
                redacted: false,
            });
        }
    }

    pub fn snapshot(&self) -> Value {
        let console: Vec<ConsoleDiagnosticEntry> = self
            .console_buffer
            .lock()
            .map(|buf| buf.iter().cloned().collect())
            .unwrap_or_default();
        let network: Vec<NetworkFailureEntry> = self
            .network_buffer
            .lock()
            .map(|buf| buf.iter().cloned().collect())
            .unwrap_or_default();
        let truncated = self.dropped_console.lock().map(|d| *d).unwrap_or(false)
            || self.dropped_network.lock().map(|d| *d).unwrap_or(false);

        json!({
            "schemaVersion": 1,
            "projectId": self.key.project_id,
            "runId": self.key.run_id,
            "serviceId": self.key.service_id,
            "capturedAt": Utc::now().to_rfc3339(),
            "console": console,
            "network": network,
            "screenshots": [],
            "truncated": truncated
        })
    }
}
