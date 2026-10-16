-- Dense copy of exactly what the vector score pass reads, so an exhaustive
-- scan touches contiguous vector pages instead of joining every chunk to its
-- set and interleaving with span metadata. Triggers keep it in the same
-- transaction as every vectors/embedding_sets change; queries still validate
-- candidates against the source tables and rescore returned sets from vectors.
CREATE TABLE vector_scan (
  set_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  symbol_id TEXT NOT NULL,
  model_fingerprint TEXT NOT NULL,
  ready INTEGER NOT NULL CHECK(ready IN (0,1)),
  dimensions INTEGER NOT NULL,
  values_blob BLOB NOT NULL,
  PRIMARY KEY(set_id,chunk_index)
) STRICT;

INSERT INTO vector_scan(set_id,chunk_index,symbol_id,model_fingerprint,ready,dimensions,values_blob)
SELECT v.set_id,v.chunk_index,e.symbol_id,e.model_fingerprint,e.state='ready',v.dimensions,v.values_blob
FROM vectors v JOIN embedding_sets e ON e.set_id=v.set_id;

CREATE TRIGGER vector_scan_insert AFTER INSERT ON vectors BEGIN
  INSERT INTO vector_scan(set_id,chunk_index,symbol_id,model_fingerprint,ready,dimensions,values_blob)
  SELECT NEW.set_id,NEW.chunk_index,e.symbol_id,e.model_fingerprint,e.state='ready',NEW.dimensions,NEW.values_blob
  FROM embedding_sets e WHERE e.set_id=NEW.set_id;
END;

CREATE TRIGGER vector_scan_update AFTER UPDATE OF set_id,chunk_index,dimensions,values_blob ON vectors BEGIN
  DELETE FROM vector_scan WHERE set_id=OLD.set_id AND chunk_index=OLD.chunk_index;
  INSERT INTO vector_scan(set_id,chunk_index,symbol_id,model_fingerprint,ready,dimensions,values_blob)
  SELECT NEW.set_id,NEW.chunk_index,e.symbol_id,e.model_fingerprint,e.state='ready',NEW.dimensions,NEW.values_blob
  FROM embedding_sets e WHERE e.set_id=NEW.set_id;
END;

-- Also fires for ON DELETE CASCADE from embedding_sets.
CREATE TRIGGER vector_scan_delete AFTER DELETE ON vectors BEGIN
  DELETE FROM vector_scan WHERE set_id=OLD.set_id AND chunk_index=OLD.chunk_index;
END;

CREATE TRIGGER vector_scan_set_update AFTER UPDATE OF set_id,symbol_id,model_fingerprint,state ON embedding_sets BEGIN
  UPDATE vector_scan SET set_id=NEW.set_id,symbol_id=NEW.symbol_id,model_fingerprint=NEW.model_fingerprint,ready=NEW.state='ready'
  WHERE set_id=OLD.set_id;
END;
