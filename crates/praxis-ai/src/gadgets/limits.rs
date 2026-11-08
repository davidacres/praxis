//! Hard bounds on gadget envelopes and payload fields (`limits.rs`).

pub const ENVELOPE_BYTES: usize = 128 * 1024;
pub const STRING_LENGTH: usize = 20_000;
pub const CHOICE_OPTIONS: usize = 24;
pub const FORM_FIELDS: usize = 24;
pub const TABLE_ROWS: usize = 200;
pub const TABLE_COLUMNS: usize = 20;
pub const CHART_SERIES: usize = 8;
pub const CHART_POINTS: usize = 500;
pub const DIFF_FILES: usize = 100;
pub const DIFF_PREVIEW_LENGTH: usize = 8_000;
pub const ARTIFACTS: usize = 50;
pub const IMAGES: usize = 20;
pub const PROGRESS_STEPS: usize = 40;
pub const CONFLICTS: usize = 50;
pub const HANDOFF_ITEMS: usize = 60;
pub const APPROVAL_EVIDENCE: usize = 40;
pub const ACTIONS: usize = 8;
