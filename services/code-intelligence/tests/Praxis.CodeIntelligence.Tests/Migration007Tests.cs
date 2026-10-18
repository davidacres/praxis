using Microsoft.Data.Sqlite;
using Praxis.CodeIntelligence.Storage;
using Xunit;

namespace Praxis.CodeIntelligence.Tests;

public sealed class Migration007Tests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), "praxis-migration007-tests-" + Guid.NewGuid().ToString("N"));
    private IndexDatabase Database => new(Path.Combine(root, "index.db"));

    public void Dispose()
    {
        if (Directory.Exists(root))
            Directory.Delete(root, recursive: true);
    }

    [Fact]
    public void ApplyingMigration007SetsSchemaVersion7AndPassesIntegrityCheck()
    {
        Database.Initialize();
        Assert.Empty(Database.Check());

        using var connection = Database.Open(readOnly: true);
        using var command = connection.CreateCommand();

        command.CommandText = "PRAGMA user_version;";
        Assert.Equal(7L, Convert.ToInt64(command.ExecuteScalar()));

        command.CommandText = "SELECT count(*) FROM schema_migrations WHERE version = 7;";
        Assert.Equal(1L, Convert.ToInt64(command.ExecuteScalar()));
    }

    [Fact]
    public void DocumentsTableEnforcesDocTypeAndValidationConstraints()
    {
        Database.Initialize();
        using var connection = Database.Open();

        using (var setup = connection.CreateCommand())
        {
            setup.CommandText = "INSERT INTO repositories(repository_id, canonical_root, path_policy) VALUES('repo-1', '/repo1', 'caseSensitive');";
            setup.ExecuteNonQuery();
        }

        // Valid insert
        using (var insert = connection.CreateCommand())
        {
            insert.CommandText = """
                INSERT INTO documents(document_id, repository_id, relative_path, path_key, content_hash, doc_type, title, frontmatter_json, size_bytes)
                VALUES('doc-1', 'repo-1', 'docs/readme.md', 'docs/readme.md', 'hash1', 'markdown', 'Readme', '{"tag":"test"}', 100);
                """;
            Assert.Equal(1, insert.ExecuteNonQuery());
        }

        // Invalid doc_type
        using (var invalidType = connection.CreateCommand())
        {
            invalidType.CommandText = """
                INSERT INTO documents(document_id, repository_id, relative_path, path_key, content_hash, doc_type, title, frontmatter_json, size_bytes)
                VALUES('doc-invalid-type', 'repo-1', 'docs/foo.txt', 'docs/foo.txt', 'h', 'invalid_type', 'Foo', '{}', 10);
                """;
            Assert.Throws<SqliteException>(() => invalidType.ExecuteNonQuery());
        }

        // Negative size_bytes
        using (var invalidSize = connection.CreateCommand())
        {
            invalidSize.CommandText = """
                INSERT INTO documents(document_id, repository_id, relative_path, path_key, content_hash, doc_type, title, frontmatter_json, size_bytes)
                VALUES('doc-invalid-size', 'repo-1', 'docs/foo2.txt', 'docs/foo2.txt', 'h', 'general', 'Foo', '{}', -1);
                """;
            Assert.Throws<SqliteException>(() => invalidSize.ExecuteNonQuery());
        }

        // Invalid frontmatter JSON
        using (var invalidJson = connection.CreateCommand())
        {
            invalidJson.CommandText = """
                INSERT INTO documents(document_id, repository_id, relative_path, path_key, content_hash, doc_type, title, frontmatter_json, size_bytes)
                VALUES('doc-invalid-json', 'repo-1', 'docs/foo3.txt', 'docs/foo3.txt', 'h', 'plan', 'Foo', '{not-json}', 10);
                """;
            Assert.Throws<SqliteException>(() => invalidJson.ExecuteNonQuery());
        }

        // Duplicate repository_id, path_key
        using (var duplicate = connection.CreateCommand())
        {
            duplicate.CommandText = """
                INSERT INTO documents(document_id, repository_id, relative_path, path_key, content_hash, doc_type, title, frontmatter_json, size_bytes)
                VALUES('doc-2', 'repo-1', 'docs/readme.md', 'docs/readme.md', 'hash2', 'spec', 'Other', '{}', 200);
                """;
            Assert.Throws<SqliteException>(() => duplicate.ExecuteNonQuery());
        }

        // Repository cascade delete removes document
        using (var deleteRepo = connection.CreateCommand())
        {
            deleteRepo.CommandText = "DELETE FROM repositories WHERE repository_id = 'repo-1';";
            deleteRepo.ExecuteNonQuery();
        }

        using (var count = connection.CreateCommand())
        {
            count.CommandText = "SELECT count(*) FROM documents WHERE repository_id = 'repo-1';";
            Assert.Equal(0L, count.ExecuteScalar());
        }
    }

    [Fact]
    public void KnowledgeSectionsEnforcesLineOffsetAndUniqueConstraints()
    {
        Database.Initialize();
        using var connection = Database.Open();

        using (var setup = connection.CreateCommand())
        {
            setup.CommandText = """
                INSERT INTO repositories(repository_id, canonical_root, path_policy) VALUES('repo-1', '/repo1', 'caseSensitive');
                INSERT INTO documents(document_id, repository_id, relative_path, path_key, content_hash, doc_type, title, frontmatter_json, size_bytes)
                VALUES('doc-1', 'repo-1', 'docs/spec.md', 'docs/spec.md', 'hash1', 'spec', 'Spec', '{}', 100);
                """;
            setup.ExecuteNonQuery();
        }

        // Valid section
        using (var insert = connection.CreateCommand())
        {
            insert.CommandText = """
                INSERT INTO knowledge_sections(section_id, document_id, section_index, heading, heading_path, start_line, end_line, start_offset, end_offset, section_hash, body)
                VALUES('sec-1', 'doc-1', 0, 'Intro', 'Intro', 1, 10, 0, 100, 'shash1', 'Introductory text.');
                """;
            Assert.Equal(1, insert.ExecuteNonQuery());
        }

        // Invalid section_index (< 0)
        using (var invalidIndex = connection.CreateCommand())
        {
            invalidIndex.CommandText = """
                INSERT INTO knowledge_sections(section_id, document_id, section_index, heading, heading_path, start_line, end_line, start_offset, end_offset, section_hash, body)
                VALUES('sec-inv-idx', 'doc-1', -1, 'Bad', 'Bad', 1, 10, 0, 100, 'shash', 'Bad index');
                """;
            Assert.Throws<SqliteException>(() => invalidIndex.ExecuteNonQuery());
        }

        // end_line < start_line
        using (var invalidLine = connection.CreateCommand())
        {
            invalidLine.CommandText = """
                INSERT INTO knowledge_sections(section_id, document_id, section_index, heading, heading_path, start_line, end_line, start_offset, end_offset, section_hash, body)
                VALUES('sec-inv-line', 'doc-1', 1, 'Bad', 'Bad', 10, 5, 0, 100, 'shash', 'Bad line');
                """;
            Assert.Throws<SqliteException>(() => invalidLine.ExecuteNonQuery());
        }

        // end_offset < start_offset
        using (var invalidOffset = connection.CreateCommand())
        {
            invalidOffset.CommandText = """
                INSERT INTO knowledge_sections(section_id, document_id, section_index, heading, heading_path, start_line, end_line, start_offset, end_offset, section_hash, body)
                VALUES('sec-inv-off', 'doc-1', 1, 'Bad', 'Bad', 1, 10, 100, 50, 'shash', 'Bad offset');
                """;
            Assert.Throws<SqliteException>(() => invalidOffset.ExecuteNonQuery());
        }

        // Duplicate (document_id, section_index)
        using (var duplicate = connection.CreateCommand())
        {
            duplicate.CommandText = """
                INSERT INTO knowledge_sections(section_id, document_id, section_index, heading, heading_path, start_line, end_line, start_offset, end_offset, section_hash, body)
                VALUES('sec-dup', 'doc-1', 0, 'Dup', 'Dup', 1, 10, 0, 100, 'shash2', 'Duplicate index');
                """;
            Assert.Throws<SqliteException>(() => duplicate.ExecuteNonQuery());
        }
    }

    [Fact]
    public void KnowledgeFtsTriggersSynchronizeOnInsertAndDelete()
    {
        Database.Initialize();
        using var connection = Database.Open();

        using (var setup = connection.CreateCommand())
        {
            setup.CommandText = """
                INSERT INTO repositories(repository_id, canonical_root, path_policy) VALUES('repo-1', '/repo1', 'caseSensitive');
                INSERT INTO documents(document_id, repository_id, relative_path, path_key, content_hash, doc_type, title, frontmatter_json, size_bytes)
                VALUES('doc-1', 'repo-1', 'docs/arch.md', 'docs/arch.md', 'hash1', 'markdown', 'Architecture Guide', '{"component":"storage","owner":"alice"}', 500);
                """;
            setup.ExecuteNonQuery();
        }

        // Insert section
        using (var insertSec = connection.CreateCommand())
        {
            insertSec.CommandText = """
                INSERT INTO knowledge_sections(section_id, document_id, section_index, heading, heading_path, start_line, end_line, start_offset, end_offset, section_hash, body)
                VALUES('sec-1', 'doc-1', 0, 'Database Layer', 'Architecture > Storage > Database Layer', 1, 20, 0, 250, 'hashsec1', 'SQLite provides transactional durability and fast reads.');
                """;
            insertSec.ExecuteNonQuery();
        }

        // Verify FTS matches title, heading_path, body, frontmatter
        long MatchCount(string query)
        {
            using var cmd = connection.CreateCommand();
            cmd.CommandText = "SELECT count(*) FROM knowledge_fts WHERE knowledge_fts MATCH $q;";
            cmd.Parameters.AddWithValue("$q", query);
            return Convert.ToInt64(cmd.ExecuteScalar());
        }

        Assert.Equal(1L, MatchCount("Architecture"));
        Assert.Equal(1L, MatchCount("Database"));
        Assert.Equal(1L, MatchCount("SQLite"));
        Assert.Equal(1L, MatchCount("storage"));
        Assert.Equal(1L, MatchCount("alice"));
        Assert.Equal(0L, MatchCount("NonExistentTerm"));

        // Delete section -> trigger removes from knowledge_fts
        using (var deleteSec = connection.CreateCommand())
        {
            deleteSec.CommandText = "DELETE FROM knowledge_sections WHERE section_id = 'sec-1';";
            deleteSec.ExecuteNonQuery();
        }

        Assert.Equal(0L, MatchCount("Architecture"));
        Assert.Equal(0L, MatchCount("SQLite"));

        // Test cascade delete of document
        using (var insertSec2 = connection.CreateCommand())
        {
            insertSec2.CommandText = """
                INSERT INTO knowledge_sections(section_id, document_id, section_index, heading, heading_path, start_line, end_line, start_offset, end_offset, section_hash, body)
                VALUES('sec-2', 'doc-1', 0, 'Cache', 'Architecture > Cache', 1, 10, 0, 100, 'hashsec2', 'In-memory cache layer.');
                """;
            insertSec2.ExecuteNonQuery();
        }

        Assert.Equal(1L, MatchCount("Cache"));

        using (var deleteDoc = connection.CreateCommand())
        {
            deleteDoc.CommandText = "DELETE FROM documents WHERE document_id = 'doc-1';";
            deleteDoc.ExecuteNonQuery();
        }

        Assert.Equal(0L, MatchCount("Cache"));
        Assert.Empty(Database.Check());
    }

    [Fact]
    public void KnowledgeRepresentationTargetsVectorsAndLinksEnforceConstraints()
    {
        Database.Initialize();
        using var connection = Database.Open();

        using (var setup = connection.CreateCommand())
        {
            setup.CommandText = """
                INSERT INTO repositories(repository_id, canonical_root, path_policy) VALUES('repo-1', '/repo1', 'caseSensitive');
                INSERT INTO model_profiles(fingerprint, manifest_json, dimensions, metric, representation_version)
                VALUES('sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef01234567', '{}', 384, 'cosine', 1);
                INSERT INTO documents(document_id, repository_id, relative_path, path_key, content_hash, doc_type, title, frontmatter_json, size_bytes)
                VALUES('doc-1', 'repo-1', 'docs/spec.md', 'docs/spec.md', 'h1', 'spec', 'Spec', '{}', 100);
                INSERT INTO knowledge_sections(section_id, document_id, section_index, heading, heading_path, start_line, end_line, start_offset, end_offset, section_hash, body)
                VALUES('sec-1', 'doc-1', 0, 'Header', 'Header', 1, 5, 0, 50, 'shash', 'Section content.');
                """;
            setup.ExecuteNonQuery();
        }

        // Targets
        using (var insertTarget = connection.CreateCommand())
        {
            insertTarget.CommandText = """
                INSERT INTO knowledge_representation_targets(section_id, model_fingerprint, input_revision, representation_hash, eligibility)
                VALUES('sec-1', 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef01234567', 'rev1', 'rep_hash', 'eligible');
                """;
            Assert.Equal(1, insertTarget.ExecuteNonQuery());
        }

        // Vectors - 384 dimensions * 4 = 1536 bytes
        var validBlob = new byte[384 * 4];
        using (var insertVector = connection.CreateCommand())
        {
            insertVector.CommandText = """
                INSERT INTO knowledge_vectors(section_id, model_fingerprint, dimensions, values_blob)
                VALUES('sec-1', 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef01234567', 384, $blob);
                """;
            insertVector.Parameters.AddWithValue("$blob", validBlob);
            Assert.Equal(1, insertVector.ExecuteNonQuery());
        }

        // Invalid vector size
        var invalidBlob = new byte[100];
        using (var invalidVector = connection.CreateCommand())
        {
            invalidVector.CommandText = """
                INSERT INTO knowledge_vectors(section_id, model_fingerprint, dimensions, values_blob)
                VALUES('sec-1', 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef01234567', 384, $blob);
                """;
            invalidVector.Parameters.AddWithValue("$blob", invalidBlob);
            Assert.Throws<SqliteException>(() => invalidVector.ExecuteNonQuery());
        }

        // Links
        using (var insertLink = connection.CreateCommand())
        {
            insertLink.CommandText = """
                INSERT INTO knowledge_links(link_id, section_id, target_kind, target_symbol_id, target_key, provenance)
                VALUES('link-1', 'sec-1', 'file', NULL, 'src/Program.cs', 'explicit_link');
                """;
            Assert.Equal(1, insertLink.ExecuteNonQuery());
        }

        // Cascade delete on section removes target, vector, link
        using (var deleteSec = connection.CreateCommand())
        {
            deleteSec.CommandText = "DELETE FROM knowledge_sections WHERE section_id = 'sec-1';";
            deleteSec.ExecuteNonQuery();
        }

        long RowCount(string table)
        {
            using var cmd = connection.CreateCommand();
            cmd.CommandText = $"SELECT count(*) FROM {table};";
            return Convert.ToInt64(cmd.ExecuteScalar());
        }

        Assert.Equal(0L, RowCount("knowledge_representation_targets"));
        Assert.Equal(0L, RowCount("knowledge_vectors"));
        Assert.Equal(0L, RowCount("knowledge_links"));
        Assert.Empty(Database.Check());
    }

    [Fact]
    public void DocumentStoreCanUpsertAndRetrieveDocumentsAndSections()
    {
        Database.Initialize();
        using (var connection = Database.Open())
        {
            connection.Execute(null, "INSERT INTO repositories(repository_id, canonical_root, path_policy) VALUES('repo-1', '/repo1', 'caseSensitive');");
        }

        var store = new DocumentStore(Database);
        var doc = new DocumentRecord("doc-1", "repo-1", "docs/guide.md", DocumentStore.ComputePathKey("docs/guide.md"), "chash1", "markdown", "User Guide", "{\"version\":1}", 2048);
        var sections = new List<DocumentSectionInput>
        {
            new("Introduction", "User Guide > Introduction", 1, 15, 0, 300, "hash_intro", "Welcome to Praxis."),
            new("Getting Started", "User Guide > Getting Started", 16, 40, 301, 800, "hash_started", "To install, run the installer.")
        };

        var result = store.UpsertDocument(doc, sections);
        Assert.Equal("doc-1", result.Document.DocumentId);
        Assert.Equal(2, result.CasResult.AddedSections.Count);
        Assert.Empty(result.CasResult.KeptSections);
        Assert.Empty(result.CasResult.RemovedSectionIds);

        // Retrieve by Id
        var retrievedById = store.GetDocumentById("doc-1");
        Assert.NotNull(retrievedById);
        Assert.Equal("User Guide", retrievedById.Title);
        Assert.Equal("markdown", retrievedById.DocType);
        Assert.Equal(2048, retrievedById.SizeBytes);

        // Retrieve by Path
        var retrievedByPath = store.GetDocumentByPath("repo-1", "docs/guide.md");
        Assert.NotNull(retrievedByPath);
        Assert.Equal("doc-1", retrievedByPath.DocumentId);

        // List
        var list = store.ListDocuments("repo-1");
        Assert.Single(list);

        // Sections
        var loadedSections = store.GetSections("doc-1");
        Assert.Equal(2, loadedSections.Count);
        Assert.Equal("Introduction", loadedSections[0].Heading);
        Assert.Equal("Getting Started", loadedSections[1].Heading);

        var singleSec = store.GetSection(loadedSections[0].SectionId);
        Assert.NotNull(singleSec);
        Assert.Equal("Welcome to Praxis.", singleSec.Body);
    }

    [Fact]
    public void DocumentStoreSectionHashCasPreservesUnchangedVectors()
    {
        Database.Initialize();
        using (var connection = Database.Open())
        {
            connection.Execute(null, """
                INSERT INTO repositories(repository_id, canonical_root, path_policy) VALUES('repo-1', '/repo1', 'caseSensitive');
                INSERT INTO model_profiles(fingerprint, manifest_json, dimensions, metric, representation_version)
                VALUES('sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef01234567', '{}', 384, 'cosine', 1);
                """);
        }

        var store = new DocumentStore(Database);
        var doc = new DocumentRecord("doc-cas", "repo-1", "docs/cas.md", DocumentStore.ComputePathKey("docs/cas.md"), "chash1", "markdown", "CAS Document", "{}", 1000);

        var initialSections = new List<DocumentSectionInput>
        {
            new("Section A", "CAS > Section A", 1, 10, 0, 100, "hash_A", "Body A"),
            new("Section B", "CAS > Section B", 11, 20, 101, 200, "hash_B", "Body B"),
            new("Section C", "CAS > Section C", 21, 30, 201, 300, "hash_C", "Body C")
        };

        var initialResult = store.UpsertDocument(doc, initialSections);
        Assert.Equal(3, initialResult.CasResult.AddedSections.Count);

        var sectionAId = initialResult.CasResult.AddedSections[0].SectionId;
        var sectionBId = initialResult.CasResult.AddedSections[1].SectionId;
        var sectionCId = initialResult.CasResult.AddedSections[2].SectionId;

        // Populate knowledge_vectors for all 3 sections
        var fingerprint = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef01234567";
        var dummyBlob = new byte[384 * 4];
        dummyBlob[0] = 0x42; // tag Section B's vector
        dummyBlob[4] = 0x99;

        using (var connection = Database.Open())
        {
            connection.Execute(null,
                "INSERT INTO knowledge_vectors(section_id, model_fingerprint, dimensions, values_blob) VALUES($0, $1, 384, $2);",
                sectionAId, fingerprint, new byte[384 * 4]);
            connection.Execute(null,
                "INSERT INTO knowledge_vectors(section_id, model_fingerprint, dimensions, values_blob) VALUES($0, $1, 384, $2);",
                sectionBId, fingerprint, dummyBlob);
            connection.Execute(null,
                "INSERT INTO knowledge_vectors(section_id, model_fingerprint, dimensions, values_blob) VALUES($0, $1, 384, $2);",
                sectionCId, fingerprint, new byte[384 * 4]);
        }

        // Install a trigger: abort if Section B's vector is deleted or modified
        using (var connection = Database.Open())
        {
            using var cmd = connection.CreateCommand();
            cmd.CommandText = $"""
                CREATE TRIGGER forbid_section_b_delete BEFORE DELETE ON knowledge_vectors
                WHEN OLD.section_id = '{sectionBId}'
                BEGIN
                    SELECT RAISE(ABORT, 'Unchanged section vector must not be deleted!');
                END;
                """;
            cmd.ExecuteNonQuery();
        }

        // Now edit the document:
        // - Section A is edited (new hash)
        // - Section B is unchanged (same hash "hash_B", shifted lines)
        // - Section C is removed
        // - Section D is new
        var updatedDoc = new DocumentRecord("doc-cas", "repo-1", "docs/cas.md", DocumentStore.ComputePathKey("docs/cas.md"), "chash2", "markdown", "CAS Document Edited", "{}", 1200);
        var editedSections = new List<DocumentSectionInput>
        {
            new("Section A Modified", "CAS > Section A Modified", 1, 15, 0, 150, "hash_A_new", "Modified Body A"),
            new("Section B", "CAS > Section B", 16, 25, 151, 250, "hash_B", "Body B"), // identical hash!
            new("Section D", "CAS > Section D", 26, 40, 251, 400, "hash_D", "Body D")
        };

        var editResult = store.UpsertDocument(updatedDoc, editedSections);

        // Verify CAS results
        Assert.Single(editResult.CasResult.KeptSections);
        Assert.Equal(sectionBId, editResult.CasResult.KeptSections[0].SectionId);
        Assert.Equal(2, editResult.CasResult.AddedSections.Count); // A Modified and D
        Assert.Equal(2, editResult.CasResult.RemovedSectionIds.Count); // Old A and C
        Assert.Contains(sectionAId, editResult.CasResult.RemovedSectionIds);
        Assert.Contains(sectionCId, editResult.CasResult.RemovedSectionIds);

        // Verify Section B's vector blob is preserved intact!
        using (var connection = Database.Open(readOnly: true))
        {
            using var cmd = connection.CreateCommand();
            cmd.CommandText = "SELECT values_blob FROM knowledge_vectors WHERE section_id = $0;";
            cmd.Parameters.AddWithValue("$0", sectionBId);
            var readBlob = (byte[])cmd.ExecuteScalar()!;
            Assert.NotNull(readBlob);
            Assert.Equal(0x42, readBlob[0]);
            Assert.Equal(0x99, readBlob[4]);

            // And old A and C vectors are gone
            cmd.CommandText = "SELECT count(*) FROM knowledge_vectors WHERE section_id IN ($0, $1);";
            cmd.Parameters.Clear();
            cmd.Parameters.AddWithValue("$0", sectionAId);
            cmd.Parameters.AddWithValue("$1", sectionCId);
            Assert.Equal(0L, cmd.ExecuteScalar());
        }

        Assert.Empty(Database.Check());
    }

    [Fact]
    public void DocumentStoreDeleteRemovesDocumentAndCascadesToSectionsAndFts()
    {
        Database.Initialize();
        using (var connection = Database.Open())
        {
            connection.Execute(null, "INSERT INTO repositories(repository_id, canonical_root, path_policy) VALUES('repo-1', '/repo1', 'caseSensitive');");
        }

        var store = new DocumentStore(Database);
        var doc = new DocumentRecord("doc-del", "repo-1", "docs/delete_me.md", DocumentStore.ComputePathKey("docs/delete_me.md"), "h1", "general", "To Delete", "{}", 100);
        var sections = new List<DocumentSectionInput>
        {
            new("Heading", "To Delete > Heading", 1, 5, 0, 50, "hash1", "Content to be wiped.")
        };

        store.UpsertDocument(doc, sections);
        Assert.NotNull(store.GetDocumentById("doc-del"));
        Assert.NotEmpty(store.GetSections("doc-del"));

        using (var connection = Database.Open(readOnly: true))
        {
            using var cmd = connection.CreateCommand();
            cmd.CommandText = "SELECT count(*) FROM knowledge_fts WHERE knowledge_fts MATCH 'wiped';";
            Assert.Equal(1L, cmd.ExecuteScalar());
        }

        Assert.True(store.DeleteDocument("doc-del"));
        Assert.Null(store.GetDocumentById("doc-del"));
        Assert.Empty(store.GetSections("doc-del"));

        using (var connection = Database.Open(readOnly: true))
        {
            using var cmd = connection.CreateCommand();
            cmd.CommandText = "SELECT count(*) FROM knowledge_fts WHERE knowledge_fts MATCH 'wiped';";
            Assert.Equal(0L, cmd.ExecuteScalar());
        }

        Assert.Empty(Database.Check());
    }
}
