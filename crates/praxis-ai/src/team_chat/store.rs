//! Atomic durability and file storage for team chat conversations (`store.rs`).

use std::collections::HashSet;
use std::fs::{self, File};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::Mutex;
use uuid::Uuid;

use super::types::TeamChatSnapshot;

#[derive(Debug, thiserror::Error)]
pub enum TeamChatStorageError {
    #[error("Team chat storage error: {0}")]
    Io(String),
    #[error("Team chat schema decode error: {0}")]
    Decode(String),
    #[error("Team chat commit uncertain error: {0}")]
    CommitUncertain(String),
}

/// Strict validation and decoding of stored team chat snapshot JSON.
pub fn decode_team_chat_snapshot(raw: &str) -> Result<TeamChatSnapshot, TeamChatStorageError> {
    let snapshot: TeamChatSnapshot = serde_json::from_str(raw)
        .map_err(|e| TeamChatStorageError::Decode(format!("JSON parse error: {e}")))?;

    if snapshot.schema_version != 2 {
        return Err(TeamChatStorageError::Decode(format!(
            "Invalid schema version {}, expected 2",
            snapshot.schema_version
        )));
    }

    // Verify unique conversation IDs
    let mut conv_ids = HashSet::new();
    for conv in &snapshot.conversations {
        if !conv_ids.insert(&conv.id) {
            return Err(TeamChatStorageError::Decode(format!(
                "Duplicate conversation ID: {}",
                conv.id
            )));
        }

        // Verify message sequences are monotonically increasing
        let mut prev_seq = 0;
        let mut msg_ids = HashSet::new();
        for msg in &conv.messages {
            if !msg_ids.insert(&msg.id) {
                return Err(TeamChatStorageError::Decode(format!(
                    "Duplicate message ID: {} in conversation {}",
                    msg.id, conv.id
                )));
            }
            if msg.sequence <= prev_seq {
                return Err(TeamChatStorageError::Decode(format!(
                    "Non-monotonic message sequence: {} follows {} in conversation {}",
                    msg.sequence, prev_seq, conv.id
                )));
            }
            prev_seq = msg.sequence;
        }

        // Verify unique turn IDs
        let mut turn_ids = HashSet::new();
        for turn in &conv.turns {
            if !turn_ids.insert(&turn.id) {
                return Err(TeamChatStorageError::Decode(format!(
                    "Duplicate turn ID: {} in conversation {}",
                    turn.id, conv.id
                )));
            }
        }
    }

    Ok(snapshot)
}

/// Durable file repository for team chat conversations.
#[derive(Clone)]
pub struct FileTeamChatRepository {
    file_path: PathBuf,
    writer_lock: Arc<Mutex<bool>>, // holds uncertain flag
}

impl FileTeamChatRepository {
    pub fn new(file_path: impl AsRef<Path>) -> Result<Self, TeamChatStorageError> {
        let repo = Self {
            file_path: file_path.as_ref().to_path_buf(),
            writer_lock: Arc::new(Mutex::new(false)),
        };
        // Verify read succeeds on creation
        let _ = repo.read()?;
        Ok(repo)
    }

    /// Reads the current snapshot from disk, returning an empty snapshot if file doesn't exist.
    pub fn read(&self) -> Result<TeamChatSnapshot, TeamChatStorageError> {
        if !self.file_path.exists() {
            return Ok(TeamChatSnapshot {
                schema_version: 2,
                revision: 0,
                team_chats: Vec::new(),
                conversations: Vec::new(),
            });
        }

        let raw = fs::read_to_string(&self.file_path).map_err(|e| {
            TeamChatStorageError::Io(format!("Cannot read {}: {e}", self.file_path.display()))
        })?;
        decode_team_chat_snapshot(&raw)
    }

    /// Executes an atomic transaction modifying the snapshot draft with temp-file + fsync + rename.
    pub async fn transaction<T, F>(&self, mutate: F) -> Result<T, TeamChatStorageError>
    where
        F: FnOnce(&mut TeamChatSnapshot) -> Result<T, String>,
    {
        let mut uncertain = self.writer_lock.lock().await;
        if *uncertain {
            return Err(TeamChatStorageError::CommitUncertain(
                "Team chat commit is uncertain; reload and reconcile before writing.".to_string(),
            ));
        }

        let current = self.read()?;
        let mut draft = current.clone();
        let result = mutate(&mut draft)
            .map_err(|e| TeamChatStorageError::Io(format!("Mutation failed: {e}")))?;

        draft.revision = current.revision + 1;
        let serialized = serde_json::to_string_pretty(&draft)
            .map_err(|e| TeamChatStorageError::Decode(format!("Failed to serialize draft: {e}")))?;

        // Verify draft decodes cleanly
        decode_team_chat_snapshot(&serialized)?;

        self.commit(&serialized, &mut uncertain).await?;
        Ok(result)
    }

    /// Inspects the snapshot and clears the uncertain flag.
    pub async fn reconcile<F>(&self, inspect: F) -> Result<(), TeamChatStorageError>
    where
        F: FnOnce(&TeamChatSnapshot),
    {
        let mut uncertain = self.writer_lock.lock().await;
        let current = self.read()?;
        inspect(&current);
        *uncertain = false;
        Ok(())
    }

    async fn commit(
        &self,
        serialized: &str,
        uncertain: &mut bool,
    ) -> Result<(), TeamChatStorageError> {
        let parent_dir = self.file_path.parent().unwrap_or_else(|| Path::new("."));
        fs::create_dir_all(parent_dir).map_err(|e| {
            TeamChatStorageError::Io(format!(
                "Failed to create directory {}: {e}",
                parent_dir.display()
            ))
        })?;

        let temp_path = self
            .file_path
            .with_extension(format!("{}.tmp", Uuid::new_v4()));

        let mut renamed = false;

        let commit_result = (|| -> Result<(), TeamChatStorageError> {
            use std::io::Write;
            let mut file = File::create(&temp_path).map_err(|e| {
                TeamChatStorageError::Io(format!(
                    "Failed to create temp file {}: {e}",
                    temp_path.display()
                ))
            })?;
            file.write_all(serialized.as_bytes()).map_err(|e| {
                TeamChatStorageError::Io(format!("Failed to write to temp file: {e}"))
            })?;
            file.sync_all()
                .map_err(|e| TeamChatStorageError::Io(format!("Failed to sync temp file: {e}")))?;
            drop(file);

            fs::rename(&temp_path, &self.file_path).map_err(|e| {
                TeamChatStorageError::Io(format!(
                    "Failed to rename temp file to {}: {e}",
                    self.file_path.display()
                ))
            })?;
            renamed = true;

            #[cfg(unix)]
            {
                if let Ok(dir_file) = File::open(parent_dir) {
                    let _ = dir_file.sync_all();
                }
            }

            Ok(())
        })();

        if commit_result.is_err() {
            let _ = fs::remove_file(&temp_path);
            if renamed {
                *uncertain = true;
                return Err(TeamChatStorageError::CommitUncertain(
                    "Rename succeeded but directory sync failed; commit durability is uncertain."
                        .to_string(),
                ));
            }
            return commit_result;
        }

        Ok(())
    }
}
