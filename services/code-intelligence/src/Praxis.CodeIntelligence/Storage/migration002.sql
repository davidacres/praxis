-- Additive foreign-key lookup indexes. Migration 001 and existing facts remain unchanged.
CREATE INDEX context_file_file ON context_files(file_id);
CREATE INDEX occurrence_owner ON occurrences(owner_symbol_id);
CREATE INDEX edge_owner_file ON edges(owner_context_id,owner_file_id);
CREATE INDEX edge_occurrence ON edges(occurrence_id);
CREATE INDEX diagnostic_file ON diagnostics(file_id);
CREATE INDEX diagnostic_repository ON diagnostics(repository_id);
CREATE INDEX repository_model_profile ON repository_models(model_fingerprint);
CREATE INDEX representation_profile ON representation_targets(model_fingerprint);
CREATE INDEX job_symbol ON jobs(symbol_id);
CREATE INDEX job_context ON jobs(context_id);
CREATE INDEX alias_symbol ON aliases(symbol_id);
CREATE INDEX alias_project ON aliases(project_id);
