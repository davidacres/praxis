// Read-only transport for the production query engine on a private SQLite backup.
// No owner, scheduler, indexing, activation or ranking implementation lives here.
using System;
using System.Collections.Generic;
using System.Text.Json.Nodes;
using Praxis.CodeIntelligence.Embeddings;
using Praxis.CodeIntelligence.Host;
using Praxis.CodeIntelligence.Queries;
using Praxis.CodeIntelligence.Storage;

var database = new IndexDatabase(args[0]);
using var models = new ModelStore(database, args[1]);
var queries = new QueryService(database, models);
var allowed = new HashSet<string> { args[2] };
string? line;
while ((line = Console.ReadLine()) is not null)
{
    var request = JsonNode.Parse(line)!.AsObject();
    if (request["tool"]!.GetValue<string>() == "benchmark_metadata")
    {
        Console.WriteLine(new JsonObject {
            ["build"] = OwnerService.Build,
            ["rankingProfile"] = QueryService.RankingProfile,
            ["searchPlanVersion"] = QueryService.SearchPlanVersion
        }.ToJsonString());
        continue;
    }
    if (request["tool"]!.GetValue<string>() == "benchmark_activate")
    {
        models.Activate(args[2], request["fingerprint"]!.GetValue<string>(), default);
        Console.WriteLine(new JsonObject { ["activated"]=true }.ToJsonString());
        continue;
    }
    Console.WriteLine(queries.Execute(request["tool"]!.GetValue<string>(),
        request["arguments"]!.AsObject(), allowed).ToJsonString());
}
