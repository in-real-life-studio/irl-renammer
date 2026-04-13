use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RenameOp {
    pub from: String,
    pub to: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RenameRecord {
    pub id: u64,
    pub timestamp: DateTime<Utc>,
    pub directory: String,
    pub operations: Vec<RenameOp>,
}

pub struct UndoManager {
    history: Mutex<Vec<RenameRecord>>,
    next_id: Mutex<u64>,
}

impl UndoManager {
    pub fn new() -> Self {
        Self {
            history: Mutex::new(Vec::new()),
            next_id: Mutex::new(1),
        }
    }

    pub fn record(&self, directory: String, operations: Vec<RenameOp>) -> RenameRecord {
        let mut id_lock = self.next_id.lock().unwrap();
        let id = *id_lock;
        *id_lock += 1;

        let record = RenameRecord {
            id,
            timestamp: Utc::now(),
            directory,
            operations,
        };

        self.history.lock().unwrap().push(record.clone());
        record
    }

    pub fn undo_last(&self) -> Result<RenameRecord, String> {
        let mut history = self.history.lock().unwrap();
        let record = history.pop().ok_or("Aucune opération à annuler")?;

        let dir = PathBuf::from(&record.directory);
        for op in record.operations.iter().rev() {
            let from = dir.join(&op.to);
            let to = dir.join(&op.from);
            std::fs::rename(&from, &to).map_err(|e| {
                format!("Erreur lors de l'annulation de {} → {}: {e}", op.to, op.from)
            })?;
        }

        Ok(record)
    }

    pub fn get_history(&self) -> Vec<RenameRecord> {
        self.history.lock().unwrap().clone()
    }
}
