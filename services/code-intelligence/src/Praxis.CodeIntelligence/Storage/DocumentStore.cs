using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace Praxis.CodeIntelligence.Storage;

public sealed record DocumentRecord(
    string DocumentId,
    string RepositoryId,
    string RelativePath,
    string PathKey,
    string ContentHash,
    string DocType,
    string Title,
    string FrontmatterJson = "{}",
    long SizeBytes = 0
);

public sealed record KnowledgeSectionRecord(
    string SectionId,
    string DocumentId,
    int SectionIndex,
    string Heading,
    string HeadingPath,
    int StartLine,
    int EndLine,
    int StartOffset,
    int EndOffset,
    string SectionHash,
    string Body
);

public sealed record DocumentSectionInput(
    string Heading,
    string HeadingPath,
    int StartLine,
    int EndLine,
    int StartOffset,
    int EndOffset,
    string SectionHash,
    string Body,
    int? SectionIndex = null,
    string? SectionId = null
);

public sealed record SectionCasResult(
    IReadOnlyList<KnowledgeSectionRecord> KeptSections,
    IReadOnlyList<KnowledgeSectionRecord> AddedSections,
    IReadOnlyList<string> RemovedSectionIds
);

public sealed record UpsertDocumentResult(
    DocumentRecord Document,
    SectionCasResult CasResult
);

public sealed class DocumentStore(IndexDatabase database)
{
    private static readonly HashSet<string> ValidDocTypes = new(StringComparer.Ordinal)
    {
        "markdown", "word", "presentation", "sheet", "plan", "spec", "general"
    };

    public static string ComputePathKey(string relativePath) =>
        OperatingSystem.IsWindows() ? relativePath.ToUpperInvariant() : relativePath;

    public DocumentRecord? GetDocumentById(string documentId)
    {
        using var connection = database.Open(readOnly: true);
        using var command = connection.Command(null,
            """
            SELECT document_id, repository_id, relative_path, path_key, content_hash, doc_type, title, frontmatter_json, size_bytes
            FROM documents WHERE document_id = $0
            """, documentId);
        using var reader = command.ExecuteReader();
        return reader.Read() ? ReadDocument(reader) : null;
    }

    public DocumentRecord? GetDocumentByPath(string repositoryId, string relativePath)
    {
        var pathKey = ComputePathKey(relativePath);
        return GetDocumentByPathKey(repositoryId, pathKey);
    }

    public DocumentRecord? GetDocumentByPathKey(string repositoryId, string pathKey)
    {
        using var connection = database.Open(readOnly: true);
        using var command = connection.Command(null,
            """
            SELECT document_id, repository_id, relative_path, path_key, content_hash, doc_type, title, frontmatter_json, size_bytes
            FROM documents WHERE repository_id = $0 AND path_key = $1
            """, repositoryId, pathKey);
        using var reader = command.ExecuteReader();
        return reader.Read() ? ReadDocument(reader) : null;
    }

    public IReadOnlyList<DocumentRecord> ListDocuments(string repositoryId)
    {
        using var connection = database.Open(readOnly: true);
        using var command = connection.Command(null,
            """
            SELECT document_id, repository_id, relative_path, path_key, content_hash, doc_type, title, frontmatter_json, size_bytes
            FROM documents WHERE repository_id = $0 ORDER BY relative_path
            """, repositoryId);
        using var reader = command.ExecuteReader();
        var documents = new List<DocumentRecord>();
        while (reader.Read()) documents.Add(ReadDocument(reader));
        return documents;
    }

    public bool DeleteDocument(SqliteConnection connection, SqliteTransaction transaction, string documentId)
    {
        var rows = connection.Execute(transaction, "DELETE FROM documents WHERE document_id = $0", documentId);
        return rows > 0;
    }

    public bool DeleteDocument(string documentId)
    {
        using var connection = database.Open();
        using var transaction = connection.BeginTransaction(deferred: false);
        var result = DeleteDocument(connection, transaction, documentId);
        transaction.Commit();
        return result;
    }

    public bool DeleteDocumentByPath(string repositoryId, string relativePath)
    {
        var pathKey = ComputePathKey(relativePath);
        using var connection = database.Open();
        using var transaction = connection.BeginTransaction(deferred: false);
        var rows = connection.Execute(transaction,
            "DELETE FROM documents WHERE repository_id = $0 AND path_key = $1", repositoryId, pathKey);
        transaction.Commit();
        return rows > 0;
    }

    public IReadOnlyList<KnowledgeSectionRecord> GetSections(string documentId)
    {
        using var connection = database.Open(readOnly: true);
        using var command = connection.Command(null,
            """
            SELECT section_id, document_id, section_index, heading, heading_path, start_line, end_line, start_offset, end_offset, section_hash, body
            FROM knowledge_sections WHERE document_id = $0 ORDER BY section_index
            """, documentId);
        using var reader = command.ExecuteReader();
        var sections = new List<KnowledgeSectionRecord>();
        while (reader.Read()) sections.Add(ReadSection(reader));
        return sections;
    }

    public KnowledgeSectionRecord? GetSection(string sectionId)
    {
        using var connection = database.Open(readOnly: true);
        using var command = connection.Command(null,
            """
            SELECT section_id, document_id, section_index, heading, heading_path, start_line, end_line, start_offset, end_offset, section_hash, body
            FROM knowledge_sections WHERE section_id = $0
            """, sectionId);
        using var reader = command.ExecuteReader();
        return reader.Read() ? ReadSection(reader) : null;
    }

    public UpsertDocumentResult UpsertDocument(DocumentRecord document, IReadOnlyList<KnowledgeSectionRecord> sections) =>
        UpsertDocument(document, sections.Select(s => new DocumentSectionInput(
            s.Heading, s.HeadingPath, s.StartLine, s.EndLine, s.StartOffset, s.EndOffset, s.SectionHash, s.Body, s.SectionIndex, s.SectionId)).ToList());

    public UpsertDocumentResult UpsertDocument(SqliteConnection connection, SqliteTransaction transaction, DocumentRecord document, IReadOnlyList<KnowledgeSectionRecord> sections) =>
        UpsertDocument(connection, transaction, document, sections.Select(s => new DocumentSectionInput(
            s.Heading, s.HeadingPath, s.StartLine, s.EndLine, s.StartOffset, s.EndOffset, s.SectionHash, s.Body, s.SectionIndex, s.SectionId)).ToList());

    public UpsertDocumentResult UpsertDocument(DocumentRecord document, IReadOnlyList<DocumentSectionInput> sections)
    {
        using var connection = database.Open();
        using var transaction = connection.BeginTransaction(deferred: false);
        var result = UpsertDocument(connection, transaction, document, sections);
        transaction.Commit();
        return result;
    }

    public UpsertDocumentResult UpsertDocument(SqliteConnection connection, SqliteTransaction transaction, DocumentRecord document, IReadOnlyList<DocumentSectionInput> sections)
    {
        if (!ValidDocTypes.Contains(document.DocType))
            throw new ArgumentException($"Invalid doc_type: {document.DocType}", nameof(document));

        var pathKey = string.IsNullOrEmpty(document.PathKey)
            ? ComputePathKey(document.RelativePath)
            : document.PathKey;

        var existingDocId = connection.Scalar(transaction,
            "SELECT document_id FROM documents WHERE repository_id = $0 AND path_key = $1",
            document.RepositoryId, pathKey) as string;

        var documentId = existingDocId ?? (!string.IsNullOrEmpty(document.DocumentId)
            ? document.DocumentId
            : "pci:doc:" + Guid.NewGuid().ToString("N"));

        var frontmatter = string.IsNullOrEmpty(document.FrontmatterJson) ? "{}" : document.FrontmatterJson;

        if (existingDocId is not null)
        {
            connection.Execute(transaction,
                """
                UPDATE documents SET
                    relative_path = $1,
                    content_hash = $2,
                    doc_type = $3,
                    title = $4,
                    frontmatter_json = $5,
                    size_bytes = $6
                WHERE document_id = $0
                """,
                documentId, document.RelativePath, document.ContentHash, document.DocType,
                document.Title, frontmatter, document.SizeBytes);
        }
        else
        {
            connection.Execute(transaction,
                """
                INSERT INTO documents(document_id, repository_id, relative_path, path_key, content_hash, doc_type, title, frontmatter_json, size_bytes)
                VALUES($0, $1, $2, $3, $4, $5, $6, $7, $8)
                """,
                documentId, document.RepositoryId, document.RelativePath, pathKey,
                document.ContentHash, document.DocType, document.Title, frontmatter, document.SizeBytes);
        }

        var casResult = ReconcileSectionsInternal(connection, transaction, documentId, sections);

        var updatedDoc = new DocumentRecord(
            documentId, document.RepositoryId, document.RelativePath, pathKey,
            document.ContentHash, document.DocType, document.Title, frontmatter, document.SizeBytes);

        return new UpsertDocumentResult(updatedDoc, casResult);
    }

    public SectionCasResult ReconcileSections(string documentId, IReadOnlyList<DocumentSectionInput> incomingSections)
    {
        using var connection = database.Open();
        using var transaction = connection.BeginTransaction(deferred: false);
        var result = ReconcileSectionsInternal(connection, transaction, documentId, incomingSections);
        transaction.Commit();
        return result;
    }

    private static SectionCasResult ReconcileSectionsInternal(
        SqliteConnection connection,
        SqliteTransaction transaction,
        string documentId,
        IReadOnlyList<DocumentSectionInput> incomingSections)
    {
        var existing = new List<KnowledgeSectionRecord>();
        using (var command = connection.Command(transaction,
            """
            SELECT section_id, document_id, section_index, heading, heading_path, start_line, end_line, start_offset, end_offset, section_hash, body
            FROM knowledge_sections WHERE document_id = $0 ORDER BY section_index
            """, documentId))
        using (var reader = command.ExecuteReader())
        {
            while (reader.Read()) existing.Add(ReadSection(reader));
        }

        var matchedExistingIds = new HashSet<string>(StringComparer.Ordinal);
        var matchByIncomingIndex = new Dictionary<int, KnowledgeSectionRecord>();
        var incomingWithIndex = incomingSections.Select((input, idx) => (Input: input, Index: input.SectionIndex ?? idx)).ToList();

        // Pass 1: exact match on (HeadingPath, SectionHash)
        for (var i = 0; i < incomingWithIndex.Count; i++)
        {
            var item = incomingWithIndex[i];
            var candidate = existing.FirstOrDefault(e =>
                !matchedExistingIds.Contains(e.SectionId) &&
                string.Equals(e.HeadingPath, item.Input.HeadingPath, StringComparison.Ordinal) &&
                string.Equals(e.SectionHash, item.Input.SectionHash, StringComparison.Ordinal));

            if (candidate is not null)
            {
                matchedExistingIds.Add(candidate.SectionId);
                matchByIncomingIndex[i] = candidate;
            }
        }

        // Pass 2: match on SectionHash only
        for (var i = 0; i < incomingWithIndex.Count; i++)
        {
            if (matchByIncomingIndex.ContainsKey(i)) continue;
            var item = incomingWithIndex[i];
            var candidate = existing.FirstOrDefault(e =>
                !matchedExistingIds.Contains(e.SectionId) &&
                string.Equals(e.SectionHash, item.Input.SectionHash, StringComparison.Ordinal));

            if (candidate is not null)
            {
                matchedExistingIds.Add(candidate.SectionId);
                matchByIncomingIndex[i] = candidate;
            }
        }

        var removedSectionIds = existing
            .Where(e => !matchedExistingIds.Contains(e.SectionId))
            .Select(e => e.SectionId)
            .ToList();

        // 1. Delete removed sections (cascades to vectors, representation targets, links, and triggers FTS delete)
        foreach (var removedId in removedSectionIds)
        {
            connection.Execute(transaction, "DELETE FROM knowledge_sections WHERE section_id = $0", removedId);
        }

        // 2. Temporarily shift kept sections' indices to prevent UNIQUE(document_id, section_index) collisions
        if (matchedExistingIds.Count > 0)
        {
            connection.Execute(transaction,
                "UPDATE knowledge_sections SET section_index = section_index + 1000000 WHERE document_id = $0",
                documentId);
        }

        var keptSections = new List<KnowledgeSectionRecord>();
        var addedSections = new List<KnowledgeSectionRecord>();

        // 3. Update kept sections and insert newly added sections
        for (var i = 0; i < incomingWithIndex.Count; i++)
        {
            var item = incomingWithIndex[i];
            if (matchByIncomingIndex.TryGetValue(i, out var oldSection))
            {
                var updated = new KnowledgeSectionRecord(
                    oldSection.SectionId,
                    documentId,
                    item.Index,
                    item.Input.Heading,
                    item.Input.HeadingPath,
                    item.Input.StartLine,
                    item.Input.EndLine,
                    item.Input.StartOffset,
                    item.Input.EndOffset,
                    item.Input.SectionHash,
                    item.Input.Body
                );

                connection.Execute(transaction,
                    """
                    UPDATE knowledge_sections SET
                        section_index = $1,
                        heading = $2,
                        heading_path = $3,
                        start_line = $4,
                        end_line = $5,
                        start_offset = $6,
                        end_offset = $7,
                        section_hash = $8,
                        body = $9
                    WHERE section_id = $0
                    """,
                    updated.SectionId, updated.SectionIndex, updated.Heading, updated.HeadingPath,
                    updated.StartLine, updated.EndLine, updated.StartOffset, updated.EndOffset,
                    updated.SectionHash, updated.Body);

                keptSections.Add(updated);
            }
            else
            {
                var sectionId = !string.IsNullOrEmpty(item.Input.SectionId)
                    ? item.Input.SectionId
                    : "pci:ksec:" + Guid.NewGuid().ToString("N");

                var added = new KnowledgeSectionRecord(
                    sectionId,
                    documentId,
                    item.Index,
                    item.Input.Heading,
                    item.Input.HeadingPath,
                    item.Input.StartLine,
                    item.Input.EndLine,
                    item.Input.StartOffset,
                    item.Input.EndOffset,
                    item.Input.SectionHash,
                    item.Input.Body
                );

                connection.Execute(transaction,
                    """
                    INSERT INTO knowledge_sections(
                        section_id, document_id, section_index, heading, heading_path,
                        start_line, end_line, start_offset, end_offset, section_hash, body)
                    VALUES($0, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                    """,
                    added.SectionId, added.DocumentId, added.SectionIndex, added.Heading, added.HeadingPath,
                    added.StartLine, added.EndLine, added.StartOffset, added.EndOffset,
                    added.SectionHash, added.Body);

                addedSections.Add(added);
            }
        }

        return new SectionCasResult(keptSections, addedSections, removedSectionIds);
    }

    private static DocumentRecord ReadDocument(SqliteDataReader reader) =>
        new(
            reader.GetString(0),
            reader.GetString(1),
            reader.GetString(2),
            reader.GetString(3),
            reader.GetString(4),
            reader.GetString(5),
            reader.GetString(6),
            reader.GetString(7),
            reader.GetInt64(8)
        );

    private static KnowledgeSectionRecord ReadSection(SqliteDataReader reader) =>
        new(
            reader.GetString(0),
            reader.GetString(1),
            reader.GetInt32(2),
            reader.GetString(3),
            reader.GetString(4),
            reader.GetInt32(5),
            reader.GetInt32(6),
            reader.GetInt32(7),
            reader.GetInt32(8),
            reader.GetString(9),
            reader.GetString(10)
        );
}
