CREATE TABLE documents (
  document_id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL REFERENCES repositories ON DELETE CASCADE,
  relative_path TEXT NOT NULL,
  path_key TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  doc_type TEXT NOT NULL CHECK(doc_type IN ('markdown','word','presentation','sheet','plan','spec','general')),
  title TEXT NOT NULL,
  frontmatter_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(frontmatter_json)),
  size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
  UNIQUE(repository_id, path_key)
) STRICT;

CREATE TABLE knowledge_sections (
  section_id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents ON DELETE CASCADE,
  section_index INTEGER NOT NULL CHECK(section_index >= 0),
  heading TEXT NOT NULL,
  heading_path TEXT NOT NULL,
  start_line INTEGER NOT NULL CHECK(start_line >= 0),
  end_line INTEGER NOT NULL CHECK(end_line >= start_line),
  start_offset INTEGER NOT NULL CHECK(start_offset >= 0),
  end_offset INTEGER NOT NULL CHECK(end_offset >= start_offset),
  section_hash TEXT NOT NULL,
  body TEXT NOT NULL,
  UNIQUE(document_id, section_index)
) STRICT;

CREATE VIRTUAL TABLE knowledge_fts USING fts5(
  title,
  heading_path,
  body,
  frontmatter,
  content='',
  tokenize='unicode61'
);

CREATE TRIGGER knowledge_sections_insert AFTER INSERT ON knowledge_sections BEGIN
  INSERT INTO knowledge_fts(rowid, title, heading_path, body, frontmatter)
  SELECT NEW.rowid, d.title, NEW.heading_path, NEW.body, d.frontmatter_json
  FROM documents d WHERE d.document_id = NEW.document_id;
END;

CREATE TRIGGER knowledge_sections_delete BEFORE DELETE ON knowledge_sections BEGIN
  INSERT INTO knowledge_fts(knowledge_fts, rowid, title, heading_path, body, frontmatter)
  SELECT 'delete', OLD.rowid, d.title, OLD.heading_path, OLD.body, d.frontmatter_json
  FROM documents d WHERE d.document_id = OLD.document_id;
END;

CREATE TRIGGER documents_delete BEFORE DELETE ON documents BEGIN
  DELETE FROM knowledge_sections WHERE document_id = OLD.document_id;
END;

CREATE TABLE knowledge_representation_targets (
  section_id TEXT NOT NULL REFERENCES knowledge_sections ON DELETE CASCADE,
  model_fingerprint TEXT NOT NULL REFERENCES model_profiles,
  input_revision TEXT NOT NULL,
  representation_hash TEXT NOT NULL,
  eligibility TEXT NOT NULL CHECK(eligibility IN ('eligible','excluded')),
  PRIMARY KEY(section_id, model_fingerprint)
) STRICT;

CREATE TABLE knowledge_vectors (
  section_id TEXT NOT NULL REFERENCES knowledge_sections ON DELETE CASCADE,
  model_fingerprint TEXT NOT NULL REFERENCES model_profiles,
  dimensions INTEGER NOT NULL CHECK(dimensions = 384),
  values_blob BLOB NOT NULL,
  CHECK(length(values_blob) = dimensions * 4),
  PRIMARY KEY(section_id, model_fingerprint)
) STRICT;

CREATE TABLE knowledge_links (
  link_id TEXT PRIMARY KEY,
  section_id TEXT NOT NULL REFERENCES knowledge_sections ON DELETE CASCADE,
  target_kind TEXT NOT NULL CHECK(target_kind IN ('symbol','file','ticket')),
  target_symbol_id TEXT REFERENCES symbols ON DELETE SET NULL,
  target_key TEXT NOT NULL,
  provenance TEXT NOT NULL CHECK(provenance IN ('explicit_link','symbol_match','ticket_mention'))
) STRICT;
