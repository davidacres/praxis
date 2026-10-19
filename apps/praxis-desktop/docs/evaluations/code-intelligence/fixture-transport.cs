// Explicit provisioning and production queries for disposable evaluation databases.
// Do not point this helper at the app's owner database.
using System;
using System.Collections.Generic;
using System.Text.Json.Nodes;
using Praxis.CodeIntelligence.Embeddings;
using Praxis.CodeIntelligence.Host;
using Praxis.CodeIntelligence.Indexing;
using Praxis.CodeIntelligence.Queries;
using Praxis.CodeIntelligence.Storage;

var database = new IndexDatabase(args[0]);
database.Initialize();
using var models = new ModelStore(database, args[1]);
var queries = new QueryService(database, models);
string? line;
while ((line = Console.ReadLine()) is not null)
{
    var request = JsonNode.Parse(line)!.AsObject();
    var tool = request["tool"]!.GetValue<string>();
    if (tool == "benchmark_index")
    {
        var indexer = new RepositoryIndexer(database);
        var repository = indexer.Register(request["root"]!.GetValue<string>());
        var result = indexer.Index(repository);
        Console.WriteLine(new JsonObject { ["repositoryId"] = repository, ["generation"] = result.Generation }.ToJsonString());
    }
    else if (tool == "benchmark_provision")
    {
        var fingerprint = models.Install(request["bundle"]!.GetValue<string>());
        models.Activate(request["repositoryId"]!.GetValue<string>(), fingerprint, default);
        Console.WriteLine(new JsonObject { ["fingerprint"] = fingerprint }.ToJsonString());
    }
    else if (tool == "benchmark_metadata")
        Console.WriteLine(new JsonObject { ["build"] = OwnerService.Build,
            ["rankingProfile"] = QueryService.RankingProfile, ["searchPlanVersion"] = QueryService.SearchPlanVersion }.ToJsonString());
    else
    {
        var arguments = request["arguments"]!.AsObject();
        Console.WriteLine(queries.Execute(tool, arguments, new HashSet<string> { arguments["repositoryId"]!.GetValue<string>() }).ToJsonString());
    }
}
