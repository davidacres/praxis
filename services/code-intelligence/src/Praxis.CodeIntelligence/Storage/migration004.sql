-- Revision changes alone do not change the external-content FTS token stream.
-- Keep source/revision freshness updates atomic while avoiding delete/reinsert
-- of every unchanged document after a conservative whole-context publication.
DROP TRIGGER search_update;
CREATE TRIGGER search_update AFTER UPDATE ON search_documents
WHEN OLD.search_id IS NOT NEW.search_id
  OR OLD.name IS NOT NEW.name
  OR OLD.signature IS NOT NEW.signature
  OR OLD.documentation IS NOT NEW.documentation
  OR OLD.description IS NOT NEW.description
BEGIN
  INSERT INTO symbol_fts(symbol_fts,rowid,name,signature,documentation,description)
  VALUES('delete',OLD.search_id,OLD.name,OLD.signature,OLD.documentation,OLD.description);
  INSERT INTO symbol_fts(rowid,name,signature,documentation,description)
  VALUES(NEW.search_id,NEW.name,NEW.signature,NEW.documentation,NEW.description);
END;
