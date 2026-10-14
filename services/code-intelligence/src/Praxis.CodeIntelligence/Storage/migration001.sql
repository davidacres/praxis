CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  checksum TEXT NOT NULL,
  applied_utc TEXT NOT NULL
) STRICT;

CREATE TABLE repositories (
  repository_id TEXT PRIMARY KEY,
  canonical_root TEXT NOT NULL UNIQUE,
  path_policy TEXT NOT NULL CHECK(path_policy IN ('caseSensitive','caseInsensitive')),
  structural_generation INTEGER NOT NULL DEFAULT 0 CHECK(structural_generation >= 0),
  query_epoch INTEGER NOT NULL DEFAULT 0 CHECK(query_epoch >= 0),
  desired_revision INTEGER NOT NULL DEFAULT 0 CHECK(desired_revision >= 0),
  state TEXT NOT NULL DEFAULT 'discovered',
  last_reconciled_utc TEXT,
  config_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(config_json))
) STRICT;

CREATE TABLE projects (
  project_id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL REFERENCES repositories ON DELETE CASCADE,
  project_key TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  language TEXT NOT NULL,
  UNIQUE(repository_id, project_key)
) STRICT;

CREATE TABLE contexts (
  context_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects ON DELETE CASCADE,
  slot_key TEXT NOT NULL,
  context_hash TEXT NOT NULL,
  api_hash TEXT NOT NULL,
  adapter_version TEXT NOT NULL,
  options_json TEXT NOT NULL CHECK(json_valid(options_json)),
  desired_revision INTEGER NOT NULL DEFAULT 0,
  published_revision INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'discovered',
  resolution TEXT NOT NULL CHECK(resolution IN ('complete','partial','syntaxOnly')),
  capabilities_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(capabilities_json)),
  CHECK(desired_revision >= published_revision AND published_revision >= 0),
  UNIQUE(project_id, slot_key)
) STRICT;

CREATE TABLE context_dependencies (
  caller_context_id TEXT NOT NULL REFERENCES contexts ON DELETE CASCADE,
  target_context_id TEXT NOT NULL REFERENCES contexts ON DELETE CASCADE,
  required_api_hash TEXT NOT NULL,
  PRIMARY KEY(caller_context_id, target_context_id)
) STRICT;
CREATE INDEX dependency_target ON context_dependencies(target_context_id);

CREATE TABLE project_inputs (
  context_id TEXT NOT NULL REFERENCES contexts ON DELETE CASCADE,
  input_key TEXT NOT NULL,
  role TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json)),
  PRIMARY KEY(context_id, input_key)
) STRICT;

CREATE TABLE files (
  file_id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL REFERENCES repositories ON DELETE CASCADE,
  relative_path TEXT NOT NULL,
  path_key TEXT NOT NULL,
  observed_hash TEXT,
  size_bytes INTEGER CHECK(size_bytes IS NULL OR size_bytes >= 0),
  language TEXT NOT NULL,
  encoding TEXT,
  role TEXT NOT NULL CHECK(role IN ('searchableSource','semanticSupport','projectInput','excluded','unreadable')),
  state TEXT NOT NULL,
  UNIQUE(repository_id, path_key)
) STRICT;

CREATE TABLE context_files (
  context_id TEXT NOT NULL REFERENCES contexts ON DELETE CASCADE,
  file_id TEXT NOT NULL REFERENCES files ON DELETE CASCADE,
  analysed_hash TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK(generation >= 0),
  PRIMARY KEY(context_id, file_id)
) STRICT;

CREATE TABLE symbols (
  symbol_id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL REFERENCES repositories ON DELETE CASCADE,
  defining_context_id TEXT REFERENCES contexts ON DELETE CASCADE,
  identity_key TEXT NOT NULL,
  descriptor_json TEXT NOT NULL CHECK(json_valid(descriptor_json)),
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  qualified_name TEXT NOT NULL,
  signature TEXT NOT NULL,
  revision TEXT NOT NULL,
  external INTEGER NOT NULL CHECK(external IN (0,1)),
  resolution TEXT NOT NULL CHECK(resolution IN ('resolved','possible','unresolved','syntaxOnly')),
  containment_id TEXT REFERENCES symbols DEFERRABLE INITIALLY DEFERRED,
  CHECK((external=1 AND defining_context_id IS NULL) OR (external=0 AND defining_context_id IS NOT NULL)),
  UNIQUE(repository_id, identity_key)
) STRICT;
CREATE INDEX symbol_name ON symbols(repository_id, name);
CREATE INDEX symbol_qualified ON symbols(repository_id, qualified_name);
CREATE INDEX symbol_context ON symbols(defining_context_id);
CREATE INDEX symbol_container ON symbols(containment_id);

CREATE TABLE locations (
  location_id TEXT PRIMARY KEY,
  symbol_id TEXT NOT NULL REFERENCES symbols ON DELETE CASCADE,
  context_id TEXT NOT NULL,
  file_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  start_offset INTEGER NOT NULL CHECK(start_offset >= 0),
  end_offset INTEGER NOT NULL CHECK(end_offset >= start_offset),
  start_line INTEGER NOT NULL CHECK(start_line >= 0),
  start_character INTEGER NOT NULL CHECK(start_character >= 0),
  end_line INTEGER NOT NULL,
  end_character INTEGER NOT NULL CHECK(end_character >= 0),
  role TEXT NOT NULL,
  CHECK(end_line > start_line OR (end_line=start_line AND end_character>=start_character)),
  FOREIGN KEY(context_id,file_id) REFERENCES context_files ON DELETE CASCADE
) STRICT;
CREATE INDEX location_file ON locations(file_id,context_id);
CREATE INDEX location_symbol ON locations(symbol_id);

CREATE TABLE occurrences (
  occurrence_id TEXT PRIMARY KEY,
  context_id TEXT NOT NULL,
  file_id TEXT NOT NULL,
  owner_symbol_id TEXT NOT NULL REFERENCES symbols ON DELETE CASCADE,
  target_symbol_id TEXT REFERENCES symbols ON DELETE SET NULL,
  content_hash TEXT NOT NULL,
  start_offset INTEGER NOT NULL CHECK(start_offset>=0),
  end_offset INTEGER NOT NULL CHECK(end_offset>=start_offset),
  range_json TEXT NOT NULL CHECK(json_valid(range_json)),
  resolution TEXT NOT NULL CHECK(resolution IN ('resolved','possible','unresolved','syntaxOnly')),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json)),
  FOREIGN KEY(context_id,file_id) REFERENCES context_files ON DELETE CASCADE
) STRICT;
CREATE INDEX occurrence_target ON occurrences(target_symbol_id);
CREATE INDEX occurrence_file ON occurrences(context_id,file_id);

CREATE TABLE edges (
  edge_id TEXT PRIMARY KEY,
  owner_context_id TEXT NOT NULL REFERENCES contexts ON DELETE CASCADE,
  owner_file_id TEXT,
  source_symbol_id TEXT NOT NULL REFERENCES symbols ON DELETE CASCADE,
  target_symbol_id TEXT NOT NULL REFERENCES symbols ON DELETE CASCADE,
  occurrence_id TEXT REFERENCES occurrences ON DELETE CASCADE,
  kind TEXT NOT NULL,
  provenance TEXT NOT NULL CHECK(provenance IN ('compiler','syntax','heuristic')),
  resolution TEXT NOT NULL CHECK(resolution IN ('resolved','possible','unresolved','syntaxOnly')),
  input_revision TEXT NOT NULL,
  evidence_key TEXT NOT NULL,
  UNIQUE(owner_context_id,evidence_key),
  FOREIGN KEY(owner_context_id,owner_file_id) REFERENCES context_files ON DELETE CASCADE
) STRICT;
CREATE INDEX edge_source ON edges(source_symbol_id,kind);
CREATE INDEX edge_target ON edges(target_symbol_id,kind);

CREATE TABLE diagnostics (
  diagnostic_id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL REFERENCES repositories ON DELETE CASCADE,
  context_id TEXT REFERENCES contexts ON DELETE CASCADE,
  file_id TEXT REFERENCES files ON DELETE CASCADE,
  code TEXT NOT NULL,
  severity TEXT NOT NULL CHECK(severity IN ('info','warning','error')),
  message TEXT NOT NULL,
  range_json TEXT CHECK(range_json IS NULL OR json_valid(range_json)),
  generation INTEGER NOT NULL
) STRICT;
CREATE INDEX diagnostic_context ON diagnostics(context_id,severity);

CREATE TABLE descriptions (
  description_id TEXT PRIMARY KEY,
  symbol_id TEXT NOT NULL REFERENCES symbols ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('deterministic','generated','aggregate')),
  provider_fingerprint TEXT NOT NULL,
  input_revision TEXT NOT NULL,
  dependency_hash TEXT NOT NULL,
  text TEXT,
  evidence_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(evidence_json)),
  state TEXT NOT NULL CHECK(state IN ('pending','ready','failed','excluded','stale')),
  UNIQUE(symbol_id,kind,provider_fingerprint)
) STRICT;

CREATE TABLE description_dependencies (
  description_id TEXT NOT NULL REFERENCES descriptions ON DELETE CASCADE,
  input_symbol_id TEXT NOT NULL REFERENCES symbols ON DELETE CASCADE,
  input_revision TEXT NOT NULL,
  PRIMARY KEY(description_id,input_symbol_id)
) STRICT;
CREATE INDEX description_input ON description_dependencies(input_symbol_id);

CREATE TABLE model_profiles (
  fingerprint TEXT PRIMARY KEY,
  manifest_json TEXT NOT NULL CHECK(json_valid(manifest_json)),
  dimensions INTEGER NOT NULL CHECK(dimensions>0 AND dimensions<=8192),
  metric TEXT NOT NULL CHECK(metric='cosine'),
  representation_version INTEGER NOT NULL CHECK(representation_version>0)
) STRICT;

CREATE TABLE repository_models (
  repository_id TEXT NOT NULL REFERENCES repositories ON DELETE CASCADE,
  model_fingerprint TEXT NOT NULL REFERENCES model_profiles,
  state TEXT NOT NULL CHECK(state IN ('building','active','retiring','failed')),
  activated_utc TEXT,
  PRIMARY KEY(repository_id,model_fingerprint)
) STRICT;
CREATE UNIQUE INDEX one_active_model ON repository_models(repository_id) WHERE state='active';

CREATE TABLE representation_targets (
  symbol_id TEXT NOT NULL REFERENCES symbols ON DELETE CASCADE,
  model_fingerprint TEXT NOT NULL REFERENCES model_profiles,
  input_revision TEXT NOT NULL,
  representation_hash TEXT,
  eligibility TEXT NOT NULL CHECK(eligibility IN ('eligible','excluded')),
  exclusion_reason TEXT,
  CHECK(eligibility!='excluded' OR exclusion_reason IS NOT NULL),
  PRIMARY KEY(symbol_id,model_fingerprint)
) STRICT;

CREATE TABLE embedding_sets (
  set_id TEXT PRIMARY KEY,
  symbol_id TEXT NOT NULL REFERENCES symbols ON DELETE CASCADE,
  model_fingerprint TEXT NOT NULL REFERENCES model_profiles,
  input_revision TEXT NOT NULL,
  representation_hash TEXT NOT NULL,
  expected_chunks INTEGER NOT NULL CHECK(expected_chunks BETWEEN 0 AND 4),
  state TEXT NOT NULL CHECK(state IN ('pending','ready','failed','excluded','stale')),
  exclusion_reason TEXT,
  CHECK(state!='ready' OR expected_chunks BETWEEN 1 AND 4),
  CHECK(state!='excluded' OR exclusion_reason IS NOT NULL),
  UNIQUE(symbol_id,model_fingerprint),
  FOREIGN KEY(symbol_id,model_fingerprint) REFERENCES representation_targets ON DELETE CASCADE
) STRICT;
CREATE INDEX embedding_ready ON embedding_sets(model_fingerprint,state);

CREATE TABLE vectors (
  set_id TEXT NOT NULL REFERENCES embedding_sets ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL CHECK(chunk_index BETWEEN 0 AND 3),
  dimensions INTEGER NOT NULL CHECK(dimensions>0),
  values_blob BLOB NOT NULL,
  spans_json TEXT NOT NULL CHECK(json_valid(spans_json)),
  CHECK(length(values_blob)=dimensions*4),
  PRIMARY KEY(set_id,chunk_index)
) STRICT;

CREATE TRIGGER vector_dimension_insert BEFORE INSERT ON vectors BEGIN
  SELECT CASE WHEN NEW.dimensions != (
    SELECT m.dimensions FROM model_profiles m
    JOIN embedding_sets e ON e.model_fingerprint=m.fingerprint WHERE e.set_id=NEW.set_id
  ) THEN RAISE(ABORT,'vector dimension mismatch') END;
END;
CREATE TRIGGER vector_dimension_update BEFORE UPDATE ON vectors BEGIN
  SELECT CASE WHEN NEW.dimensions != (
    SELECT m.dimensions FROM model_profiles m
    JOIN embedding_sets e ON e.model_fingerprint=m.fingerprint WHERE e.set_id=NEW.set_id
  ) THEN RAISE(ABORT,'vector dimension mismatch') END;
END;
CREATE TRIGGER embedding_ready_insert BEFORE INSERT ON embedding_sets
WHEN NEW.state='ready' BEGIN
  SELECT RAISE(ABORT,'insert pending set before ready publication');
END;
CREATE TRIGGER embedding_ready_update BEFORE UPDATE OF state ON embedding_sets
WHEN NEW.state='ready' BEGIN
  SELECT CASE WHEN (SELECT count(*) FROM vectors WHERE set_id=NEW.set_id)!=NEW.expected_chunks
    OR (SELECT min(chunk_index) FROM vectors WHERE set_id=NEW.set_id)!=0
    OR (SELECT max(chunk_index) FROM vectors WHERE set_id=NEW.set_id)!=NEW.expected_chunks-1
    THEN RAISE(ABORT,'incomplete embedding set') END;
END;

CREATE TRIGGER ready_vector_insert BEFORE INSERT ON vectors
WHEN (SELECT state FROM embedding_sets WHERE set_id=NEW.set_id)='ready' BEGIN
  SELECT RAISE(ABORT,'ready vector set is immutable');
END;
CREATE TRIGGER ready_vector_update BEFORE UPDATE ON vectors
WHEN (SELECT state FROM embedding_sets WHERE set_id=OLD.set_id)='ready'
  OR (SELECT state FROM embedding_sets WHERE set_id=NEW.set_id)='ready' BEGIN
  SELECT RAISE(ABORT,'ready vector set is immutable');
END;
CREATE TRIGGER ready_vector_delete BEFORE DELETE ON vectors
WHEN (SELECT state FROM embedding_sets WHERE set_id=OLD.set_id)='ready' BEGIN
  SELECT RAISE(ABORT,'mark vector set stale before deleting its chunks');
END;
CREATE TRIGGER ready_set_metadata BEFORE UPDATE ON embedding_sets
WHEN OLD.state='ready' AND NEW.state='ready' AND (
  OLD.symbol_id!=NEW.symbol_id OR OLD.model_fingerprint!=NEW.model_fingerprint
  OR OLD.input_revision!=NEW.input_revision OR OLD.representation_hash!=NEW.representation_hash
  OR OLD.expected_chunks!=NEW.expected_chunks
) BEGIN
  SELECT RAISE(ABORT,'ready vector metadata is immutable');
END;

CREATE TABLE jobs (
  job_id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL REFERENCES repositories ON DELETE CASCADE,
  context_id TEXT REFERENCES contexts ON DELETE CASCADE,
  symbol_id TEXT REFERENCES symbols ON DELETE CASCADE,
  kind TEXT NOT NULL,
  input_key TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  desired_revision INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','leased','succeeded','failed','obsolete')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
  available_utc TEXT NOT NULL,
  lease_token TEXT,
  lease_owner TEXT,
  lease_until_utc TEXT,
  error_code TEXT,
  error_message TEXT,
  CHECK(state!='leased' OR (lease_token IS NOT NULL AND lease_owner IS NOT NULL AND lease_until_utc IS NOT NULL)),
  UNIQUE(repository_id,kind,input_key)
) STRICT;
CREATE INDEX job_pending ON jobs(repository_id,state,available_utc);

CREATE TABLE aliases (
  alias_id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL REFERENCES repositories ON DELETE CASCADE,
  project_id TEXT REFERENCES projects ON DELETE CASCADE,
  symbol_id TEXT NOT NULL REFERENCES symbols ON DELETE CASCADE,
  phrase TEXT NOT NULL,
  phrase_key TEXT NOT NULL,
  origin TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  created_utc TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX alias_scope ON aliases(repository_id,ifnull(project_id,''),phrase_key,symbol_id);

CREATE TABLE search_documents (
  search_id INTEGER PRIMARY KEY,
  symbol_id TEXT NOT NULL UNIQUE REFERENCES symbols ON DELETE CASCADE,
  input_revision TEXT NOT NULL,
  name TEXT NOT NULL,
  signature TEXT NOT NULL,
  documentation TEXT NOT NULL,
  description TEXT NOT NULL
) STRICT;
CREATE VIRTUAL TABLE symbol_fts USING fts5(
  name,signature,documentation,description,
  content='search_documents',content_rowid='search_id',tokenize='unicode61'
);
CREATE TRIGGER search_insert AFTER INSERT ON search_documents BEGIN
  INSERT INTO symbol_fts(rowid,name,signature,documentation,description)
  VALUES(NEW.search_id,NEW.name,NEW.signature,NEW.documentation,NEW.description);
END;
CREATE TRIGGER search_delete AFTER DELETE ON search_documents BEGIN
  INSERT INTO symbol_fts(symbol_fts,rowid,name,signature,documentation,description)
  VALUES('delete',OLD.search_id,OLD.name,OLD.signature,OLD.documentation,OLD.description);
END;
CREATE TRIGGER search_update AFTER UPDATE ON search_documents BEGIN
  INSERT INTO symbol_fts(symbol_fts,rowid,name,signature,documentation,description)
  VALUES('delete',OLD.search_id,OLD.name,OLD.signature,OLD.documentation,OLD.description);
  INSERT INTO symbol_fts(rowid,name,signature,documentation,description)
  VALUES(NEW.search_id,NEW.name,NEW.signature,NEW.documentation,NEW.description);
END;
