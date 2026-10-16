-- vector_scan also carries each symbol's defining context and kind so the
-- score pass can apply context, kind and project filters before ranking.
-- They are a prefilter only: candidates are still validated against symbols,
-- representation targets and sets. Triggers keep them in the writing
-- transaction, including symbol context/kind changes.
DROP TRIGGER vector_scan_insert;
DROP TRIGGER vector_scan_update;
DROP TRIGGER vector_scan_delete;
DROP TRIGGER vector_scan_set_update;
DROP TABLE vector_scan;

CREATE TABLE vector_scan (
  set_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  symbol_id TEXT NOT NULL,
  model_fingerprint TEXT NOT NULL,
  ready INTEGER NOT NULL CHECK(ready IN (0,1)),
  context_id TEXT,
  kind TEXT,
  dimensions INTEGER NOT NULL,
  values_blob BLOB NOT NULL,
  PRIMARY KEY(set_id,chunk_index)
) STRICT;
CREATE INDEX vector_scan_symbol ON vector_scan(symbol_id);

INSERT INTO vector_scan(set_id,chunk_index,symbol_id,model_fingerprint,ready,context_id,kind,dimensions,values_blob)
SELECT v.set_id,v.chunk_index,e.symbol_id,e.model_fingerprint,e.state='ready',s.defining_context_id,s.kind,v.dimensions,v.values_blob
FROM vectors v JOIN embedding_sets e ON e.set_id=v.set_id LEFT JOIN symbols s ON s.symbol_id=e.symbol_id;

CREATE TRIGGER vector_scan_insert AFTER INSERT ON vectors BEGIN
  INSERT INTO vector_scan(set_id,chunk_index,symbol_id,model_fingerprint,ready,context_id,kind,dimensions,values_blob)
  SELECT NEW.set_id,NEW.chunk_index,e.symbol_id,e.model_fingerprint,e.state='ready',s.defining_context_id,s.kind,NEW.dimensions,NEW.values_blob
  FROM embedding_sets e LEFT JOIN symbols s ON s.symbol_id=e.symbol_id WHERE e.set_id=NEW.set_id;
END;

CREATE TRIGGER vector_scan_update AFTER UPDATE OF set_id,chunk_index,dimensions,values_blob ON vectors BEGIN
  DELETE FROM vector_scan WHERE set_id=OLD.set_id AND chunk_index=OLD.chunk_index;
  INSERT INTO vector_scan(set_id,chunk_index,symbol_id,model_fingerprint,ready,context_id,kind,dimensions,values_blob)
  SELECT NEW.set_id,NEW.chunk_index,e.symbol_id,e.model_fingerprint,e.state='ready',s.defining_context_id,s.kind,NEW.dimensions,NEW.values_blob
  FROM embedding_sets e LEFT JOIN symbols s ON s.symbol_id=e.symbol_id WHERE e.set_id=NEW.set_id;
END;

-- Also fires for ON DELETE CASCADE from embedding_sets.
CREATE TRIGGER vector_scan_delete AFTER DELETE ON vectors BEGIN
  DELETE FROM vector_scan WHERE set_id=OLD.set_id AND chunk_index=OLD.chunk_index;
END;

CREATE TRIGGER vector_scan_set_update AFTER UPDATE OF set_id,symbol_id,model_fingerprint,state ON embedding_sets BEGIN
  UPDATE vector_scan SET set_id=NEW.set_id,symbol_id=NEW.symbol_id,model_fingerprint=NEW.model_fingerprint,ready=NEW.state='ready',
    context_id=(SELECT defining_context_id FROM symbols WHERE symbol_id=NEW.symbol_id),kind=(SELECT kind FROM symbols WHERE symbol_id=NEW.symbol_id)
  WHERE set_id=OLD.set_id;
END;

CREATE TRIGGER vector_scan_symbol_update AFTER UPDATE OF defining_context_id,kind ON symbols
WHEN OLD.defining_context_id IS NOT NEW.defining_context_id OR OLD.kind IS NOT NEW.kind BEGIN
  UPDATE vector_scan SET context_id=NEW.defining_context_id,kind=NEW.kind WHERE symbol_id=NEW.symbol_id;
END;
