using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Data.Sqlite;
using Praxis.CodeIntelligence.Indexing;
using Praxis.CodeIntelligence.Storage;
using Praxis.CodeIntelligence.Embeddings;

namespace Praxis.CodeIntelligence.Queries;

public sealed class QueryService(IndexDatabase database, ModelStore? models = null)
{
    public const int SearchCountCacheVersion = 1;
    public const int SearchPlanVersion = 5;
    public const string RankingProfile = "rrf-k60-lexical64-vector1-alias0.5-v3";
    public const double LexicalWeight = 64.0;
    public const double AliasWeight = 0.5;
    internal Action<QueryMeasurement>? MeasurementObserver { get; init; }
    internal int VectorChunkLimit { get; init; } = 200_000;
    private readonly CursorCodec cursors = new();
    private sealed record SearchCountKey(string Repository, long Generation, long Epoch, string? Context, string? Kinds, string? Projects, string? Profile);
    private readonly Dictionary<SearchCountKey, long> searchCounts = new();
    private readonly object searchCountLock = new();

    private long SnapshotCount(SearchCountKey key, Func<long> read)
    {
        lock (searchCountLock) if (searchCounts.TryGetValue(key, out var count)) return count;
        // The key comes from the caller's read transaction. Only scalar counts
        // survive; neither connections nor old source/compiler snapshots are retained.
        var value = read();
        lock (searchCountLock)
        {
            if (searchCounts.Count >= 128) searchCounts.Clear();
            searchCounts[key] = value;
        }
        return value;
    }
    private static readonly JsonSerializerOptions Camel = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    public JsonObject Execute(string tool, JsonObject arguments, IReadOnlySet<string> allowedRepositories, CancellationToken cancellationToken = default)
    {
        var repositoryId = arguments["repositoryId"] is JsonValue value && value.TryGetValue<string>(out var id) ? id : "unknown";
        long? generation = null, epoch = null;
        var measurement = MeasurementObserver is null ? null : Stopwatch.StartNew();
        double inferenceStart = 0, inferenceEnd = 0, responseStart = 0, vectorMs = 0;
        var succeeded = false;
        try
        {
            JsonContract.Validate(tool, arguments);
            if (!allowedRepositories.Contains(repositoryId)) throw new QueryException("ACCESS_DENIED", "Repository access has not been granted.");
            cancellationToken.ThrowIfCancellationRequested();
            // Validate before inference: never silently omit query terms.
            if (tool == "search_code" && Text(arguments, "query")!.Split([' ', '\t', '\r', '\n'], StringSplitOptions.RemoveEmptyEntries).Length > 64)
                throw new QueryException("INVALID_ARGUMENT", "Search queries support at most 64 literal terms.");
            inferenceStart = measurement?.Elapsed.TotalMilliseconds ?? 0;
            ModelQuery? embedded = null;
            if (tool == "search_code" && Text(arguments, "mode") != "lexical" && models is not null)
                try { embedded = models.QueryEmbedding(repositoryId, Text(arguments, "query")!, cancellationToken); }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException or InvalidOperationException or Microsoft.ML.OnnxRuntime.OnnxRuntimeException)
                { cancellationToken.ThrowIfCancellationRequested(); /* Hybrid degrades to lexical; vector returns MODEL_UNAVAILABLE below. */ }
            inferenceEnd = measurement?.Elapsed.TotalMilliseconds ?? 0;
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
            var limit = Number(arguments, "limit", tool is "search_code" or "find_symbol" or "find_related" ? 10 : 50);
            var more = false; var contentTruncated = false;
            var unresolvedOwners = new Dictionary<string, string>(StringComparer.Ordinal);
            JsonObject Symbol(string symbolId)
            {
                var row = Rows(connection, transaction, "SELECT * FROM symbols WHERE repository_id=$0 AND symbol_id=$1", repositoryId, symbolId).SingleOrDefault()
                    ?? throw new QueryException("SYMBOL_NOT_FOUND", "Symbol is unavailable in this repository.");
                if (contextId is not null && row["defining_context_id"] is not null && Text(row, "defining_context_id") != contextId)
                    throw new QueryException("SYMBOL_NOT_FOUND", "Symbol is unavailable in this context.");
                var locations = Rows(connection, transaction, "SELECT l.*,f.relative_path FROM locations l JOIN files f ON f.file_id=l.file_id WHERE symbol_id=$0 ORDER BY f.relative_path,start_offset LIMIT 1000", symbolId);
                foreach (var location in locations) AddEvidence(location);
                var resolution = row["resolution"]!.GetValue<string>();
                if (row["external"]!.GetValue<long>() == 1)
                {
                    var evidenceId = Identity.Id("pci:metadata:", symbolId);
                    evidence[evidenceId] = new JsonObject { ["id"] = evidenceId, ["provenance"] = "metadata", ["resolution"] = resolution,
                        ["referenceIdentity"] = row["descriptor_json"]!.DeepClone(), ["description"] = row["signature"]!.DeepClone() };
                }
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
            void AddOccurrenceEvidence(string occurrenceId, string provenance, string resolution)
            {
                if (evidence.ContainsKey(occurrenceId)) return;
                var occurrence = Rows(connection, transaction, "SELECT o.*,f.relative_path FROM occurrences o JOIN files f ON f.file_id=o.file_id WHERE occurrence_id=$0", occurrenceId).Single();
                evidence[occurrenceId] = new JsonObject {
                    ["id"] = occurrenceId, ["fileId"] = occurrence["file_id"]!.DeepClone(), ["contextId"] = occurrence["context_id"]!.DeepClone(),
                    ["path"] = occurrence["relative_path"]!.DeepClone(), ["contentHash"] = occurrence["content_hash"]!.DeepClone(),
                    ["range"] = JsonNode.Parse(occurrence["range_json"]!.GetValue<string>()) is JsonObject range ? LowerRange(range) : null,
                    ["provenance"] = provenance, ["resolution"] = resolution };
            }
            JsonObject Relation(JsonObject row)
            {
                var evidenceIds = new JsonArray();
                if (Text(row, "occurrence_id") is string occurrenceId)
                {
                    AddOccurrenceEvidence(occurrenceId, Text(row, "provenance")!, Text(row, "resolution")!);
                    evidenceIds.Add(occurrenceId);
                }
                else if (Text(row, "evidence_key") is string reference)
                {
                    var evidenceId = Identity.Id("pci:configuration:", reference);
                    evidence[evidenceId] = new JsonObject { ["id"] = evidenceId, ["provenance"] = "metadata",
                        ["resolution"] = row["resolution"]!.DeepClone(), ["referenceIdentity"] = reference,
                        ["description"] = "Compiler reference from validated captured inputs; not a source-use occurrence or runtime call." };
                    evidenceIds.Add(evidenceId);
                }
                return new JsonObject { ["edgeId"] = row["edge_id"]!.DeepClone(), ["sourceSymbolId"] = row["source_symbol_id"]!.DeepClone(),
                    ["targetSymbolId"] = row["target_symbol_id"]!.DeepClone(), ["kind"] = row["kind"]!.DeepClone(), ["provenance"] = row["provenance"]!.DeepClone(),
                    ["resolution"] = row["resolution"]!.DeepClone(), ["evidenceIds"] = evidenceIds };
            }
            List<JsonObject> Edges(string symbolId, bool incoming, int maximum, string? kind = null)
            {
                var side = incoming ? "target_symbol_id" : "source_symbol_id";
                return Rows(connection, transaction, $"SELECT e.* FROM edges e JOIN symbols s ON s.symbol_id=e.source_symbol_id WHERE s.repository_id=$0 AND e.{side}=$1 AND ($2 IS NULL OR e.owner_context_id=$2) AND ($3=1 OR e.resolution='resolved') AND ($5 IS NULL OR e.kind=$5 OR ($5='calls' AND $3=1 AND e.kind='may_call')) ORDER BY edge_id LIMIT $4", repositoryId, symbolId,
                    contextId, Flag(arguments, "includePossibleTargets") ? 1 : 0, maximum, kind);
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
                    if (mode == "vector" && embedded is null) throw new QueryException("MODEL_UNAVAILABLE", "Install and activate a local embedding model before vector search.");
                    if (mode == "hybrid" && embedded is null) warnings.Add(new JsonObject { ["code"] = "MODEL_UNAVAILABLE", ["message"] = "Local embedding search is unavailable; lexical results returned." });
                    if (embedded is not null && connection.Scalar(transaction, "SELECT model_fingerprint FROM repository_models WHERE repository_id=$0 AND state='active'", repositoryId) as string != embedded.Fingerprint)
                        throw new QueryException("INDEX_STALE", "Active model changed during query inference; restart the query.");
                    var query = Text(arguments, "query")!;
                    if (string.IsNullOrWhiteSpace(query)) throw new QueryException("INVALID_ARGUMENT", "Search query cannot be blank.");
                    var tokens = query.Split([' ', '\t', '\r', '\n'], StringSplitOptions.RemoveEmptyEntries).Select(t => "\"" + t.Replace("\"", "\"\"") + "\"");
                    var fts = string.Join(" OR ", tokens);
                    var retrievalFilters = arguments["filters"] as JsonObject;
                    var retrievalKinds = retrievalFilters?["kinds"]?.ToJsonString();
                    var retrievalProjects = retrievalFilters?["projectIds"]?.ToJsonString();
                    var retrievalLanguage = retrievalFilters?["languages"] is not JsonArray { Count: > 0 } requestedLanguages
                        || requestedLanguages.Any(language => language!.GetValue<string>() == "csharp");
                    const string retrievalScope = " AND ($4 IS NULL OR json_array_length($4)=0 OR s.kind IN(SELECT value FROM json_each($4)))"
                        + " AND ($5 IS NULL OR json_array_length($5)=0 OR s.defining_context_id IN(SELECT context_id FROM contexts WHERE project_id IN(SELECT value FROM json_each($5)))) AND $6";
                    // Pin the matched-candidate side first. Otherwise SQLite may
                    // walk every repository symbol and probe the tiny ranked set.
                    var rows = Rows(connection, transaction, "WITH ranked AS MATERIALIZED(SELECT d.symbol_id,bm25(symbol_fts,5.0,3.0,1.0,1.0) AS score FROM symbol_fts JOIN search_documents d ON d.search_id=symbol_fts.rowid WHERE symbol_fts MATCH $0) SELECT s.*,r.score FROM ranked r CROSS JOIN symbols s ON s.symbol_id=r.symbol_id WHERE s.repository_id=$1 AND ($2 IS NULL OR s.defining_context_id=$2) " + retrievalScope + " ORDER BY (s.name=$3) DESC,r.score,s.symbol_id LIMIT 100", fts, repositoryId, contextId, query, retrievalKinds, retrievalProjects, retrievalLanguage);
                    bool Eligible(JsonObject row)
                    {
                        var filters = arguments["filters"] as JsonObject;
                        if (filters?["languages"] is JsonArray { Count: > 0 } languages && !languages.Any(x => x!.GetValue<string>() == "csharp")) return false;
                        if (filters?["kinds"] is JsonArray { Count: > 0 } kinds && !kinds.Any(x => x!.GetValue<string>() == Text(row, "kind"))) return false;
                        if (filters?["projectIds"] is JsonArray { Count: > 0 } projects)
                        {
                            var project = connection.Scalar(transaction, "SELECT project_id FROM contexts WHERE context_id=$0", Text(row, "defining_context_id")) as string;
                            if (!projects.Any(x => x!.GetValue<string>() == project)) return false;
                        }
                        return true;
                    }
                    rows = mode == "vector" ? [] : rows.Where(Eligible).Take(100).ToList();
                    var candidates = new Dictionary<string, (JsonObject Row, JsonObject Ranks, JsonArray Reasons, double Score)>(StringComparer.Ordinal);
                    void Add(JsonObject row, string channel, int position)
                    {
                        var candidateId = Text(row, "symbol_id")!;
                        if (!candidates.TryGetValue(candidateId, out var candidate)) candidate = (row, new(), new(), 0);
                        if (channel != "graph" && candidate.Ranks.ContainsKey(channel)) return;
                        if (channel != "graph") candidate.Ranks[channel] = position;
                        candidate.Reasons.Add(channel); candidate.Score += (channel == "lexical" ? LexicalWeight : channel == "alias" ? AliasWeight : 1.0) / (60 + position); candidates[candidateId] = candidate;
                    }
                    for (var index = 0; index < rows.Count; index++) Add(rows[index], "lexical", index + 1);
                    if (mode != "vector")
                    {
                        // Each arm uses its repository-scoped index; exact retrieval
                        // must not depend on the bounded FTS candidate list.
                        var exact = Rows(connection, transaction, "SELECT s.* FROM (SELECT * FROM symbols WHERE repository_id=$0 AND name=$1 UNION SELECT * FROM symbols WHERE repository_id=$0 AND qualified_name=$1 UNION SELECT * FROM symbols WHERE repository_id=$0 AND signature=$1) s WHERE s.external=0 AND ($2 IS NULL OR s.defining_context_id=$2)" + retrievalScope + " ORDER BY s.symbol_id LIMIT 100", repositoryId, query, contextId, null, retrievalKinds, retrievalProjects, retrievalLanguage)
                            .Where(row => contextId is null || Text(row, "defining_context_id") == contextId).Where(Eligible).Take(100);
                        foreach (var row in exact) Add(row, "exact", 1);
                    }
                    var channels = new JsonArray(); if (mode != "vector") channels.Add("lexical");
                    if (embedded is not null)
                    {
                        var filters = arguments["filters"] as JsonObject;
                        var kinds = filters?["kinds"]?.AsArray().Select(x => x!.GetValue<string>()).ToArray();
                        var projects = filters?["projectIds"]?.AsArray().Select(x => x!.GetValue<string>()).ToArray();
                        var languages = filters?["languages"]?.AsArray();
                        IReadOnlyList<VectorCandidate> vectors;
                        var vectorStart = measurement?.Elapsed.TotalMilliseconds ?? 0;
                        try
                        {
                            vectors = languages is { Count: > 0 } && !languages.Any(x => x!.GetValue<string>() == "csharp") ? []
                                : ModelStore.Candidates(connection, transaction, repositoryId, embedded, contextId, kinds, projects, cancellationToken, VectorChunkLimit);
                        }
                        catch (InvalidOperationException error) when (error.Message == "VECTOR_CAPACITY_EXCEEDED")
                        {
                            if (mode == "vector") throw new QueryException("VECTOR_CAPACITY_EXCEEDED", "The exact vector scan exceeds the configured chunk capacity.");
                            vectors = []; embedded = null;
                            warnings.Add(new JsonObject { ["code"] = "VECTOR_CAPACITY_EXCEEDED", ["message"] = "Vector capacity exceeded; lexical results returned." });
                        }
                        finally { vectorMs = (measurement?.Elapsed.TotalMilliseconds ?? 0) - vectorStart; }
                        // Fetch the bounded top-k rows once, then retain vector score order.
                        var vectorRows = vectors.Count == 0 ? new Dictionary<string, JsonObject>(StringComparer.Ordinal)
                            : Rows(connection, transaction, "SELECT * FROM symbols WHERE repository_id=$0 AND symbol_id IN(SELECT value FROM json_each($1))",
                                repositoryId, JsonSerializer.Serialize(vectors.Select(vector => vector.SymbolId)))
                                .ToDictionary(row => Text(row, "symbol_id")!, StringComparer.Ordinal);
                        var position = 0;
                        foreach (var vector in vectors) Add(vectorRows[vector.SymbolId], "vector", ++position);
                        if (embedded is not null) channels.Add("vector");
                    }
                    if (mode != "vector")
                    {
                        var aliases = Rows(connection, transaction, "SELECT DISTINCT s.* FROM aliases a JOIN symbols s ON s.symbol_id=a.symbol_id WHERE a.repository_id=$0 AND a.enabled=1 AND a.phrase_key=$1 AND ($2 IS NULL OR s.defining_context_id=$2) " + retrievalScope + " ORDER BY s.symbol_id LIMIT 100", repositoryId, query.Trim().ToLowerInvariant(), contextId, null, retrievalKinds, retrievalProjects, retrievalLanguage).Where(Eligible).ToArray();
                        for (var index = 0; index < aliases.Length; index++) Add(aliases[index], "alias", index + 1);
                        if (aliases.Length > 0) channels.Add("alias");
                    }
                    var graphSupport = new Dictionary<string, (string Seed, JsonObject Edge)>(StringComparer.Ordinal);
                    if (Flag(arguments, "expandGraph"))
                    {
                        var seeds = candidates.Values.OrderByDescending(c => c.Score).ThenBy(c => Text(c.Row, "symbol_id"), StringComparer.Ordinal).Take(20).ToArray();
                        foreach (var seed in seeds)
                        {
                            var seedId = Text(seed.Row, "symbol_id")!;
                            foreach (var edge in Edges(seedId, false, 101).Concat(Edges(seedId, true, 101)))
                            {
                                var neighborId = Text(edge, "source_symbol_id") == seedId ? Text(edge, "target_symbol_id")! : Text(edge, "source_symbol_id")!;
                                if (neighborId == seedId || graphSupport.ContainsKey(neighborId) || graphSupport.Count >= 100) continue;
                                var neighbor = Rows(connection, transaction, "SELECT * FROM symbols WHERE repository_id=$0 AND symbol_id=$1 AND ($2 IS NULL OR defining_context_id=$2 OR external=1)", repositoryId, neighborId, contextId).SingleOrDefault();
                                if (neighbor is null || !Eligible(neighbor)) continue;
                                graphSupport[neighborId] = (seedId, edge); Add(neighbor, "graph", graphSupport.Count);
                            }
                        }
                        if (graphSupport.Count > 0) channels.Add("graph");
                    }
                    // Graph-only expansion never outranks a direct retrieval match.
                    var ordered = candidates.Values.OrderByDescending(c => c.Ranks.ContainsKey("exact")).ThenByDescending(c => c.Ranks.Count > 0).ThenByDescending(c => c.Score).ThenBy(c => Text(c.Row, "symbol_id"), StringComparer.Ordinal).ToArray();
                    more = ordered.Length > offset + limit; var matches = new JsonArray();
                    foreach (var candidate in ordered.Skip(offset).Take(limit))
                    {
                        cancellationToken.ThrowIfCancellationRequested(); var symbol = Symbol(Text(candidate.Row, "symbol_id")!);
                        var matchEvidence = symbol["declarations"]!.AsArray().Select(value => value!.GetValue<string>()).Take(98).ToList();
                        if (graphSupport.TryGetValue(Text(candidate.Row, "symbol_id")!, out var support))
                        {
                            var seed = Symbol(support.Seed);
                            matchEvidence.AddRange(seed["declarations"]!.AsArray().Select(value => value!.GetValue<string>()).Take(1));
                            matchEvidence.AddRange(Relation(support.Edge)["evidenceIds"]!.AsArray().Select(value => value!.GetValue<string>()).Take(1));
                        }
                        matches.Add(new JsonObject { ["symbol"] = symbol, ["reasons"] = candidate.Reasons,
                            ["evidenceIds"] = Array(matchEvidence.Distinct(StringComparer.Ordinal).Select(value => (JsonNode?)JsonValue.Create(value))), ["ranks"] = candidate.Ranks,
                            ["score"] = candidate.Score, ["freshness"] = state == "ready" ? "current" : "stale" });
                    }
                    var kindsJson = (arguments["filters"] as JsonObject)?["kinds"] is JsonArray { Count: > 0 } kindFilters ? kindFilters.ToJsonString() : null;
                    var projectsJson = (arguments["filters"] as JsonObject)?["projectIds"] is JsonArray { Count: > 0 } projectFilters ? projectFilters.ToJsonString() : null;
                    var languageFilter = (arguments["filters"] as JsonObject)?["languages"]?.AsArray();
                    var hasLanguage = languageFilter is null or { Count: 0 } || languageFilter.Any(x => x!.GetValue<string>() == "csharp");
                    const string scope = "s.repository_id=$0 AND s.external=0 AND ($1 IS NULL OR s.defining_context_id=$1) AND ($2 IS NULL OR s.kind IN(SELECT value FROM json_each($2))) AND ($3 IS NULL OR c.project_id IN(SELECT value FROM json_each($3)))";
                    var countKey = new SearchCountKey(repositoryId, generation.Value, epoch.Value, contextId, kindsJson, projectsJson, null);
                    var eligible = hasLanguage ? SnapshotCount(countKey, () => Convert.ToInt64(connection.Scalar(transaction, "SELECT count(*) FROM symbols s JOIN contexts c ON c.context_id=s.defining_context_id WHERE " + scope, repositoryId, contextId, kindsJson, projectsJson))) : 0L;
                    var covered = embedded is null || !hasLanguage ? 0L : SnapshotCount(countKey with { Profile = embedded.Fingerprint }, () => Convert.ToInt64(connection.Scalar(transaction,
                        "SELECT count(*) FROM embedding_sets e JOIN symbols s ON s.symbol_id=e.symbol_id JOIN contexts c ON c.context_id=s.defining_context_id JOIN representation_targets r ON r.symbol_id=s.symbol_id AND r.model_fingerprint=e.model_fingerprint WHERE " + scope
                        + " AND e.model_fingerprint=$4 AND e.state='ready' AND e.input_revision=s.revision AND r.input_revision=s.revision AND r.representation_hash=e.representation_hash AND (SELECT count(*) FROM vectors v WHERE v.set_id=e.set_id)=e.expected_chunks", repositoryId, contextId, kindsJson, projectsJson, embedded.Fingerprint)));
                    if (embedded is not null && covered < eligible) warnings.Add(new JsonObject { ["code"] = "INDEX_STALE", ["message"] = "Vector coverage is incomplete; only complete current vector sets are eligible." });
                    data = new() { ["matches"] = matches, ["channelsUsed"] = channels, ["eligibleSymbolCount"] = eligible, ["vectorCoveredSymbolCount"] = covered }; break;
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
                        if (remainingLines <= 0) { contentTruncated = true; break; } cancellationToken.ThrowIfCancellationRequested();
                        var source = SourceFiles.Read(repository["canonical_root"]!.GetValue<string>(), Text(location, "relative_path")!, cancellationToken);
                        var expected = Text(arguments, "expectedContentHash") ?? Text(location, "content_hash");
                        if (source.Hash != expected || source.Hash != Text(location, "content_hash")) throw new QueryException("SOURCE_CHANGED", "Source changed since indexing. Reindex and refresh the location.");
                        var sourceText = Microsoft.CodeAnalysis.Text.SourceText.From(source.Text);
                        var range = Range(location); var start = Offset(sourceText, range["start"]!); var end = Offset(sourceText, range["end"]!);
                        if (end < start) throw new QueryException("INVALID_ARGUMENT", "Source range is reversed.");
                        var lineStart = range["start"]!["line"]!.GetValue<int>(); var lineEnd = range["end"]!["line"]!.GetValue<int>();
                        if (lineEnd - lineStart + 1 > remainingLines)
                        {
                            contentTruncated = true;
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
                    var provenance = symbol["external"]!.GetValue<bool>() ? "metadata" : Text(symbol, "resolution") == "syntaxOnly" ? "syntax" : "compiler";
                    if (symbol["external"]!.GetValue<bool>()) declarations = new JsonArray(Identity.Id("pci:metadata:", Text(symbol, "symbolId")));
                    data = new() { ["facts"] = new JsonArray(new JsonObject { ["kind"] = "declaration", ["text"] = symbol["signature"]!.DeepClone(),
                            ["evidenceIds"] = declarations.DeepClone(), ["provenance"] = provenance, ["resolution"] = symbol["resolution"]!.DeepClone(), ["sourceRevision"] = symbol["symbolRevision"]!.DeepClone() }),
                        ["description"] = new JsonObject { ["text"] = "Declared " + Text(symbol, "kind") + " " + Text(symbol, "qualifiedName") + ". " + Text(symbol, "signature"),
                            ["provenance"] = provenance, ["inputRevision"] = symbol["symbolRevision"]!.DeepClone(), ["evidenceIds"] = declarations.DeepClone(), ["state"] = "ready" },
                        ["provenance"] = provenance, ["uncertainties"] = new JsonArray("Structural facts do not prove runtime behavior."), ["coverage"] = Coverage(1, 1) }; break;
                }
                case "get_callers": case "get_callees":
                {
                    var symbolId = Text(arguments, "symbolId")!; Symbol(symbolId);
                    var edges = Edges(symbolId, tool == "get_callers", offset + limit + 1, "calls"); more = edges.Count > offset + limit;
                    data = new() { ["items"] = Array(edges.Skip(offset).Take(limit).Select(row => (JsonNode?)Relation(row))) }; break;
                }
                case "find_related":
                {
                    var symbolId = Text(arguments, "symbolId")!; Symbol(symbolId);
                    var edges = Edges(symbolId, false, 1000).Concat(Edges(symbolId, true, 1000));
                    if (arguments["kinds"] is JsonArray { Count: > 0 } kinds) edges = edges.Where(row => kinds.Any(k => k!.GetValue<string>() == Text(row, "kind")));
                    var ids = edges.Select(row => Text(row, "source_symbol_id") == symbolId ? Text(row, "target_symbol_id")! : Text(row, "source_symbol_id")!).Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal).ToArray();
                    more = ids.Length > offset + limit;
                    data = new() { ["items"] = Array(ids.Skip(offset).Take(limit).Select(relatedId =>
                    { var symbol = Symbol(relatedId); return (JsonNode?)new JsonObject { ["symbol"] = symbol, ["reasons"] = new JsonArray("compilerRelationship"), ["evidenceIds"] = symbol["declarations"]!.DeepClone() }; })) }; break;
                }
                case "trace_flow":
                {
                    var root = Text(arguments, "symbolId")!; var depth = Number(arguments, "depth", 3); var maxNodes = Number(arguments, "maxNodes", 100); var maxEdges = Number(arguments, "maxEdges", 2000);
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
                            if (arguments["edgeKinds"] is JsonArray { Count: > 0 } kinds && !kinds.Any(k => k!.GetValue<string>() == Text(row, "kind"))) continue;
                            var next = Text(row, incoming ? "source_symbol_id" : "target_symbol_id")!;
                            if (edges.Count >= maxEdges || (!nodes.ContainsKey(next) && nodes.Count >= maxNodes))
                            { contentTruncated = true; boundaries[item.Id] = new() { ["symbolId"] = item.Id, ["reason"] = "graphBudget" }; continue; }
                            if (!nodes.ContainsKey(next)) { nodes[next] = Symbol(next); queue.Enqueue((next, item.Depth + 1)); }
                            edges[Text(row, "edge_id")!] = Relation(row);
                        }
                    }
                    var unresolved = new JsonArray();
                    foreach (var node in nodes.Keys)
                        foreach (var row in Rows(connection, transaction, "SELECT occurrence_id,resolution FROM occurrences WHERE owner_symbol_id=$0 AND target_symbol_id IS NULL LIMIT $1", node, 1000 - unresolved.Count))
                        {
                            var occurrenceIdentity = Text(row, "occurrence_id")!; unresolved.Add(occurrenceIdentity); unresolvedOwners[occurrenceIdentity] = node;
                            var resolution = Text(row, "resolution")!;
                            AddOccurrenceEvidence(occurrenceIdentity, resolution == "syntaxOnly" ? "syntax" : "compiler", resolution);
                        }
                    contentTruncated |= unresolved.Count == 1000;
                    data = new() { ["nodes"] = Array(nodes.Values.Select(v => (JsonNode?)v)), ["edges"] = Array(edges.Values.Select(v => (JsonNode?)v)),
                        ["boundaries"] = Array(boundaries.Values.Select(v => (JsonNode?)v)), ["unresolvedOccurrences"] = unresolved,
                        ["limitsApplied"] = new JsonObject { ["depth"] = depth, ["maxNodes"] = maxNodes, ["maxEdges"] = maxEdges } }; break;
                }
                case "summarize_project":
                {
                    var projectId = Text(arguments, "projectId")!;
                    if (connection.Scalar(transaction, "SELECT project_id FROM projects WHERE repository_id=$0 AND project_id=$1", repositoryId, projectId) is null) throw new QueryException("INVALID_ARGUMENT", "Project is unavailable.");
                    var componentCount = Convert.ToInt32(connection.Scalar(transaction, "SELECT count(*) FROM symbols s JOIN contexts c ON c.context_id=s.defining_context_id WHERE c.project_id=$0 AND s.kind='type'", projectId));
                    var components = Rows(connection, transaction, "SELECT symbol_id FROM symbols s JOIN contexts c ON c.context_id=s.defining_context_id WHERE c.project_id=$0 AND s.kind='type' ORDER BY qualified_name LIMIT 100", projectId);
                    contentTruncated |= componentCount > components.Count;
                    data = new() { ["projectId"] = projectId, ["components"] = Array(components.Select(row =>
                        { var symbol = Symbol(Text(row, "symbol_id")!); return (JsonNode?)new JsonObject { ["symbol"] = symbol, ["description"] = null, ["evidenceIds"] = symbol["declarations"]!.DeepClone() }; })),
                        ["description"] = null, ["coverage"] = Coverage(componentCount, componentCount), ["uncertainties"] = new JsonArray("Aggregate generated descriptions are unavailable.") }; break;
                }
                case "get_index_status":
                {
                    var contexts = Rows(connection, transaction, "SELECT c.* FROM contexts c JOIN projects p ON p.project_id=c.project_id WHERE p.repository_id=$0 ORDER BY context_id LIMIT 1001", repositoryId);
                    var diagnostics = Rows(connection, transaction, "SELECT * FROM diagnostics WHERE repository_id=$0 ORDER BY CASE severity WHEN 'error' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,diagnostic_id LIMIT 1001", repositoryId);
                    var jobs = new JsonObject(); foreach (var jobState in new[] { "pending", "leased", "succeeded", "failed", "obsolete" })
                        jobs[jobState] = Convert.ToInt64(connection.Scalar(transaction, "SELECT count(*) FROM jobs WHERE repository_id=$0 AND state=$1", repositoryId, jobState));
                    var profiles = Rows(connection, transaction, "SELECT r.model_fingerprint,r.state,m.dimensions FROM repository_models r JOIN model_profiles m ON m.fingerprint=r.model_fingerprint WHERE r.repository_id=$0 ORDER BY CASE r.state WHEN 'active' THEN 0 WHEN 'building' THEN 1 ELSE 2 END,r.model_fingerprint LIMIT 11", repositoryId);
                    if (contexts.Count > 1000) { contexts.RemoveAt(1000); contentTruncated = true; }
                    if (diagnostics.Count > 1000) { diagnostics.RemoveAt(1000); contentTruncated = true; }
                    if (profiles.Count > 10) { profiles.RemoveAt(10); contentTruncated = true; }
                    var eligible = Convert.ToInt32(connection.Scalar(transaction, "SELECT count(*) FROM symbols WHERE repository_id=$0 AND external=0", repositoryId));
                    var modelStatuses = Array(profiles.Select(profile => (JsonNode?)new JsonObject {
                        ["fingerprint"] = profile["model_fingerprint"]!.DeepClone(), ["state"] = profile["state"]!.DeepClone(), ["dimensions"] = profile["dimensions"]!.DeepClone(),
                        ["coverage"] = Coverage(eligible, Convert.ToInt32(connection.Scalar(transaction,
                            "SELECT count(*) FROM embedding_sets e JOIN symbols s ON s.symbol_id=e.symbol_id WHERE s.repository_id=$0 AND e.model_fingerprint=$1 AND e.state='ready' AND e.input_revision=s.revision", repositoryId, Text(profile, "model_fingerprint")))) }));
                    data = new() { ["desiredRevision"] = repository["desired_revision"]!.DeepClone(), ["contexts"] = Array(contexts.Select(row => (JsonNode?)new JsonObject
                        { ["contextId"] = row["context_id"]!.DeepClone(), ["state"] = row["state"]!.DeepClone(), ["resolution"] = row["resolution"]!.DeepClone(),
                          ["desiredRevision"] = row["desired_revision"]!.DeepClone(), ["publishedRevision"] = row["published_revision"]!.DeepClone(), ["capabilities"] = JsonNode.Parse(Text(row, "capabilities_json")!) })),
                        ["jobsByState"] = jobs, ["models"] = modelStatuses, ["lastReconciledUtc"] = repository["last_reconciled_utc"]?.DeepClone(),
                        ["diagnostics"] = Array(diagnostics.Select(row => { var d = new JsonObject { ["id"] = row["diagnostic_id"]!.DeepClone(), ["code"] = row["code"]!.DeepClone(),
                            ["severity"] = row["severity"]!.DeepClone(), ["message"] = row["message"]!.DeepClone() }; if (row["context_id"] is not null) d["contextId"] = row["context_id"]!.DeepClone();
                            if (row["file_id"] is not null) d["fileId"] = row["file_id"]!.DeepClone(); return (JsonNode?)d; })), ["ownerState"] = "directLocalSession" }; break;
                }
                default: throw new QueryException("INVALID_ARGUMENT", "Unknown tool.");
            }
            responseStart = measurement?.Elapsed.TotalMilliseconds ?? 0;
            var envelope = new JsonObject
            {
                ["schemaVersion"] = "1.2", ["repositoryId"] = repositoryId, ["indexGeneration"] = generation, ["queryEpoch"] = epoch,
                ["freshness"] = new JsonObject { ["state"] = state == "ready" ? (HasSyntax(connection, transaction, repositoryId) ? "partial" : "current") : state == "unknown" ? "unknown" : "stale",
                    ["lastReconciledUtc"] = repository["last_reconciled_utc"]?.DeepClone(), ["pendingContextCount"] = state == "ready" ? 0 : 1, ["basis"] = "observedSnapshot" },
                ["data"] = data, ["evidence"] = Array(evidence.Values.Select(v => (JsonNode?)v)), ["warnings"] = warnings, ["truncated"] = more || contentTruncated,
                ["nextCursor"] = more ? cursors.Create(tool, arguments, epoch.Value, offset + limit) : null
            };
            var budget = Math.Min(60_000, Number(arguments, "responseBudgetTokens", 4000) * 3);
            var collection = tool == "search_code" ? data["matches"] as JsonArray
                : tool is "find_symbol" or "get_callers" or "get_callees" or "find_related" ? data["items"] as JsonArray : null;
            var budgetTrimmed = false;
            while (Encoding.UTF8.GetByteCount(envelope.ToJsonString()) > budget && collection is { Count: > 1 })
            {
                collection.RemoveAt(collection.Count - 1);
                if (!budgetTrimmed)
                    warnings.Add(new JsonObject { ["code"] = "RESPONSE_TRUNCATED", ["message"] = "Page reduced to fit the response budget; continue with nextCursor.", ["retryable"] = false });
                budgetTrimmed = true;
                envelope["truncated"] = true;
                envelope["nextCursor"] = cursors.Create(tool, arguments, epoch.Value, offset + collection.Count);
                // Declaration and relation evidence must stay complete for every retained item.
                // Remove evidence belonging only to omitted items, never a referenced record.
                var referenced = new HashSet<string>(StringComparer.Ordinal);
                CollectStrings(data, referenced);
                envelope["evidence"] = Array(evidence.Where(pair => referenced.Contains(pair.Key)).Select(pair => (JsonNode?)pair.Value.DeepClone()));
            }
            if (tool is "get_index_status" or "summarize_project")
            {
                var trimmed = false;
                while (Encoding.UTF8.GetByteCount(envelope.ToJsonString()) > budget)
                {
                    var candidates = tool == "get_index_status" ? new[] { "diagnostics", "contexts", "models" } : new[] { "components" };
                    var target = candidates.Select(key => (Key: key, Values: data[key] as JsonArray))
                        .FirstOrDefault(pair => pair.Values is not null && pair.Values.Count > (pair.Key == "diagnostics" ? 0 : 1));
                    if (target.Values is null) break;
                    var remove = Math.Max(1, target.Values.Count / 2);
                    for (var i = 0; i < remove; i++) target.Values.RemoveAt(target.Values.Count - 1);
                    if (!trimmed) warnings.Add(new JsonObject { ["code"] = "RESPONSE_TRUNCATED", ["message"] = "Collection detail shortened to fit the response budget; request a larger budget for more detail.", ["retryable"] = false });
                    trimmed = true; envelope["truncated"] = true;
                    var referenced = new HashSet<string>(StringComparer.Ordinal); CollectStrings(data, referenced);
                    envelope["evidence"] = Array(evidence.Where(pair => referenced.Contains(pair.Key)).Select(pair => (JsonNode?)pair.Value.DeepClone()));
                }
            }
            if (tool == "trace_flow" && data["nodes"] is JsonArray graphNodes && data["edges"] is JsonArray graphEdges)
            {
                var boundaries = data["boundaries"]!.AsArray();
                var unresolved = data["unresolvedOccurrences"]!.AsArray();
                var rootId = Text(arguments, "symbolId")!;
                var graphTrimmed = false;
                while (Encoding.UTF8.GetByteCount(envelope.ToJsonString()) > budget)
                {
                    if (graphNodes.Count > 1)
                    {
                        var removed = new HashSet<string>(StringComparer.Ordinal);
                        var count = Math.Max(1, (graphNodes.Count - 1) / 2);
                        for (var i = 0; i < count; i++)
                        {
                            removed.Add(graphNodes[^1]!["symbolId"]!.GetValue<string>());
                            graphNodes.RemoveAt(graphNodes.Count - 1);
                        }
                        for (var i = graphEdges.Count - 1; i >= 0; i--)
                            if (removed.Contains(Text(graphEdges[i]!.AsObject(), "sourceSymbolId")!) || removed.Contains(Text(graphEdges[i]!.AsObject(), "targetSymbolId")!)) graphEdges.RemoveAt(i);
                        for (var i = boundaries.Count - 1; i >= 0; i--)
                            if (removed.Contains(Text(boundaries[i]!.AsObject(), "symbolId")!)) boundaries.RemoveAt(i);
                        for (var i = unresolved.Count - 1; i >= 0; i--)
                            if (unresolvedOwners.TryGetValue(unresolved[i]!.GetValue<string>(), out var owner) && removed.Contains(owner)) unresolved.RemoveAt(i);
                    }
                    else if (graphEdges.Count > 0) graphEdges.RemoveAt(graphEdges.Count - 1);
                    else if (unresolved.Count > 0) unresolved.RemoveAt(unresolved.Count - 1);
                    else break;
                    if (!graphTrimmed)
                    {
                        warnings.Add(new JsonObject { ["code"] = "RESPONSE_TRUNCATED", ["message"] = "Graph reduced to fit the response budget; request narrower bounds for additional paths.", ["retryable"] = false });
                        if (!boundaries.Any(b => b!["symbolId"]!.GetValue<string>() == rootId))
                            boundaries.Add(new JsonObject { ["symbolId"] = rootId, ["reason"] = "graphBudget" });
                    }
                    graphTrimmed = true; envelope["truncated"] = true;
                    var referenced = new HashSet<string>(StringComparer.Ordinal); CollectStrings(data, referenced);
                    envelope["evidence"] = Array(evidence.Where(pair => referenced.Contains(pair.Key)).Select(pair => (JsonNode?)pair.Value.DeepClone()));
                }
            }
            if (tool == "get_source" && data["fragments"] is JsonArray sourceFragments)
            {
                while (Encoding.UTF8.GetByteCount(envelope.ToJsonString()) > budget && sourceFragments.Count > 0)
                {
                    var fragment = sourceFragments[^1]!.AsObject();
                    var text = fragment["text"]!.GetValue<string>();
                    if (text.Length <= 1)
                    {
                        if (sourceFragments.Count == 1) break;
                        sourceFragments.RemoveAt(sourceFragments.Count - 1);
                    }
                    else
                    {
                        var length = text.Length / 2;
                        if (length > 0 && char.IsHighSurrogate(text[length - 1])) length--;
                        if (length == 0) break;
                        text = text[..length];
                        fragment["text"] = text;
                        var position = Microsoft.CodeAnalysis.Text.SourceText.From(text).Lines.GetLinePosition(length);
                        var start = fragment["range"]!["start"]!;
                        fragment["range"]!["end"] = new JsonObject {
                            ["line"] = start["line"]!.GetValue<int>() + position.Line,
                            ["character"] = position.Line == 0 ? start["character"]!.GetValue<int>() + position.Character : position.Character };
                    }
                    envelope["truncated"] = true;
                }
            }
            if (Encoding.UTF8.GetByteCount(envelope.ToJsonString()) > budget)
                throw new QueryException("INPUT_TOO_LARGE", "A response item exceeds the requested budget; increase the budget or reduce source/graph bounds.");
            transaction.Commit(); succeeded = true; return envelope;
        }
        catch (Exception ex) when (ex is QueryException or KeyNotFoundException or IOException or UnauthorizedAccessException or OperationCanceledException or DecoderFallbackException)
        {
            var code = ex is QueryException query ? query.Code : ex is OperationCanceledException ? "CANCELLED" : ex is UnauthorizedAccessException ? "ACCESS_DENIED" : ex is DecoderFallbackException ? "UNSUPPORTED_ENCODING" : "SOURCE_UNREADABLE";
            return new JsonObject { ["schemaVersion"] = "1.2", ["repositoryId"] = repositoryId, ["indexGeneration"] = generation, ["queryEpoch"] = epoch,
                ["error"] = new JsonObject { ["code"] = code, ["message"] = ex is QueryException ? ex.Message : "Requested source or operation is unavailable.", ["retryable"] = code is "CANCELLED" or "INDEX_STALE" } };
        }
        finally
        {
            if (measurement is not null)
            {
                var total = measurement.Elapsed.TotalMilliseconds;
                var modelEnd = inferenceEnd > 0 ? inferenceEnd : inferenceStart > 0 ? total : 0;
                var preparationStart = responseStart > 0 ? responseStart : total;
                MeasurementObserver!(new(succeeded, Math.Max(0, modelEnd - inferenceStart),
                    Math.Max(0, preparationStart - modelEnd), vectorMs, Math.Max(0, total - preparationStart), total));
            }
        }
    }

    private static void CollectStrings(JsonNode? node, HashSet<string> values)
    {
        if (node is JsonObject obj)
        {
            if (obj["external"] is JsonValue external && external.TryGetValue<bool>(out var isExternal) && isExternal && Text(obj, "symbolId") is string symbolId)
                values.Add(Identity.Id("pci:metadata:", symbolId));
            foreach (var item in obj) CollectStrings(item.Value, values);
        }
        else if (node is JsonArray array) foreach (var item in array) CollectStrings(item, values);
        else if (node is JsonValue value && value.TryGetValue<string>(out var text)) values.Add(text);
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

// Benchmark-only observation: no source/query text, wire fields or persistent telemetry.
internal sealed record QueryMeasurement(bool Succeeded, double ModelQueryIncludingLockMs, double RetrievalMs,
    double ExactVectorScanMs, double ResponsePreparationMs, double TotalMs);
