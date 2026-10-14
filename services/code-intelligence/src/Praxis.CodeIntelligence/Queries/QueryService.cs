using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Data.Sqlite;
using Praxis.CodeIntelligence.Indexing;
using Praxis.CodeIntelligence.Storage;

namespace Praxis.CodeIntelligence.Queries;

public sealed class QueryService(IndexDatabase database)
{
    private readonly CursorCodec cursors = new();
    private static readonly JsonSerializerOptions Camel = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    public JsonObject Execute(string tool, JsonObject arguments, IReadOnlySet<string> allowedRepositories, CancellationToken cancellationToken = default)
    {
        var repositoryId = arguments["repositoryId"] is JsonValue value && value.TryGetValue<string>(out var id) ? id : "unknown";
        long? generation = null, epoch = null;
        try
        {
            JsonContract.Validate(tool, arguments);
            if (!allowedRepositories.Contains(repositoryId)) throw new QueryException("ACCESS_DENIED", "Repository access has not been granted.");
            cancellationToken.ThrowIfCancellationRequested();
            using var connection = database.Open(readOnly: true); using var transaction = connection.BeginTransaction(deferred: true);
            var repository = Rows(connection, transaction, "SELECT * FROM repositories WHERE repository_id=$0", repositoryId).SingleOrDefault()
                ?? throw new QueryException("REPOSITORY_NOT_FOUND", "Repository is not registered.");
            generation = repository["structural_generation"]!.GetValue<long>(); epoch = repository["query_epoch"]!.GetValue<long>();
            var state = repository["state"]!.GetValue<string>();
            if (generation == 0 && tool != "get_index_status") throw new QueryException("INDEX_NOT_READY", "Index the repository before querying.");
            if (state != "ready" && Text(arguments, "freshness") == "require_current") throw new QueryException("INDEX_STALE", "Repository coverage is not current.");
            var evidence = new Dictionary<string, JsonObject>(StringComparer.Ordinal); var warnings = new JsonArray();
            var contextId = Text(arguments, "contextId");
            var offset = Text(arguments, "cursor") is string cursor ? cursors.Read(cursor, tool, arguments, epoch.Value) : 0;
            var limit = Number(arguments, "limit", tool is "search_code" or "find_symbol" ? 20 : 100);
            var more = false;
            JsonObject Symbol(string symbolId)
            {
                var row = Rows(connection, transaction, "SELECT * FROM symbols WHERE repository_id=$0 AND symbol_id=$1", repositoryId, symbolId).SingleOrDefault()
                    ?? throw new QueryException("SYMBOL_NOT_FOUND", "Symbol is unavailable in this repository.");
                if (contextId is not null && row["defining_context_id"] is not null && Text(row, "defining_context_id") != contextId)
                    throw new QueryException("SYMBOL_NOT_FOUND", "Symbol is unavailable in this context.");
                var locations = Rows(connection, transaction, "SELECT l.*,f.relative_path FROM locations l JOIN files f ON f.file_id=l.file_id WHERE symbol_id=$0 ORDER BY f.relative_path,start_offset LIMIT 1000", symbolId);
                foreach (var location in locations) AddEvidence(location);
                var resolution = row["resolution"]!.GetValue<string>();
                return new JsonObject
                {
                    ["symbolId"] = symbolId, ["contextId"] = row["defining_context_id"]?.DeepClone(), ["kind"] = row["kind"]!.DeepClone(),
                    ["qualifiedName"] = row["qualified_name"]!.DeepClone(), ["signature"] = row["signature"]!.DeepClone(),
                    ["symbolRevision"] = row["revision"]!.DeepClone(), ["external"] = row["external"]!.GetValue<long>() == 1,
                    ["resolution"] = resolution, ["declarations"] = Array(locations.Select(l => (JsonNode?)JsonValue.Create(Text(l, "location_id")))),
                    ["identityStability"] = resolution == "syntaxOnly" ? "syntactic" : row["kind"]!.GetValue<string>() == "function" ? "localEditSensitive" : "semantic"
                };
            }
            void AddEvidence(JsonObject location)
            {
                var evidenceId = location["location_id"]!.GetValue<string>();
                evidence[evidenceId] = new JsonObject
                {
                    ["id"] = evidenceId, ["fileId"] = location["file_id"]!.DeepClone(), ["contextId"] = location["context_id"]!.DeepClone(),
                    ["path"] = location["relative_path"]!.DeepClone(), ["contentHash"] = location["content_hash"]!.DeepClone(),
                    ["range"] = Range(location), ["provenance"] = "syntax", ["resolution"] = "syntaxOnly"
                };
                var resolution = connection.Scalar(transaction, "SELECT resolution FROM contexts WHERE context_id=$0", Text(location, "context_id")) as string;
                if (resolution != "syntaxOnly") { evidence[evidenceId]["provenance"] = "compiler"; evidence[evidenceId]["resolution"] = "resolved"; }
            }
            JsonObject Relation(JsonObject row)
            {
                var evidenceIds = new JsonArray();
                if (Text(row, "occurrence_id") is string occurrenceId)
                {
                    var occurrence = Rows(connection, transaction, "SELECT o.*,f.relative_path FROM occurrences o JOIN files f ON f.file_id=o.file_id WHERE occurrence_id=$0", occurrenceId).Single();
                    evidence[occurrenceId] = new JsonObject
                    {
                        ["id"] = occurrenceId, ["fileId"] = occurrence["file_id"]!.DeepClone(), ["contextId"] = occurrence["context_id"]!.DeepClone(),
                        ["path"] = occurrence["relative_path"]!.DeepClone(), ["contentHash"] = occurrence["content_hash"]!.DeepClone(),
                        ["range"] = JsonNode.Parse(occurrence["range_json"]!.GetValue<string>()) is JsonObject range ? LowerRange(range) : null,
                        ["provenance"] = row["provenance"]!.DeepClone(), ["resolution"] = row["resolution"]!.DeepClone()
                    }; evidenceIds.Add(occurrenceId);
                }
                return new JsonObject { ["edgeId"] = row["edge_id"]!.DeepClone(), ["sourceSymbolId"] = row["source_symbol_id"]!.DeepClone(),
                    ["targetSymbolId"] = row["target_symbol_id"]!.DeepClone(), ["kind"] = row["kind"]!.DeepClone(), ["provenance"] = row["provenance"]!.DeepClone(),
                    ["resolution"] = row["resolution"]!.DeepClone(), ["evidenceIds"] = evidenceIds };
            }
            List<JsonObject> Edges(string symbolId, bool incoming, int maximum)
            {
                var side = incoming ? "target_symbol_id" : "source_symbol_id";
                return Rows(connection, transaction, $"SELECT e.* FROM edges e JOIN symbols s ON s.symbol_id=e.source_symbol_id WHERE s.repository_id=$0 AND e.{side}=$1 AND ($2 IS NULL OR e.owner_context_id=$2) AND ($3=1 OR e.resolution='resolved') ORDER BY edge_id LIMIT $4", repositoryId, symbolId,
                    contextId, Flag(arguments, "includePossibleTargets") ? 1 : 0, maximum);
            }
            JsonObject data;
            switch (tool)
            {
                case "find_symbol":
                {
                    var rows = Rows(connection, transaction, "SELECT symbol_id FROM symbols WHERE repository_id=$0 AND name=$1 AND ($2 IS NULL OR defining_context_id=$2) AND ($3 IS NULL OR qualified_name=$3) AND ($4 IS NULL OR signature=$4) ORDER BY qualified_name,symbol_id LIMIT $5 OFFSET $6",
                        repositoryId, Text(arguments, "name"), contextId, Text(arguments, "qualifiedName"), Text(arguments, "signature"), limit + 1, offset);
                    more = rows.Count > limit; data = new() { ["items"] = Array(rows.Take(limit).Select(row => (JsonNode?)Symbol(Text(row, "symbol_id")!))), ["ambiguous"] = rows.Count > 1 || offset > 0 }; break;
                }
                case "search_code":
                {
                    var mode = Text(arguments, "mode") ?? "hybrid";
                    if (mode == "vector") throw new QueryException("MODEL_UNAVAILABLE", "Install and activate a local embedding model before vector search.");
                    if (mode == "hybrid") warnings.Add(new JsonObject { ["code"] = "MODEL_UNAVAILABLE", ["message"] = "Local embedding search is unavailable; lexical results returned." });
                    var query = Text(arguments, "query")!;
                    var tokens = query.Split([' ', '\t', '\r', '\n'], StringSplitOptions.RemoveEmptyEntries).Take(32).Select(t => "\"" + t.Replace("\"", "\"\"") + "\"");
                    var fts = string.Join(" OR ", tokens);
                    var rows = Rows(connection, transaction, "WITH ranked AS MATERIALIZED(SELECT d.symbol_id,bm25(symbol_fts,10.0,3.0,2.0,1.0) AS score FROM symbol_fts JOIN search_documents d ON d.search_id=symbol_fts.rowid WHERE symbol_fts MATCH $0) SELECT s.*,r.score FROM ranked r JOIN symbols s ON s.symbol_id=r.symbol_id WHERE s.repository_id=$1 AND ($2 IS NULL OR s.defining_context_id=$2) ORDER BY (s.name=$3) DESC,r.score,s.symbol_id LIMIT 300", fts, repositoryId, contextId, query);
                    bool Eligible(JsonObject row)
                    {
                        var filters = arguments["filters"] as JsonObject;
                        if (filters?["languages"] is JsonArray languages && !languages.Any(x => x!.GetValue<string>() == "csharp")) return false;
                        if (filters?["kinds"] is JsonArray kinds && !kinds.Any(x => x!.GetValue<string>() == Text(row, "kind"))) return false;
                        if (filters?["projectIds"] is JsonArray projects)
                        {
                            var project = connection.Scalar(transaction, "SELECT project_id FROM contexts WHERE context_id=$0", Text(row, "defining_context_id")) as string;
                            if (!projects.Any(x => x!.GetValue<string>() == project)) return false;
                        }
                        return true;
                    }
                    rows = rows.Where(Eligible).ToList(); more = rows.Count > offset + limit;
                    var matches = new JsonArray(); var rank = offset;
                    foreach (var row in rows.Skip(offset).Take(limit))
                    {
                        cancellationToken.ThrowIfCancellationRequested(); var symbol = Symbol(Text(row, "symbol_id")!); rank++;
                        var exact = Text(row, "name") == query;
                        matches.Add(new JsonObject { ["symbol"] = symbol, ["reasons"] = exact ? new JsonArray("exact", "lexical") : new JsonArray("lexical"),
                            ["evidenceIds"] = symbol["declarations"]!.DeepClone(), ["ranks"] = new JsonObject { ["lexical"] = rank },
                            ["score"] = 1.0 / (60 + rank), ["freshness"] = state == "ready" ? "current" : "stale" });
                    }
                    data = new() { ["matches"] = matches, ["channelsUsed"] = new JsonArray("lexical"),
                        ["eligibleSymbolCount"] = Convert.ToInt64(connection.Scalar(transaction, "SELECT count(*) FROM symbols WHERE repository_id=$0 AND external=0", repositoryId)), ["vectorCoveredSymbolCount"] = 0 }; break;
                }
                case "get_symbol":
                {
                    var symbol = Symbol(Text(arguments, "symbolId")!); data = new() { ["symbol"] = symbol, ["declarations"] = symbol["declarations"]!.DeepClone(),
                        ["referencesAvailable"] = Text(symbol, "resolution") != "syntaxOnly", ["resolution"] = symbol["resolution"]!.DeepClone(), ["diagnosticIds"] = new JsonArray() }; break;
                }
                case "get_source":
                {
                    List<JsonObject> locations;
                    if (Text(arguments, "symbolId") is string symbolId)
                    {
                        var symbol = Symbol(symbolId);
                        if (symbol["external"]!.GetValue<bool>()) throw new QueryException("CAPABILITY_UNAVAILABLE", "Metadata symbol has no authored source.");
                        locations = Rows(connection, transaction, "SELECT l.*,f.relative_path FROM locations l JOIN files f ON f.file_id=l.file_id WHERE symbol_id=$0 AND ($1 IS NULL OR location_id=$1) ORDER BY relative_path,start_offset LIMIT 100", symbolId, Text(arguments, "locationId"));
                        if (locations.Count == 0) throw new QueryException("FILE_NOT_FOUND", "Declaration location is unavailable.");
                    }
                    else
                    {
                        var file = Rows(connection, transaction, "SELECT f.*,cf.context_id FROM files f JOIN context_files cf ON cf.file_id=f.file_id WHERE f.repository_id=$0 AND f.file_id=$1 AND f.role='searchableSource' AND ($2 IS NULL OR cf.context_id=$2) ORDER BY cf.context_id LIMIT 1", repositoryId, Text(arguments, "fileId"), contextId).SingleOrDefault()
                            ?? throw new QueryException("FILE_NOT_FOUND", "Source file is unavailable.");
                        var range = arguments["range"]!.AsObject(); locations = [new JsonObject { ["file_id"] = file["file_id"]!.DeepClone(), ["relative_path"] = file["relative_path"]!.DeepClone(),
                            ["context_id"] = file["context_id"]!.DeepClone(), ["content_hash"] = file["observed_hash"]!.DeepClone(),
                            ["location_id"] = Identity.Id("pci:range:", Text(file, "file_id"), range.ToJsonString(), Text(file, "observed_hash")),
                            ["start_line"] = range["start"]!["line"]!.GetValue<int>(), ["start_character"] = range["start"]!["character"]!.GetValue<int>(),
                            ["end_line"] = range["end"]!["line"]!.GetValue<int>(), ["end_character"] = range["end"]!["character"]!.GetValue<int>() }];
                    }
                    var fragments = new JsonArray(); var remainingLines = Number(arguments, "maxLines", 80);
                    foreach (var location in locations)
                    {
                        if (remainingLines <= 0) break; cancellationToken.ThrowIfCancellationRequested();
                        var source = SourceFiles.Read(repository["canonical_root"]!.GetValue<string>(), Text(location, "relative_path")!, cancellationToken);
                        var expected = Text(arguments, "expectedContentHash") ?? Text(location, "content_hash");
                        if (source.Hash != expected || source.Hash != Text(location, "content_hash")) throw new QueryException("SOURCE_CHANGED", "Source changed since indexing. Reindex and refresh the location.");
                        var sourceText = Microsoft.CodeAnalysis.Text.SourceText.From(source.Text);
                        var range = Range(location); var start = Offset(sourceText, range["start"]!); var end = Offset(sourceText, range["end"]!);
                        if (end < start) throw new QueryException("INVALID_ARGUMENT", "Source range is reversed.");
                        var lineStart = range["start"]!["line"]!.GetValue<int>(); var lineEnd = range["end"]!["line"]!.GetValue<int>();
                        if (lineEnd - lineStart + 1 > remainingLines)
                        {
                            end = sourceText.Lines[lineStart + remainingLines - 1].EndIncludingLineBreak;
                            var position = sourceText.Lines.GetLinePosition(end); range["end"] = new JsonObject { ["line"] = position.Line, ["character"] = position.Character };
                        }
                        remainingLines -= Math.Min(remainingLines, lineEnd - lineStart + 1);
                        AddEvidence(location);
                        var fragment = new JsonObject { ["fileId"] = location["file_id"]!.DeepClone(), ["text"] = source.Text[start..end], ["range"] = range,
                            ["currentHash"] = source.Hash, ["indexedHash"] = location["content_hash"]!.DeepClone(), ["matchesIndexedRevision"] = true };
                        if (Text(arguments, "symbolId") is not null) fragment["locationId"] = location["location_id"]!.DeepClone();
                        fragments.Add(fragment);
                    }
                    data = new() { ["fragments"] = fragments }; break;
                }
                case "explain_symbol":
                {
                    var symbol = Symbol(Text(arguments, "symbolId")!); var declarations = symbol["declarations"]!.AsArray();
                    var provenance = Text(symbol, "resolution") == "syntaxOnly" ? "syntax" : "compiler";
                    data = new() { ["facts"] = new JsonArray(new JsonObject { ["kind"] = "declaration", ["text"] = symbol["signature"]!.DeepClone(),
                            ["evidenceIds"] = declarations.DeepClone(), ["provenance"] = provenance, ["resolution"] = symbol["resolution"]!.DeepClone(), ["sourceRevision"] = symbol["symbolRevision"]!.DeepClone() }),
                        ["description"] = null, ["provenance"] = provenance, ["uncertainties"] = new JsonArray("Structural facts do not prove runtime behavior."), ["coverage"] = Coverage(1, 1) }; break;
                }
                case "get_callers": case "get_callees":
                {
                    var symbolId = Text(arguments, "symbolId")!; Symbol(symbolId);
                    var edges = Edges(symbolId, tool == "get_callers", offset + limit + 1); more = edges.Count > offset + limit;
                    data = new() { ["items"] = Array(edges.Skip(offset).Take(limit).Select(row => (JsonNode?)Relation(row))) }; break;
                }
                case "find_related":
                {
                    var symbolId = Text(arguments, "symbolId")!; Symbol(symbolId);
                    var edges = Edges(symbolId, false, 1000).Concat(Edges(symbolId, true, 1000));
                    if (arguments["kinds"] is JsonArray kinds) edges = edges.Where(row => kinds.Any(k => k!.GetValue<string>() == Text(row, "kind")));
                    var ids = edges.Select(row => Text(row, "source_symbol_id") == symbolId ? Text(row, "target_symbol_id")! : Text(row, "source_symbol_id")!).Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal).ToArray();
                    more = ids.Length > offset + limit;
                    data = new() { ["items"] = Array(ids.Skip(offset).Take(limit).Select(relatedId =>
                    { var symbol = Symbol(relatedId); return (JsonNode?)new JsonObject { ["symbol"] = symbol, ["reasons"] = new JsonArray("staticCallRelation"), ["evidenceIds"] = symbol["declarations"]!.DeepClone() }; })) }; break;
                }
                case "trace_flow":
                {
                    var root = Text(arguments, "symbolId")!; var depth = Number(arguments, "depth", 3); var maxNodes = Number(arguments, "maxNodes", 100); var maxEdges = Number(arguments, "maxEdges", 200);
                    var nodes = new Dictionary<string, JsonObject>(StringComparer.Ordinal) { [root] = Symbol(root) }; var edges = new Dictionary<string, JsonObject>(StringComparer.Ordinal);
                    var boundaries = new Dictionary<string, JsonObject>(StringComparer.Ordinal); var queue = new Queue<(string Id, int Depth)>(); queue.Enqueue((root, 0));
                    var incoming = Text(arguments, "direction") == "incoming";
                    while (queue.TryDequeue(out var item))
                    {
                        cancellationToken.ThrowIfCancellationRequested();
                        if (item.Depth == depth || nodes[item.Id]["external"]!.GetValue<bool>())
                        { boundaries[item.Id] = new() { ["symbolId"] = item.Id, ["reason"] = item.Depth == depth ? "depthLimit" : "externalSymbol" }; continue; }
                        foreach (var row in Edges(item.Id, incoming, Math.Min(2001, maxEdges + 1)))
                        {
                            if (arguments["edgeKinds"] is JsonArray kinds && !kinds.Any(k => k!.GetValue<string>() == Text(row, "kind"))) continue;
                            var next = Text(row, incoming ? "source_symbol_id" : "target_symbol_id")!;
                            if (edges.Count >= maxEdges || (!nodes.ContainsKey(next) && nodes.Count >= maxNodes))
                            { boundaries[item.Id] = new() { ["symbolId"] = item.Id, ["reason"] = "graphBudget" }; continue; }
                            if (!nodes.ContainsKey(next)) { nodes[next] = Symbol(next); queue.Enqueue((next, item.Depth + 1)); }
                            edges[Text(row, "edge_id")!] = Relation(row);
                        }
                    }
                    var unresolved = new JsonArray();
                    foreach (var node in nodes.Keys)
                        foreach (var row in Rows(connection, transaction, "SELECT occurrence_id FROM occurrences WHERE owner_symbol_id=$0 AND target_symbol_id IS NULL LIMIT $1", node, 1000 - unresolved.Count)) unresolved.Add(Text(row, "occurrence_id"));
                    data = new() { ["nodes"] = Array(nodes.Values.Select(v => (JsonNode?)v)), ["edges"] = Array(edges.Values.Select(v => (JsonNode?)v)),
                        ["boundaries"] = Array(boundaries.Values.Select(v => (JsonNode?)v)), ["unresolvedOccurrences"] = unresolved,
                        ["limitsApplied"] = new JsonObject { ["depth"] = depth, ["maxNodes"] = maxNodes, ["maxEdges"] = maxEdges } }; break;
                }
                case "summarize_project":
                {
                    var projectId = Text(arguments, "projectId")!;
                    if (connection.Scalar(transaction, "SELECT project_id FROM projects WHERE repository_id=$0 AND project_id=$1", repositoryId, projectId) is null) throw new QueryException("INVALID_ARGUMENT", "Project is unavailable.");
                    var components = Rows(connection, transaction, "SELECT symbol_id FROM symbols s JOIN contexts c ON c.context_id=s.defining_context_id WHERE c.project_id=$0 AND s.kind='type' ORDER BY qualified_name LIMIT 100", projectId);
                    data = new() { ["projectId"] = projectId, ["components"] = Array(components.Select(row =>
                        { var symbol = Symbol(Text(row, "symbol_id")!); return (JsonNode?)new JsonObject { ["symbol"] = symbol, ["description"] = null, ["evidenceIds"] = symbol["declarations"]!.DeepClone() }; })),
                        ["description"] = null, ["coverage"] = Coverage(components.Count, components.Count), ["uncertainties"] = new JsonArray("Aggregate generated descriptions are unavailable.") }; break;
                }
                case "get_index_status":
                {
                    var contexts = Rows(connection, transaction, "SELECT c.* FROM contexts c JOIN projects p ON p.project_id=c.project_id WHERE p.repository_id=$0 ORDER BY context_id LIMIT 1000", repositoryId);
                    var diagnostics = Rows(connection, transaction, "SELECT * FROM diagnostics WHERE repository_id=$0 ORDER BY diagnostic_id LIMIT 1000", repositoryId);
                    var jobs = new JsonObject(); foreach (var jobState in new[] { "pending", "leased", "succeeded", "failed", "obsolete" })
                        jobs[jobState] = Convert.ToInt64(connection.Scalar(transaction, "SELECT count(*) FROM jobs WHERE repository_id=$0 AND state=$1", repositoryId, jobState));
                    data = new() { ["desiredRevision"] = repository["desired_revision"]!.DeepClone(), ["contexts"] = Array(contexts.Select(row => (JsonNode?)new JsonObject
                        { ["contextId"] = row["context_id"]!.DeepClone(), ["state"] = row["state"]!.DeepClone(), ["resolution"] = row["resolution"]!.DeepClone(),
                          ["desiredRevision"] = row["desired_revision"]!.DeepClone(), ["publishedRevision"] = row["published_revision"]!.DeepClone(), ["capabilities"] = JsonNode.Parse(Text(row, "capabilities_json")!) })),
                        ["jobsByState"] = jobs, ["models"] = new JsonArray(), ["lastReconciledUtc"] = repository["last_reconciled_utc"]?.DeepClone(),
                        ["diagnostics"] = Array(diagnostics.Select(row => { var d = new JsonObject { ["id"] = row["diagnostic_id"]!.DeepClone(), ["code"] = row["code"]!.DeepClone(),
                            ["severity"] = row["severity"]!.DeepClone(), ["message"] = row["message"]!.DeepClone() }; if (row["context_id"] is not null) d["contextId"] = row["context_id"]!.DeepClone();
                            if (row["file_id"] is not null) d["fileId"] = row["file_id"]!.DeepClone(); return (JsonNode?)d; })), ["ownerState"] = "directLocalSession" }; break;
                }
                default: throw new QueryException("INVALID_ARGUMENT", "Unknown tool.");
            }
            var envelope = new JsonObject
            {
                ["schemaVersion"] = "1.2", ["repositoryId"] = repositoryId, ["indexGeneration"] = generation, ["queryEpoch"] = epoch,
                ["freshness"] = new JsonObject { ["state"] = state == "ready" ? (HasSyntax(connection, transaction, repositoryId) ? "partial" : "current") : state == "unknown" ? "unknown" : "stale",
                    ["lastReconciledUtc"] = repository["last_reconciled_utc"]?.DeepClone(), ["pendingContextCount"] = state == "ready" ? 0 : 1, ["basis"] = "observedSnapshot" },
                ["data"] = data, ["evidence"] = Array(evidence.Values.Select(v => (JsonNode?)v)), ["warnings"] = warnings, ["truncated"] = more,
                ["nextCursor"] = more ? cursors.Create(tool, arguments, epoch.Value, offset + limit) : null
            };
            if (Encoding.UTF8.GetByteCount(envelope.ToJsonString()) > Math.Min(60_000, Number(arguments, "responseBudgetTokens", 4000) * 3))
                throw new QueryException("INPUT_TOO_LARGE", "Response exceeds the requested budget; reduce limit, maxLines, or graph bounds.");
            transaction.Commit(); return envelope;
        }
        catch (Exception ex) when (ex is QueryException or KeyNotFoundException or IOException or UnauthorizedAccessException or OperationCanceledException or DecoderFallbackException)
        {
            var code = ex is QueryException query ? query.Code : ex is OperationCanceledException ? "CANCELLED" : ex is UnauthorizedAccessException ? "ACCESS_DENIED" : ex is DecoderFallbackException ? "UNSUPPORTED_ENCODING" : "SOURCE_UNREADABLE";
            return new JsonObject { ["schemaVersion"] = "1.2", ["repositoryId"] = repositoryId, ["indexGeneration"] = generation, ["queryEpoch"] = epoch,
                ["error"] = new JsonObject { ["code"] = code, ["message"] = ex is QueryException ? ex.Message : "Requested source or operation is unavailable.", ["retryable"] = code is "CANCELLED" or "INDEX_STALE" } };
        }
    }

    private static List<JsonObject> Rows(SqliteConnection connection, SqliteTransaction transaction, string sql, params object?[] arguments)
    {
        using var command = connection.Command(transaction, sql, arguments); using var reader = command.ExecuteReader(); var rows = new List<JsonObject>();
        while (reader.Read()) { var row = new JsonObject(); for (var i = 0; i < reader.FieldCount; i++) row[reader.GetName(i)] = reader.IsDBNull(i) ? null : JsonSerializer.SerializeToNode(reader.GetValue(i)); rows.Add(row); }
        return rows;
    }
    private static string? Text(JsonObject obj, string key) => obj[key]?.GetValue<string>();
    private static int Number(JsonObject obj, string key, int fallback) => obj[key]?.GetValue<int>() ?? fallback;
    private static bool Flag(JsonObject obj, string key) => obj[key]?.GetValue<bool>() == true;
    private static JsonArray Array(IEnumerable<JsonNode?> items) => new(items.ToArray());
    private static JsonObject Coverage(int eligible, int current) => new() { ["eligible"] = eligible, ["current"] = current, ["stale"] = 0, ["excluded"] = 0, ["failed"] = 0 };
    private static JsonObject Range(JsonObject location) => new() { ["start"] = new JsonObject { ["line"] = location["start_line"]!.DeepClone(), ["character"] = location["start_character"]!.DeepClone() },
        ["end"] = new JsonObject { ["line"] = location["end_line"]!.DeepClone(), ["character"] = location["end_character"]!.DeepClone() } };
    private static JsonObject LowerRange(JsonObject range) => JsonSerializer.SerializeToNode(JsonSerializer.Deserialize<SourceRange>(range.ToJsonString()), Camel)!.AsObject();
    private static int Offset(Microsoft.CodeAnalysis.Text.SourceText text, JsonNode position)
    {
        var line = position["line"]!.GetValue<int>(); var character = position["character"]!.GetValue<int>();
        if (line >= text.Lines.Count || character > text.Lines[line].Span.Length) throw new QueryException("INVALID_ARGUMENT", "Source coordinate is out of range.");
        return text.Lines[line].Start + character;
    }
    private static bool HasSyntax(SqliteConnection connection, SqliteTransaction transaction, string repositoryId) => Convert.ToInt64(connection.Scalar(transaction,
        "SELECT count(*) FROM contexts c JOIN projects p ON p.project_id=c.project_id WHERE p.repository_id=$0 AND resolution!='complete'", repositoryId)) > 0;
}
