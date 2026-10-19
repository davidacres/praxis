using System.Text;
using System.Text.Json;
using Praxis.CodeIntelligence.Embeddings;
using Praxis.CodeIntelligence.Indexing;
using Praxis.CodeIntelligence.Storage;
using Xunit;

namespace Praxis.CodeIntelligence.Tests;

public sealed class SemanticViewsTests
{
    [Fact]
    public void HeaderUsesSourceIdentityDocumentationAndResolvedNeighbours()
    {
        SemanticHeaderSymbol[] symbols = [
            new("download","downloadHTTPModel","main/src/models.downloadHTTPModel","main/src/models.downloadHTTPModel(): void","method","Downloads assets.","typescript"),
            new("refresh","refreshIndex","main/src/models.refreshIndex","main/src/models.refreshIndex(): void","method","Keeps vectors current.","typescript"),
            new("native","ReadValue","Native.Reader.ReadValue()","int Native.Reader.ReadValue()","method","","csharp")];
        var headers = SemanticHeaderBuilder.Build(symbols,[("refresh","download"),("missing","download")]);
        Assert.Contains("download HTTP Model", headers["download"]);
        Assert.Contains("Downloads assets.", headers["download"]);
        Assert.Contains("Used by: refresh Index: Keeps vectors current.", headers["download"]);
        Assert.DoesNotContain("missing", headers["download"]);
        Assert.False(headers.ContainsKey("native"));
        Assert.Equal(headers["download"], SemanticHeaderBuilder.Build(symbols.Reverse(),[("refresh","download")])["download"]);
    }

    [Fact]
    public void CSharpTopLevelPathsDoNotEnableSemanticHeaders()
    {
        SemanticHeaderSymbol[] symbols = [
            new("native", "[synthetic top-level entry]", "src/Program.cs [synthetic top-level entry]", "", "method", "", "csharp"),
            new("script", "readFile", "read.readFile", "readFile()", "method", "", "javascript"),
            new("unknown", "readFile", "src/read.readFile", "readFile()", "method", "")];
        var headers = SemanticHeaderBuilder.Build(symbols, []);
        Assert.False(headers.ContainsKey("native"));
        Assert.False(headers.ContainsKey("unknown"));
        Assert.True(headers.ContainsKey("script"));
    }

    [Fact]
    public void HeaderDoesNotCorruptVerbatimSourceCoordinates()
    {
        const string code = "prefix function readFile() { return '😀'; } suffix";
        var bytes = Encoding.UTF8.GetBytes(code);
        var source = new SourceInput("src/files.ts",SourceFiles.Hash(bytes),bytes,code);
        var start = code.IndexOf("function",StringComparison.Ordinal);
        var end = code.IndexOf(" suffix",StringComparison.Ordinal);
        var legacy = RepresentationBuilder.Build("src/files.readFile","readFile()", "", "",source,start,end);
        var current = RepresentationBuilder.Build("src/files.readFile","readFile()", "", "",source,start,end,"Read a file safely.");
        Assert.Equal(legacy.Hash,current.SourceViewHash);
        Assert.NotEqual(legacy.Hash,current.Hash);
        var span = Assert.Single(current.Sources);
        Assert.Equal(code[start..end],current.Text[span.RepresentationStart..span.RepresentationEnd]);
        Assert.Equal(source.Hash,span.ContentHash);
        Assert.Equal(SourceFiles.Hash(Encoding.UTF8.GetBytes(current.Text)),current.Hash);
    }

    [Fact]
    public void QueryViewsAreBoundedAndNeverReplaceTheOriginalQuestion()
    {
        const string query = "Where does a session check the folder before reading a file and returning its contents?";
        var views = SemanticQueryViews.Create(query);
        Assert.Equal(query,views[0]);
        Assert.InRange(views.Count,2,5);
        Assert.Equal(views.Count,views.Distinct(StringComparer.OrdinalIgnoreCase).Count());
        Assert.DoesNotContain(views, string.IsNullOrWhiteSpace);
    }

    [LocalModelFact]
    public void HeaderAndSourceViewsRetainFourChunkBoundAndExistingSourceVectors()
    {
        using var model = new LocalModel(Environment.GetEnvironmentVariable("PRAXIS_MODEL_BUNDLE")!);
        var code = string.Join(' ',Enumerable.Repeat("read value from repository and validate document ownership",500));
        var bytes = Encoding.UTF8.GetBytes(code);
        var source = new SourceInput("src/read.ts",SourceFiles.Hash(bytes),bytes,code);
        var legacy = RepresentationBuilder.Build("src/read.readDocument","readDocument()", "", "",source,0,code.Length);
        var current = RepresentationBuilder.Build("src/read.readDocument","readDocument()", "", "",source,0,code.Length,"Read a document after checking its owner.");
        var old = model.EmbedDetailedRepresentation(legacy.Text,default);
        var chunks = model.EmbedDetailedRepresentation(current,default);
        Assert.Equal(4,chunks.Count);
        Assert.All(chunks,chunk=>LocalModel.ValidateVector(chunk.Vector));
        for (var i=1;i<chunks.Count;i++) Assert.Equal(old[i-1].Vector,chunks[i].Vector);
        using var header = JsonDocument.Parse(RepresentationBuilder.ChunkMetadata(current,chunks[0].Span));
        Assert.True(header.RootElement.GetProperty("SemanticHeader").GetBoolean());
        Assert.Empty(header.RootElement.GetProperty("Sources").EnumerateArray());
        using var body = JsonDocument.Parse(RepresentationBuilder.ChunkMetadata(current,chunks[1].Span));
        Assert.False(body.RootElement.GetProperty("SemanticHeader").GetBoolean());
        Assert.NotEmpty(body.RootElement.GetProperty("Sources").EnumerateArray());
    }

    [LocalModelFact]
    public void CSharpTopLevelActivationKeepsSingleQueryView()
    {
        var root = Path.Combine(Path.GetTempPath(), "pci-csharp-header-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            var sourceRoot = Path.Combine(root, "source"); Directory.CreateDirectory(Path.Combine(sourceRoot, "nested"));
            File.WriteAllText(Path.Combine(sourceRoot, "nested", "Program.cs"), "System.Console.WriteLine(\"hello\");");
            var database = new IndexDatabase(Path.Combine(root, "data", "index.db")); database.Initialize();
            var indexer = new RepositoryIndexer(database); var repository = indexer.Register(sourceRoot); indexer.Index(repository);
            using var models = new ModelStore(database, Path.Combine(root, "models"));
            var fingerprint = models.Install(Environment.GetEnvironmentVariable("PRAXIS_MODEL_BUNDLE")!);
            models.Activate(repository, fingerprint, default);
            var query = models.QueryEmbedding(repository, "Where does the application print its greeting?", default, true)!;
            Assert.False(query.HasSemanticHeaders);
            Assert.Null(query.AlternateViews);
        }
        finally { Directory.Delete(root, recursive: true); }
    }

    [LocalModelFact]
    public void RepeatedActivationReusesHeaderAndSourceVectors()
    {
        var root = Path.Combine(Path.GetTempPath(), "pci-header-reuse-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            var sourceRoot = Path.Combine(root, "source");
            Directory.CreateDirectory(Path.Combine(sourceRoot, "src"));
            File.WriteAllText(Path.Combine(sourceRoot, "src", "read.ts"), "export function readDocument() { return 'document'; }");
            var database = new IndexDatabase(Path.Combine(root, "data", "index.db")); database.Initialize();
            var indexer = new RepositoryIndexer(database); var repository = indexer.Register(sourceRoot); indexer.Index(repository);
            using var models = new ModelStore(database, Path.Combine(root, "models"));
            var fingerprint = models.Install(Environment.GetEnvironmentVariable("PRAXIS_MODEL_BUNDLE")!);
            models.Activate(repository, fingerprint, default);
            using (var connection = database.Open(readOnly: true))
            using (var command = connection.CreateCommand())
            {
                command.CommandText = "SELECT count(*) FROM vectors WHERE json_extract(spans_json,'$.SemanticHeader')=1";
                Assert.True(Convert.ToInt64(command.ExecuteScalar()) > 0);
            }
            var committed = 0; models.BatchCommitted += count => committed += count;
            models.Activate(repository, fingerprint, default);
            Assert.Equal(0, committed);
            Assert.False(indexer.Index(repository).Changed);
        }
        finally { Directory.Delete(root, recursive: true); }
    }

    [LocalModelFact]
    public void SimilarityBalancesHeaderAndSourceInsteadOfTakingTheirMaximum()
    {
        var root = Path.Combine(Path.GetTempPath(),"pci-semantic-views-"+Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            File.WriteAllText(Path.Combine(root,"Example.cs"),"class Example { int Weak() => 1; int Strong() => 2; }");
            var database = new IndexDatabase(Path.Combine(root,"data","index.db"));database.Initialize();
            var indexer = new RepositoryIndexer(database);var repo=indexer.Register(root);indexer.Index(repo);
            using var models = new ModelStore(database,Path.Combine(root,"models"));
            var fingerprint=models.Install(Environment.GetEnvironmentVariable("PRAXIS_MODEL_BUNDLE")!);models.Activate(repo,fingerprint,default);
            var selected = new Dictionary<string,string>();
            using (var connection=database.Open())
            {
                using (var command=connection.CreateCommand())
                {
                    command.CommandText="SELECT s.name,e.set_id FROM symbols s JOIN embedding_sets e ON e.symbol_id=s.symbol_id WHERE s.name IN ('Weak','Strong')";
                    using var reader=command.ExecuteReader();while(reader.Read())selected[reader.GetString(0)]=reader.GetString(1);
                }
                foreach(var (name,set) in selected)
                {
                    using var command=connection.CreateCommand();
                    command.CommandText="UPDATE embedding_sets SET state='pending' WHERE set_id=$set; DELETE FROM vectors WHERE set_id=$set; UPDATE embedding_sets SET expected_chunks=2 WHERE set_id=$set";
                    command.Parameters.AddWithValue("$set",set);command.ExecuteNonQuery();
                    for(var chunk=0;chunk<2;chunk++)
                    {
                        var vector=new float[384];
                        if(name=="Weak")vector[chunk==0?1:0]=1;
                        else {vector[0]=.8f;vector[1]=.6f;}
                        command.Parameters.Clear();
                        command.CommandText="INSERT INTO vectors VALUES($set,$chunk,384,$values,$spans)";
                        command.Parameters.AddWithValue("$set",set);command.Parameters.AddWithValue("$chunk",chunk);
                        command.Parameters.AddWithValue("$values",System.Runtime.InteropServices.MemoryMarshal.AsBytes(vector.AsSpan()).ToArray());
                        command.Parameters.AddWithValue("$spans",chunk==0?"{\"SemanticHeader\":true}":"{}");command.ExecuteNonQuery();
                    }
                    command.Parameters.Clear();command.CommandText="UPDATE embedding_sets SET state='ready' WHERE set_id=$set";command.Parameters.AddWithValue("$set",set);command.ExecuteNonQuery();
                }
            }
            var basis=new float[384];basis[0]=1;
            using(var connection=database.Open(readOnly:true))
            using(var transaction=connection.BeginTransaction(deferred:true))
            {
                var ranked=ModelStore.Candidates(connection,transaction,repo,new ModelQuery(fingerprint,basis,true),null,["method"],null);
                var ids=ranked.Select(item=>item.SymbolId).ToArray();
                using var command=connection.CreateCommand();command.Transaction=transaction;
                command.CommandText="SELECT symbol_id FROM symbols WHERE name='Strong'";var strong=(string)command.ExecuteScalar()!;
                command.CommandText="SELECT symbol_id FROM symbols WHERE name='Weak'";var weak=(string)command.ExecuteScalar()!;
                Assert.True(Array.IndexOf(ids,strong)<Array.IndexOf(ids,weak));
                // Compare the shared scan with separately evaluated views and
                // the original reciprocal-rank fusion, including exact scores.
                var other = new float[384]; other[1] = 1;
                var queryViews = new[] { new ModelQuery(fingerprint,basis,true), new ModelQuery(fingerprint,other,true), new ModelQuery(fingerprint,basis,true) };
                var combined = queryViews[0] with { AlternateViews = queryViews.Skip(1).ToArray() };
                void CompareViews(string? context = null, IReadOnlyList<string>? kinds = null, IReadOnlyList<string>? projects = null, IReadOnlyList<string>? languages = null)
                {
                    var expected = new Dictionary<string,double>(StringComparer.Ordinal);
                    for (var v = 0; v < queryViews.Length; v++)
                    {
                        var separate = ModelStore.Candidates(connection,transaction,repo,queryViews[v],context,kinds,projects,languages:languages);
                        for (var rank = 0; rank < separate.Count; rank++)
                            expected[separate[rank].SymbolId] = expected.GetValueOrDefault(separate[rank].SymbolId) + (v == 0 ? 2.0 : 1.0) / (5 + rank + 1);
                    }
                    var fused = expected.OrderByDescending(p => p.Value).ThenBy(p => p.Key,StringComparer.Ordinal).Take(100).Select(p => new VectorCandidate(p.Key,p.Value)).ToArray();
                    Assert.Equal(fused,ModelStore.Candidates(connection,transaction,repo,combined,context,kinds,projects,languages:languages));
                }
                CompareViews(); CompareViews(kinds:["method"]); CompareViews(kinds:["missing"]);
                CompareViews(context:"missing"); CompareViews(projects:["missing"]);
                CompareViews(languages:["csharp"]); CompareViews(languages:["typescript"]);
                Assert.Throws<InvalidOperationException>(() => ModelStore.Candidates(connection,transaction,repo,combined,null,null,null,maximumChunks:1));
                Assert.Throws<OperationCanceledException>(() => ModelStore.Candidates(connection,transaction,repo,combined,null,null,null,new CancellationToken(true)));

            }
            var expanded=models.QueryEmbedding(repo,"Where does a reader validate a document before opening it?",default,true)!;
            Assert.True(expanded.HasSemanticHeaders);Assert.NotEmpty(expanded.AlternateViews!);Assert.InRange(expanded.AlternateViews!.Count,1,4);
        }
        finally {Directory.Delete(root,recursive:true);}
    }
}
