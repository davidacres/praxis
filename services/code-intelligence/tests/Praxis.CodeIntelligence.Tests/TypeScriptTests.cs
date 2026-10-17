using System.Text.Json.Nodes;
using Praxis.CodeIntelligence.Indexing;
using Praxis.CodeIntelligence.Queries;
using Praxis.CodeIntelligence.Storage;
using Xunit;

namespace Praxis.CodeIntelligence.Tests;

public sealed class TypeScriptTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), "praxis-ts-tests-" + Guid.NewGuid().ToString("N"));
    private readonly IndexDatabase database;

    public TypeScriptTests()
    {
        Directory.CreateDirectory(root);
        database = new(Path.Combine(root, "data", "index.db"));
        database.Initialize();
    }

    private void Write(string path, string text)
    {
        var full = Path.Combine(root, path);
        Directory.CreateDirectory(Path.GetDirectoryName(full)!);
        File.WriteAllText(full, text);
    }

    [Fact]
    public void ConfiguredTsconfigExtractsSymbolsOverloadsMergingParameterPropertiesCallsAndRelationships()
    {
        Write("tsconfig.json", """
            {
              "compilerOptions": {
                "target": "ES2022",
                "module": "commonjs",
                "strict": true
              },
              "include": ["src/**/*"]
            }
            """);

        Write("src/math.ts", """
            export interface Calculator {
              compute(x: number): number;
            }
            export interface Calculator {
              reset(): void;
            }
            export class BaseCalculator {
              protected ResetCore(): void {}
            }
            export class Adder extends BaseCalculator implements Calculator {
              private value: number = 0;
              constructor(private readonly offset: number) {
                super();
              }
              get current(): number {
                return this.value;
              }
              protected override ResetCore(): void {
                this.value = 0;
              }
              reset(): void {
                this.ResetCore();
              }
              compute(x: number): number;
              compute(x: string): number;
              compute(x: number | string): number {
                const n = typeof x === "number" ? x : Number(x);
                this.value = n + this.offset;
                if (this.value < 0) throw new Error("negative");
                return this.value;
              }
            }
            """);

        Write("src/app.ts", """
            import { Adder, Calculator } from "./math";
            export const runApp = (calc: Calculator): number => {
              const adder = new Adder(10);
              const items = [1, 2, 3].map(n => n + 1);
              const a = adder.compute(items[0]);
              const b = calc.compute(a);
              return b;
            };
            """);

        var indexer = new RepositoryIndexer(database);
        var repoId = indexer.Register(root);
        var indexResult = indexer.Index(repoId);
        Assert.True(indexResult.Changed);
        Assert.Equal(1, indexResult.Generation);
        Assert.Equal(2, indexResult.Files);
        Assert.False(indexer.Index(repoId).Changed);

        var queries = new QueryService(database);
        var allowed = new HashSet<string> { repoId };

        // 1. Index status should report complete resolution for tsconfig.json
        var status = queries.Execute("get_index_status", new JsonObject { ["repositoryId"] = repoId }, allowed);
        var contexts = status["data"]!["contexts"]!.AsArray();
        var ctx = Assert.Single(contexts)!;
        Assert.Equal("complete", ctx["resolution"]!.GetValue<string>());

        // 2. Declaration merging: Calculator interface has 2 declaration locations
        var calcFind = queries.Execute("find_symbol", new JsonObject { ["repositoryId"] = repoId, ["name"] = "Calculator" }, allowed);
        var calcSym = Assert.Single(calcFind["data"]!["items"]!.AsArray())!;
        Assert.Equal("type", calcSym["kind"]!.GetValue<string>());
        Assert.Equal("semantic", calcSym["identityStability"]!.GetValue<string>());
        Assert.Equal(2, calcSym["declarations"]!.AsArray().Count);

        // 3. Constructor parameter property 'offset' is attached to Adder
        var offsetFind = queries.Execute("find_symbol", new JsonObject { ["repositoryId"] = repoId, ["name"] = "offset" }, allowed);
        var offsetSym = Assert.Single(offsetFind["data"]!["items"]!.AsArray())!;
        Assert.Equal("property", offsetSym["kind"]!.GetValue<string>());
        Assert.Equal("src/math.Adder.offset", offsetSym["qualifiedName"]!.GetValue<string>());

        // 4. Overload signatures associate both signature and implementation locations (§26.3)
        var computeFind = queries.Execute("find_symbol", new JsonObject { ["repositoryId"] = repoId, ["name"] = "compute" }, allowed);
        var computeItems = computeFind["data"]!["items"]!.AsArray();
        var adderOverloads = computeItems
            .Where(item => item!["qualifiedName"]!.GetValue<string>() == "src/math.Adder.compute")
            .ToArray();
        Assert.Equal(3, adderOverloads.Length);
        Assert.Contains(adderOverloads, item => item!["declarations"]!.AsArray().Count == 2);

        // 5. Top-level arrow function runApp is indexed as a method, nested map callback as localEditSensitive function
        var runAppFind = queries.Execute("find_symbol", new JsonObject { ["repositoryId"] = repoId, ["name"] = "runApp" }, allowed);
        var runAppSym = Assert.Single(runAppFind["data"]!["items"]!.AsArray())!;
        var runAppId = runAppSym["symbolId"]!.GetValue<string>();
        Assert.Equal("method", runAppSym["kind"]!.GetValue<string>());
        Assert.Equal("semantic", runAppSym["identityStability"]!.GetValue<string>());

        var anonFind = queries.Execute("find_symbol", new JsonObject { ["repositoryId"] = repoId, ["name"] = "<anonymous>" }, allowed);
        var anonSym = Assert.Single(anonFind["data"]!["items"]!.AsArray())!;
        Assert.Equal("function", anonSym["kind"]!.GetValue<string>());
        Assert.Equal("localEditSensitive", anonSym["identityStability"]!.GetValue<string>());

        // 6. Callees of runApp: includes resolved calls and possible interface dispatch targets when includePossibleTargets=true
        var calleesResolved = queries.Execute("get_callees", new JsonObject
        {
            ["repositoryId"] = repoId,
            ["symbolId"] = runAppId,
            ["includePossibleTargets"] = false
        }, allowed);
        Assert.NotEmpty(calleesResolved["data"]!["items"]!.AsArray());

        var calleesPossible = queries.Execute("get_callees", new JsonObject
        {
            ["repositoryId"] = repoId,
            ["symbolId"] = runAppId,
            ["includePossibleTargets"] = true
        }, allowed);
        var possibleEdges = calleesPossible["data"]!["items"]!.AsArray();
        Assert.Contains(possibleEdges, e => e!["kind"]!.GetValue<string>() == "may_call" && e["resolution"]!.GetValue<string>() == "possible");

        // 7. Relationships on Adder: implements Calculator, inherits BaseCalculator
        var adderFind = queries.Execute("find_symbol", new JsonObject { ["repositoryId"] = repoId, ["name"] = "Adder" }, allowed);
        var adderSym = Assert.Single(adderFind["data"]!["items"]!.AsArray())!;
        var adderId = adderSym["symbolId"]!.GetValue<string>();

        var relatedImplements = queries.Execute("find_related", new JsonObject
        {
            ["repositoryId"] = repoId,
            ["symbolId"] = adderId,
            ["kinds"] = new JsonArray("implements")
        }, allowed);
        Assert.Contains(relatedImplements["data"]!["items"]!.AsArray(),
            item => item!["symbol"]!["qualifiedName"]!.GetValue<string>() == "src/math.Calculator");

        var relatedInherits = queries.Execute("find_related", new JsonObject
        {
            ["repositoryId"] = repoId,
            ["symbolId"] = adderId,
            ["kinds"] = new JsonArray("inherits")
        }, allowed);
        Assert.Contains(relatedInherits["data"]!["items"]!.AsArray(),
            item => item!["symbol"]!["qualifiedName"]!.GetValue<string>() == "src/math.BaseCalculator");

        // 8. Overrides relationship on ResetCore
        var resetCoreFind = queries.Execute("find_symbol", new JsonObject
        {
            ["repositoryId"] = repoId,
            ["name"] = "ResetCore",
            ["qualifiedName"] = "src/math.Adder.ResetCore"
        }, allowed);
        var resetCoreId = Assert.Single(resetCoreFind["data"]!["items"]!.AsArray())!["symbolId"]!.GetValue<string>();
        var relatedOverrides = queries.Execute("find_related", new JsonObject
        {
            ["repositoryId"] = repoId,
            ["symbolId"] = resetCoreId,
            ["kinds"] = new JsonArray("overrides")
        }, allowed);
        Assert.Single(relatedOverrides["data"]!["items"]!.AsArray());

        // 9. get_source and explain_symbol work on TypeScript symbols
        var sourceResp = queries.Execute("get_source", new JsonObject { ["repositoryId"] = repoId, ["symbolId"] = adderId }, allowed);
        var fragmentText = sourceResp["data"]!["fragments"]![0]!["text"]!.GetValue<string>();
        Assert.Contains("export class Adder", fragmentText);

        var explainResp = queries.Execute("explain_symbol", new JsonObject { ["repositoryId"] = repoId, ["symbolId"] = adderId }, allowed);
        Assert.Equal("compiler", explainResp["data"]!["provenance"]!.GetValue<string>());

        Assert.Empty(database.Check());
    }

    [Fact]
    public void MultiProjectTsconfigReferencesResolveCrossProjectCallsAndProjectDependencies()
    {
        Write("packages/core/tsconfig.json", """
            {
              "compilerOptions": {
                "target": "ES2022",
                "module": "commonjs",
                "composite": true,
                "strict": true
              },
              "include": ["src/**/*"]
            }
            """);
        Write("packages/core/src/index.ts", """
            export class CoreService {
              public greet(name: string): string {
                return "Hello " + name;
              }
            }
            """);

        Write("packages/app/tsconfig.json", """
            {
              "compilerOptions": {
                "target": "ES2022",
                "module": "commonjs",
                "strict": true
              },
              "references": [
                { "path": "../core" }
              ],
              "include": ["src/**/*"]
            }
            """);
        Write("packages/app/src/main.ts", """
            import { CoreService } from "../../core/src/index";
            export function startApp(): string {
              const svc = new CoreService();
              return svc.greet("Praxis");
            }
            """);

        var indexer = new RepositoryIndexer(database);
        var repoId = indexer.Register(root);
        var res = indexer.Index(repoId);
        Assert.Equal(2, res.Files);

        var queries = new QueryService(database);
        var allowed = new HashSet<string> { repoId };

        var startFind = queries.Execute("find_symbol", new JsonObject { ["repositoryId"] = repoId, ["name"] = "startApp" }, allowed);
        var startSym = Assert.Single(startFind["data"]!["items"]!.AsArray())!;
        var greetFind = queries.Execute("find_symbol", new JsonObject { ["repositoryId"] = repoId, ["name"] = "greet" }, allowed);
        var greetSym = Assert.Single(greetFind["data"]!["items"]!.AsArray())!;

        // Cross-project call resolves to greet in packages/core context
        Assert.NotEqual(startSym["contextId"]!.GetValue<string>(), greetSym["contextId"]!.GetValue<string>());
        var callees = queries.Execute("get_callees", new JsonObject
        {
            ["repositoryId"] = repoId,
            ["symbolId"] = startSym["symbolId"]!.GetValue<string>()
        }, allowed);
        Assert.Contains(callees["data"]!["items"]!.AsArray(),
            edge => edge!["targetSymbolId"]!.GetValue<string>() == greetSym["symbolId"]!.GetValue<string>());

        using (var conn = database.Open(readOnly: true))
        {
            using var cmd = conn.CreateCommand();
            cmd.CommandText = "SELECT count(*) FROM context_dependencies";
            Assert.Equal(1L, cmd.ExecuteScalar());
        }
        Assert.Empty(database.Check());
    }

    [Fact]
    public void WorkspacePackageImportedThroughBuiltDeclarationsResolvesToItsSource()
    {
        // A monorepo package is consumed through its emitted `types` entry (out/*.d.ts). Those
        // declarations must lead back to the source, not to an external placeholder.
        Write("packages/core/tsconfig.json", """
            { "compilerOptions": { "target": "ES2022", "module": "commonjs", "strict": true, "declaration": true, "outDir": "out", "rootDir": "src" }, "include": ["src/**/*"] }
            """);
        Write("packages/core/src/settings.ts", """
            export function sanitize(raw: unknown): string { return String(raw); }
            export class Store { save(value: string): void { void value; } }
            """);
        Write("packages/core/src/index.ts", "export * from \"./settings\";\n");
        Write("packages/core/out/settings.d.ts", """
            export declare function sanitize(raw: unknown): string;
            export declare class Store { save(value: string): void; }
            """);
        Write("packages/core/out/index.d.ts", "export * from \"./settings\";\n");
        Write("packages/app/tsconfig.json", """
            { "compilerOptions": { "target": "ES2022", "module": "commonjs", "strict": true, "paths": { "@acme/core": ["../core/out/index.d.ts"] } }, "include": ["src/**/*"] }
            """);
        Write("packages/app/src/main.ts", """
            import { sanitize, Store } from "@acme/core";
            export function run(): string { new Store().save("x"); return sanitize(1); }
            """);

        var indexer = new RepositoryIndexer(database); var repoId = indexer.Register(root); indexer.Index(repoId);
        var queries = new QueryService(database); var allowed = new HashSet<string> { repoId };
        JsonNode Single(string name) => Assert.Single(queries.Execute("find_symbol", new JsonObject { ["repositoryId"] = repoId, ["name"] = name }, allowed)["data"]!["items"]!.AsArray())!;
        var run = Single("run"); var sanitize = Single("sanitize"); var save = Single("save");
        Assert.False(sanitize["external"]!.GetValue<bool>());
        Assert.StartsWith("packages/core/src/settings.", sanitize["qualifiedName"]!.GetValue<string>());
        var callees = queries.Execute("get_callees", new JsonObject { ["repositoryId"] = repoId, ["symbolId"] = run["symbolId"]!.GetValue<string>() }, allowed)["data"]!["items"]!.AsArray()
            .Select(edge => edge!["targetSymbolId"]!.GetValue<string>()).ToHashSet();
        Assert.Contains(sanitize["symbolId"]!.GetValue<string>(), callees);
        Assert.Contains(save["symbolId"]!.GetValue<string>(), callees);
        using (var connection = database.Open(readOnly: true))
        using (var command = connection.CreateCommand())
        {
            command.CommandText = "SELECT count(*) FROM symbols WHERE external=1 AND name IN ('sanitize','Store','save')";
            Assert.Equal(0L, command.ExecuteScalar());
        }
        Assert.Empty(database.Check());
    }

    [Fact]
    public void JsxElementsRecordComponentUsageAsCallsButIntrinsicElementsDoNot()
    {
        Write("app/tsconfig.json", """
            { "compilerOptions": { "target": "ES2022", "module": "commonjs", "strict": true, "jsx": "preserve" }, "include": ["src/**/*"] }
            """);
        Write("app/src/jsx.d.ts", "declare namespace JSX { interface IntrinsicElements { [name: string]: unknown } }\n");
        Write("app/src/Panel.tsx", "export function Panel(props: { title: string }) { return <section>{props.title}</section>; }\n");
        Write("app/src/Page.tsx", """
            import { Panel } from "./Panel";
            export function Page() { return <div><Panel title="settings" /></div>; }
            """);

        var indexer = new RepositoryIndexer(database); var repoId = indexer.Register(root); indexer.Index(repoId);
        var queries = new QueryService(database); var allowed = new HashSet<string> { repoId };
        JsonNode Single(string name) => Assert.Single(queries.Execute("find_symbol", new JsonObject { ["repositoryId"] = repoId, ["name"] = name }, allowed)["data"]!["items"]!.AsArray())!;
        var panel = Single("Panel"); var page = Single("Page");
        var callers = queries.Execute("get_callers", new JsonObject { ["repositoryId"] = repoId, ["symbolId"] = panel["symbolId"]!.GetValue<string>() }, allowed)["data"]!["items"]!.AsArray();
        Assert.Contains(callers, edge => edge!["sourceSymbolId"]!.GetValue<string>() == page["symbolId"]!.GetValue<string>() && edge["kind"]!.GetValue<string>() == "calls");
        using var connection = database.Open(readOnly: true); using var command = connection.CreateCommand();
        command.CommandText = "SELECT count(*) FROM edges e JOIN symbols t ON t.symbol_id=e.target_symbol_id WHERE e.kind='calls' AND t.name IN ('div','section')";
        Assert.Equal(0L, command.ExecuteScalar());
    }

    [Fact]
    public void PolyglotRepositorySupportsLanguageFiltersAcrossCSharpTypeScriptAndJavaScript()
    {
        Write("Backend.cs", "namespace Backend; public class SharedWorker { public void ExecuteWork() {} }");
        Write("tsconfig.json", """
            {
              "compilerOptions": { "target": "ES2022", "module": "commonjs", "allowJs": true },
              "include": ["web/**/*"]
            }
            """);
        Write("web/client.ts", "export class SharedWorker { executeWork(): void {} }");
        Write("web/legacy.js", "export function executeWorkHelper() { return 42; }");

        var indexer = new RepositoryIndexer(database);
        var repoId = indexer.Register(root);
        var result = indexer.Index(repoId);
        Assert.Equal(3, result.Files);

        var queries = new QueryService(database);
        var allowed = new HashSet<string> { repoId };

        JsonObject SearchByLanguage(params string[] languages)
        {
            var langArr = new JsonArray(languages.Select(l => (JsonNode?)JsonValue.Create(l)).ToArray());
            return queries.Execute("search_code", new JsonObject
            {
                ["repositoryId"] = repoId,
                ["query"] = "ExecuteWork SharedWorker executeWorkHelper",
                ["mode"] = "lexical",
                ["filters"] = new JsonObject { ["languages"] = langArr }
            }, allowed);
        }

        var tsOnly = SearchByLanguage("typescript");
        var tsMatches = tsOnly["data"]!["matches"]!.AsArray();
        Assert.NotEmpty(tsMatches);
        Assert.All(tsMatches, m => Assert.StartsWith("web/client", m!["symbol"]!["qualifiedName"]!.GetValue<string>()));

        var jsOnly = SearchByLanguage("javascript");
        var jsMatches = jsOnly["data"]!["matches"]!.AsArray();
        Assert.NotEmpty(jsMatches);
        Assert.All(jsMatches, m => Assert.StartsWith("web/legacy", m!["symbol"]!["qualifiedName"]!.GetValue<string>()));

        var csOnly = SearchByLanguage("csharp");
        var csMatches = csOnly["data"]!["matches"]!.AsArray();
        Assert.NotEmpty(csMatches);
        Assert.All(csMatches, m => Assert.StartsWith("Backend.", m!["symbol"]!["qualifiedName"]!.GetValue<string>()));

        Assert.Empty(database.Check());
    }

    [Fact]
    public void UncoveredTypeScriptUsesSyntaxOnlyAndSidecarNeverExecutesUntrustedScripts()
    {
        var markerPath = Path.Combine(root, "pwned.txt");
        Write("package.json", $$"""
            {
              "name": "untrusted-repo",
              "scripts": {
                "postinstall": "touch {{markerPath}}",
                "prepare": "touch {{markerPath}}"
              }
            }
            """);
        Write("standalone.ts", "export class StandaloneWidget { render(): string { return 'ok'; } }");

        var indexer = new RepositoryIndexer(database);
        var repoId = indexer.Register(root);
        var indexed = indexer.Index(repoId);
        Assert.True(indexed.Changed);
        Assert.False(File.Exists(markerPath));

        var queries = new QueryService(database);
        var allowed = new HashSet<string> { repoId };
        var found = queries.Execute("find_symbol", new JsonObject { ["repositoryId"] = repoId, ["name"] = "StandaloneWidget" }, allowed);
        var sym = Assert.Single(found["data"]!["items"]!.AsArray())!;
        Assert.StartsWith("pci:syntactic:", sym["symbolId"]!.GetValue<string>());
        Assert.Equal("syntaxOnly", sym["resolution"]!.GetValue<string>());
        Assert.Equal("syntactic", sym["identityStability"]!.GetValue<string>());
        Assert.Empty(database.Check());
    }

    [Fact]
    public void SidecarFailureDegradesGracefullyToSyntaxOnlyWithDiagnostic()
    {
        Write("src/fallback.ts", "export class FallbackService {}\nexport function runFallback() { return 1; }\n");
        var previousNode = Environment.GetEnvironmentVariable("PRAXIS_NODE_BINARY");
        try
        {
            Environment.SetEnvironmentVariable("PRAXIS_NODE_BINARY", Path.Combine(root, "missing-node-binary"));
            var indexer = new RepositoryIndexer(database);
            var repoId = indexer.Register(root);
            var indexed = indexer.Index(repoId);
            Assert.True(indexed.Changed);

            var queries = new QueryService(database);
            var allowed = new HashSet<string> { repoId };
            var found = queries.Execute("find_symbol", new JsonObject { ["repositoryId"] = repoId, ["name"] = "FallbackService" }, allowed);
            var sym = Assert.Single(found["data"]!["items"]!.AsArray())!;
            Assert.Equal("syntaxOnly", sym["resolution"]!.GetValue<string>());

            var status = queries.Execute("get_index_status", new JsonObject { ["repositoryId"] = repoId }, allowed);
            var diags = status["data"]!["diagnostics"]!.AsArray();
            Assert.Contains(diags, d => d!["code"]!.GetValue<string>() == "TYPESCRIPT_SIDECAR_FAILED");
            Assert.Empty(database.Check());
        }
        finally
        {
            Environment.SetEnvironmentVariable("PRAXIS_NODE_BINARY", previousNode);
        }
    }

    [Fact]
    public void TruncatedSidecarStreamFallsBackInsteadOfPublishingAPartialAnalysis()
    {
        Write("src/partial.ts", "export class PartialService {}\n");
        // A sidecar that announces two symbols, sends one and stops before the end marker.
        Write("fake-sidecar.mjs", """
            process.stdin.resume();
            process.stdin.on('end', () => {
              const header = { protocolVersion: '1.1', adapterVersion: 'typescript-7.0/v2', contexts: [],
                counts: { symbols: 2, calls: 0, relationships: 0, configuredDependencies: 0, diagnostics: 0 } };
              process.stdout.write(JSON.stringify(header) + '\n');
              process.stdout.write(JSON.stringify({ symbol: { id: 'pci:sym:x', identity: 'x', contextId: '', kind: 'type', name: 'Ghost',
                qualifiedName: 'Ghost', signature: 'Ghost', revision: 'r', resolution: 'resolved', containerId: null, external: false,
                documentation: '', locations: [] } }) + '\n');
            });
            """);
        var previous = Environment.GetEnvironmentVariable("PRAXIS_TS_SIDECAR_PATH");
        try
        {
            Environment.SetEnvironmentVariable("PRAXIS_TS_SIDECAR_PATH", Path.Combine(root, "fake-sidecar.mjs"));
            var indexer = new RepositoryIndexer(database); var repoId = indexer.Register(root); indexer.Index(repoId);
            var queries = new QueryService(database); var allowed = new HashSet<string> { repoId };
            Assert.Empty(queries.Execute("find_symbol", new JsonObject { ["repositoryId"] = repoId, ["name"] = "Ghost" }, allowed)["data"]!["items"]!.AsArray());
            var found = Assert.Single(queries.Execute("find_symbol", new JsonObject { ["repositoryId"] = repoId, ["name"] = "PartialService" }, allowed)["data"]!["items"]!.AsArray())!;
            Assert.Equal("syntaxOnly", found["resolution"]!.GetValue<string>());
            var diagnostics = queries.Execute("get_index_status", new JsonObject { ["repositoryId"] = repoId }, allowed)["data"]!["diagnostics"]!.AsArray();
            Assert.Contains(diagnostics, d => d!["code"]!.GetValue<string>() == "TYPESCRIPT_SIDECAR_FAILED");
            Assert.Empty(database.Check());
        }
        finally { Environment.SetEnvironmentVariable("PRAXIS_TS_SIDECAR_PATH", previous); }
    }

    [LocalModelFact]
    public void PolyglotVectorAndHybridSearchPreserveLanguageFilters()
    {
        Write("InvoiceProcessor.cs", "namespace Billing; public class InvoiceProcessor { public decimal CalculateInvoiceTotal(decimal subtotal) => subtotal; }");
        Write("tsconfig.json", """
            {
              "compilerOptions": { "target": "ES2022", "module": "commonjs", "allowJs": true },
              "include": ["src/**/*"]
            }
            """);
        Write("src/invoice.ts", "export class TypeScriptInvoiceCalculator { calculateInvoiceTotal(subtotal: number): number { return subtotal; } }");
        Write("src/invoiceHelper.js", "export function calculateLegacyInvoiceTotal(subtotal) { return subtotal; }");

        var indexer = new RepositoryIndexer(database);
        var repoId = indexer.Register(root);
        indexer.Index(repoId);

        using var models = new Praxis.CodeIntelligence.Embeddings.ModelStore(database, Path.Combine(root, "models"));
        var profile = models.Install(Environment.GetEnvironmentVariable("PRAXIS_MODEL_BUNDLE")!);
        models.Activate(repoId, profile, CancellationToken.None);

        var queries = new QueryService(database, models);
        var allowed = new HashSet<string> { repoId };

        foreach (var mode in new[] { "vector", "hybrid" })
        {
            var tsResp = queries.Execute("search_code", new JsonObject
            {
                ["repositoryId"] = repoId,
                ["query"] = "calculate invoice total",
                ["mode"] = mode,
                ["filters"] = new JsonObject { ["languages"] = new JsonArray("typescript") }
            }, allowed);
            var tsMatches = tsResp["data"]!["matches"]!.AsArray();
            Assert.NotEmpty(tsMatches);
            Assert.All(tsMatches, m => Assert.True(m!["symbol"]!["qualifiedName"]!.GetValue<string>() is var n && (n.StartsWith("src/invoice") && !n.StartsWith("src/invoiceHelper") || n.Contains("[synthetic")), n));
            Assert.Contains(tsMatches, m => m!["symbol"]!["qualifiedName"]!.GetValue<string>().StartsWith("src/invoice."));
            Assert.Equal(tsResp["data"]!["eligibleSymbolCount"]!.GetValue<long>(), tsResp["data"]!["vectorCoveredSymbolCount"]!.GetValue<long>());

            var jsResp = queries.Execute("search_code", new JsonObject
            {
                ["repositoryId"] = repoId,
                ["query"] = "calculate invoice total",
                ["mode"] = mode,
                ["filters"] = new JsonObject { ["languages"] = new JsonArray("javascript") }
            }, allowed);
            var jsMatches = jsResp["data"]!["matches"]!.AsArray();
            Assert.NotEmpty(jsMatches);
            Assert.All(jsMatches, m => Assert.True(m!["symbol"]!["qualifiedName"]!.GetValue<string>() is var n && (n.StartsWith("src/invoiceHelper") || n.Contains("[synthetic")), n));
        }

        Assert.Empty(database.Check());
    }

    public void Dispose()
    {
        if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
    }
}
