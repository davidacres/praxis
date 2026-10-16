-- Bound exact signature retrieval by repository instead of scanning symbols.
CREATE INDEX symbol_signature ON symbols(repository_id, signature);
