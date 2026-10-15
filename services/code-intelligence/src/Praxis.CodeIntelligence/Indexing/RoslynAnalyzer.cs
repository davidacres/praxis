using System.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Operations;

namespace Praxis.CodeIntelligence.Indexing;

/// <summary>In-memory compiler analysis from explicit inputs. Never evaluates a project or executes generators.</summary>
public sealed class RoslynAnalyzer
{
    private sealed record CompilationInput(PassiveProject Project, IndexedContext Context, CSharpCompilation Compilation);
    private static readonly SymbolDisplayFormat SignatureFormat = SymbolDisplayFormat.CSharpErrorMessageFormat
        .WithMemberOptions(SymbolDisplayMemberOptions.IncludeContainingType | SymbolDisplayMemberOptions.IncludeType
            | SymbolDisplayMemberOptions.IncludeParameters | SymbolDisplayMemberOptions.IncludeExplicitInterface
            | SymbolDisplayMemberOptions.IncludeAccessibility | SymbolDisplayMemberOptions.IncludeModifiers)
        .WithParameterOptions(SymbolDisplayParameterOptions.IncludeType | SymbolDisplayParameterOptions.IncludeName
            | SymbolDisplayParameterOptions.IncludeParamsRefOut | SymbolDisplayParameterOptions.IncludeDefaultValue);

    public RepositoryAnalysis Analyze(string repositoryId, IReadOnlyList<SourceInput> sources, PassiveManifest? manifest,
        CancellationToken cancellationToken = default)
    {
        var inputs = new Dictionary<string, CompilationInput>(StringComparer.Ordinal);
        var projects = manifest?.Projects ?? [new PassiveProject("syntax", "Syntax", sources.Select(s => s.Path).ToArray())];
        var byPath = sources.ToDictionary(s => s.Path, StringComparer.Ordinal);
        var visiting = new HashSet<string>(StringComparer.Ordinal);
        foreach (var project in projects) Build(project.Key);
        var covered = inputs.Values.SelectMany(x => x.Context.Sources).Select(s => s.Path).ToHashSet(StringComparer.Ordinal);
        var uncovered = sources.Where(s => !covered.Contains(s.Path)).ToArray();
        if (manifest is not null && uncovered.Length > 0)
        {
            var fallback = new PassiveProject("uncovered-syntax", "Uncovered", uncovered.Select(s => s.Path).ToArray());
            projects = [.. projects, fallback]; Build(fallback.Key);
        }
        var treeContexts = inputs.Values.SelectMany(x => x.Compilation.SyntaxTrees.Select(t => (t, x.Context)))
            .ToDictionary(x => x.t, x => x.Context);
        var symbols = new Dictionary<string, IndexedSymbol>(StringComparer.Ordinal);
        var nodeSymbols = new Dictionary<SyntaxNode, string>();
        var sourceMethods = new Dictionary<string, (IMethodSymbol Symbol, IndexedContext Context)>();
        var sourceTypes = new Dictionary<string, (INamedTypeSymbol Symbol, IndexedContext Context)>();
        var calls = new List<IndexedCall>(); var diagnostics = new List<IndexedDiagnostic>();

        foreach (var input in inputs.Values)
        {
            var rootIdentity = Identity.Json(1, "synthetic", repositoryId, input.Context.Id, "projectRoot");
            var rootId = Identity.Id(input.Context.Resolution == "syntaxOnly" ? "pci:syntactic:" : "pci:sym:", rootIdentity);
            symbols[rootId] = new(rootId, rootIdentity, input.Context.Id, "module", "[synthetic projectRoot]",
                input.Project.AssemblyName + " [synthetic projectRoot]", "[synthetic projectRoot]",
                input.Context.Hash, input.Context.Resolution == "syntaxOnly" ? "syntaxOnly" : "resolved", null, false,
                "Synthetic context containment root; not a source declaration.", []);
            foreach (var tree in input.Compilation.SyntaxTrees)
            {
                cancellationToken.ThrowIfCancellationRequested();
                var source = byPath[tree.FilePath]; var model = input.Compilation.GetSemanticModel(tree);
                if (source.Role == "semanticSupport") continue;
                var syntaxRoot = tree.GetRoot(cancellationToken);
                nodeSymbols[syntaxRoot] = rootId;
                var globals = syntaxRoot.ChildNodes().OfType<GlobalStatementSyntax>().ToArray();
                if (globals.Length > 0)
                {
                    var entryIdentity = Identity.Json(1, "synthetic", repositoryId, input.Context.Id, source.Path, "topLevelEntry");
                    var entryId = Identity.Id(input.Context.Resolution == "syntaxOnly" ? "pci:syntactic:" : "pci:sym:", entryIdentity);
                    var span = Microsoft.CodeAnalysis.Text.TextSpan.FromBounds(globals[0].SpanStart, globals[^1].Span.End);
                    var location = new IndexedLocation(Identity.Id("pci:loc:", entryId, source.Hash, span.Start, span.End),
                        input.Context.Id, source.Path, source.Hash, span.Start, span.End, Range(tree, span));
                    symbols[entryId] = new(entryId, entryIdentity, input.Context.Id, "method", "[synthetic top-level entry]",
                        source.Path + " [synthetic top-level entry]", "[synthetic top-level entry]", source.Hash,
                        input.Context.Resolution == "syntaxOnly" ? "syntaxOnly" : "resolved", rootId, false,
                        "Synthetic source-level owner for top-level statements; not the compiler-generated Main method.", [location]);
                    foreach (var global in globals) nodeSymbols[global] = entryId;
                }
                foreach (var node in syntaxRoot.DescendantNodes().Where(IsDeclaration))
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    var compilerSymbol = node is AnonymousFunctionExpressionSyntax
                        ? (model.GetOperation(node, cancellationToken) as IAnonymousFunctionOperation)?.Symbol
                        : model.GetDeclaredSymbol(node, cancellationToken);
                    if (compilerSymbol is null) continue;
                    var identity = Identify(compilerSymbol, input.Context, node);
                    var location = new IndexedLocation(Identity.Id("pci:loc:", identity.Id, input.Context.Id, source.Path, source.Hash, node.Span.Start, node.Span.End),
                        input.Context.Id, source.Path, source.Hash, node.Span.Start, node.Span.End, Range(tree, node.Span));
                    var containerNode = node.Ancestors().FirstOrDefault(nodeSymbols.ContainsKey);
                    var signature = compilerSymbol.ToDisplayString(SignatureFormat);
                    var symbol = new IndexedSymbol(identity.Id, identity.Json, input.Context.Id, Kind(compilerSymbol), compilerSymbol.Name,
                        compilerSymbol.ToDisplayString(SymbolDisplayFormat.CSharpErrorMessageFormat), signature,
                        SourceFiles.Hash(Encoding.UTF8.GetBytes(node.ToFullString() + input.Context.Hash)),
                        input.Context.Resolution == "syntaxOnly" ? "syntaxOnly" : "resolved",
                        containerNode is null ? null : nodeSymbols[containerNode], false,
                        compilerSymbol.GetDocumentationCommentXml(cancellationToken: cancellationToken) ?? "", [location]);
                    if (symbols.TryGetValue(symbol.Id, out var existing))
                    {
                        if (existing.Identity != symbol.Identity) throw new InvalidOperationException("IDENTITY_COLLISION");
                        symbol = existing with { Locations = [.. existing.Locations, location], Revision = SourceFiles.Hash(Encoding.UTF8.GetBytes(existing.Revision + symbol.Revision)) };
                    }
                    symbols[symbol.Id] = symbol; nodeSymbols[node] = symbol.Id;
                    if (compilerSymbol is IMethodSymbol methodSymbol) sourceMethods[symbol.Id] = (methodSymbol, input.Context);
                    if (compilerSymbol is INamedTypeSymbol typeSymbol) sourceTypes[symbol.Id] = (typeSymbol, input.Context);
                    if (symbols.Count > 50_000) throw new IOException("INPUT_TOO_LARGE: symbol limit exceeded.");
                }
            }
        }
        // Build candidate dispatch once, rather than scanning every method at every callsite.
        // These are structural candidates only; runtime receiver identity is not inferred.
        var dispatch = new Dictionary<string, SortedSet<string>>(StringComparer.Ordinal);
        var limitedDispatch = new HashSet<string>(StringComparer.Ordinal);
        foreach (var (candidateId, entry) in sourceMethods)
        {
            var ancestor = entry.Symbol.OverriddenMethod;
            for (var depth = 0; ancestor is not null && depth < 128; depth++, ancestor = ancestor.OverriddenMethod)
                AddCandidate(Identify(ancestor, entry.Context, null).Id, candidateId);
        }
        foreach (var entry in sourceTypes.Values)
            foreach (var contract in entry.Symbol.AllInterfaces)
                foreach (var member in contract.GetMembers().OfType<IMethodSymbol>())
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    if (entry.Symbol.FindImplementationForInterfaceMember(member) is not IMethodSymbol implementation) continue;
                    var implementationId = Identify(implementation, entry.Context, null).Id;
                    if (sourceMethods.ContainsKey(implementationId)) AddCandidate(Identify(member, entry.Context, null).Id, implementationId);
                }
        void AddCandidate(string boundId, string candidateId)
        {
            if (boundId == candidateId) return;
            if (!dispatch.TryGetValue(boundId, out var candidates)) dispatch[boundId] = candidates = new(StringComparer.Ordinal);
            if (candidates.Count < 64) candidates.Add(candidateId);
            else if (!candidates.Contains(candidateId) && limitedDispatch.Add(boundId))
                diagnostics.Add(new("", null, "DISPATCH_TRUNCATED", "warning",
                    "Candidate dispatch is limited to 64 source targets for " + boundId + ". Runtime dispatch is not proven.", null));
        }
        foreach (var input in inputs.Values)
        {
            foreach (var tree in input.Compilation.SyntaxTrees)
            {
                var model = input.Compilation.GetSemanticModel(tree); var source = byPath[tree.FilePath];
                if (source.Role == "semanticSupport") continue;
                foreach (var node in tree.GetRoot(cancellationToken).DescendantNodes().Where(n => n is InvocationExpressionSyntax or ObjectCreationExpressionSyntax or ImplicitObjectCreationExpressionSyntax or BaseTypeSyntax))
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    var ownerNode = node.Ancestors().FirstOrDefault(n => nodeSymbols.TryGetValue(n, out var ownerId)
                        && symbols[ownerId].Kind is "type" or "method" or "function" or "constructor" or "accessor" or "module");
                    if (ownerNode is null) continue;
                    ISymbol? target = node is BaseTypeSyntax baseType
                        ? model.GetTypeInfo(baseType.Type, cancellationToken).Type
                        : model.GetSymbolInfo(node, cancellationToken).Symbol;
                    if (target is ITypeSymbol { TypeKind: TypeKind.Error }) target = null;
                    var relationKind = node is BaseTypeSyntax
                        ? target is INamedTypeSymbol { TypeKind: TypeKind.Interface } && model.GetDeclaredSymbol(ownerNode, cancellationToken) is INamedTypeSymbol { TypeKind: not TypeKind.Interface }
                            ? "implements" : "inherits"
                        : "calls";
                    string? targetId = null;
                    if (target is not null && input.Context.Resolution != "syntaxOnly")
                    {
                        var identity = Identify(target, input.Context, null); targetId = identity.Id;
                        if (!symbols.ContainsKey(targetId))
                        {
                            if (identity.External)
                                symbols[targetId] = new(targetId, identity.Json, "", Kind(target), target.Name,
                                    target.ToDisplayString(SymbolDisplayFormat.CSharpErrorMessageFormat), target.ToDisplayString(SignatureFormat),
                                    SourceFiles.Hash(Encoding.UTF8.GetBytes(identity.Json)), "resolved", null, true, "", []);
                            else targetId = null; // Unsupported declaration never creates a dangling endpoint.
                        }
                    }
                    var resolution = targetId is null ? (input.Context.Resolution == "syntaxOnly" ? "syntaxOnly" : "unresolved")
                        : input.Context.Resolution == "complete" ? "resolved" : "possible";
                    calls.Add(new(Identity.Id("pci:occ:", input.Context.Id, source.Path, source.Hash, node.Span.Start, node.Span.End),
                        input.Context.Id, source.Path, source.Hash, nodeSymbols[ownerNode], targetId, node.Span.Start, node.Span.End, Range(tree, node.Span), resolution, relationKind));
                    if (relationKind == "calls" && targetId is not null && target is IMethodSymbol { IsStatic: false }
                        && node is not InvocationExpressionSyntax { Expression: MemberAccessExpressionSyntax { Expression: BaseExpressionSyntax } }
                        && dispatch.TryGetValue(targetId, out var candidates))
                        foreach (var candidateId in candidates)
                            calls.Add(new(Identity.Id("pci:occ:", input.Context.Id, source.Path, source.Hash, node.Span.Start, node.Span.End, "may_call", candidateId),
                                input.Context.Id, source.Path, source.Hash, nodeSymbols[ownerNode], candidateId, node.Span.Start, node.Span.End,
                                Range(tree, node.Span), "possible", "may_call"));
                    if (calls.Count > 200_000) throw new IOException("INPUT_TOO_LARGE: occurrence limit exceeded.");
                }
            }
            foreach (var diagnostic in input.Compilation.GetDiagnostics(cancellationToken).Take(1000))
            {
                var tree = diagnostic.Location.SourceTree;
                diagnostics.Add(new(input.Context.Id, tree?.FilePath, diagnostic.Id,
                    diagnostic.Severity == DiagnosticSeverity.Error ? "error" : diagnostic.Severity == DiagnosticSeverity.Warning ? "warning" : "info",
                    diagnostic.GetMessage()[..Math.Min(diagnostic.GetMessage().Length, 4096)],
                    tree is null ? null : Range(tree, diagnostic.Location.SourceSpan)));
            }
        }
        return new(inputs.Values.Select(x => x.Context).ToArray(), symbols.Values.OrderBy(x => x.Id, StringComparer.Ordinal).ToArray(), calls, diagnostics);

        CompilationInput Build(string key)
        {
            if (inputs.TryGetValue(key, out var cached)) return cached;
            if (!visiting.Add(key)) throw new ArgumentException("Passive project references contain a cycle.");
            var project = projects.SingleOrDefault(x => x.Key == key) ?? throw new ArgumentException("Passive project reference is missing.");
            var projectSources = project.Sources.Concat(project.SupportSources ?? []).Distinct(StringComparer.Ordinal).Select(path =>
                byPath.TryGetValue(path, out var source) ? source : throw new IOException("Passive source is missing or excluded.")).ToArray();
            if (!LanguageVersionFacts.TryParse(project.LanguageVersion, out var languageVersion)) throw new ArgumentException("Invalid C# language version.");
            var parseOptions = new CSharpParseOptions(languageVersion, preprocessorSymbols: project.Defines ?? []);
            var trees = projectSources.Select(source => CSharpSyntaxTree.ParseText(source.Text, parseOptions, source.Path, cancellationToken: cancellationToken)).ToArray();
            var references = new List<MetadataReference>(); long metadataBytes = 0;
            foreach (var metadata in project.Metadata ?? [])
            {
                var bytes = PassiveManifest.ReadExternal(metadata.Path); metadataBytes += bytes.Length;
                if (metadataBytes > 512L * 1024 * 1024) throw new IOException("INPUT_TOO_LARGE: metadata limit exceeded.");
                if (SourceFiles.Hash(bytes) != metadata.ContentHash) throw new IOException("INDEX_STALE: captured metadata changed.");
                references.Add(MetadataReference.CreateFromImage(bytes, MetadataReferenceProperties.Assembly.WithAliases(metadata.Aliases ?? []).WithEmbedInteropTypes(metadata.EmbedInteropTypes)));
            }
            var dependencies = (project.References ?? []).Select(Build).ToArray();
            references.AddRange(dependencies.Select(x => x.Compilation.ToMetadataReference()));
            if (!Enum.TryParse<NullableContextOptions>(project.Nullable, ignoreCase: true, out var nullable)) throw new ArgumentException("Invalid nullable context option.");
            var outputKind = project.OutputKind.ToLowerInvariant() switch { "library" => OutputKind.DynamicallyLinkedLibrary, "exe" => OutputKind.ConsoleApplication, "winexe" => OutputKind.WindowsApplication, _ => throw new ArgumentException("Invalid output kind.") };
            var compilation = CSharpCompilation.Create(project.AssemblyName, trees, references,
                new CSharpCompilationOptions(outputKind, allowUnsafe: project.AllowUnsafe, nullableContextOptions: nullable));
            var syntaxOnly = manifest is null || key == "uncovered-syntax";
            var resolution = syntaxOnly ? "syntaxOnly" : compilation.GetDiagnostics(cancellationToken).Any(d => d.Severity == DiagnosticSeverity.Error) ? "partial" : "complete";
            var hash = SourceFiles.Hash(Encoding.UTF8.GetBytes(System.Text.Json.JsonSerializer.Serialize(project)
                + string.Join("|", projectSources.Select(s => s.Hash)) + string.Join("|", dependencies.Select(d => d.Context.Hash))));
            var context = new IndexedContext(key, key == "syntax" || key == "uncovered-syntax" ? "" : key,
                Identity.Id("pci:ctx:", repositoryId, key), hash, resolution, projectSources);
            var input = new CompilationInput(project, context, compilation); inputs[key] = input; visiting.Remove(key); return input;
        }

        (string Id, string Json, bool External) Identify(ISymbol symbol, IndexedContext current, SyntaxNode? declaration)
        {
            symbol = symbol.OriginalDefinition;
            if (symbol is IMethodSymbol { PartialDefinitionPart: not null } method) symbol = method.PartialDefinitionPart;
            var reference = symbol.DeclaringSyntaxReferences.FirstOrDefault();
            var defining = reference is not null && treeContexts.TryGetValue(reference.SyntaxTree, out var context) ? context : null;
            var external = defining is null && reference is null;
            var descriptor = symbol.GetDocumentationCommentId() ?? symbol.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat);
            if (symbol is IMethodSymbol { MethodKind: MethodKind.LocalFunction or MethodKind.AnonymousFunction })
            {
                var local = declaration ?? reference?.GetSyntax(cancellationToken);
                if (local is not null)
                {
                    // Preorder ordinals belong to the immediate callable, so edits inside a
                    // nested callable cannot renumber its enclosing callable's siblings.
                    var parent = local.Ancestors().FirstOrDefault(IsCallable);
                    var scope = parent ?? local.Ancestors().FirstOrDefault(IsDeclaration) ?? local.SyntaxTree.GetRoot(cancellationToken);
                    var ordinal = scope.DescendantNodes().Where(n => n is LocalFunctionStatementSyntax or AnonymousFunctionExpressionSyntax)
                        .Where(n => n.Ancestors().FirstOrDefault(IsCallable) == parent)
                        .TakeWhile(n => n != local).Count();
                    var globalScope = local.Ancestors().OfType<GlobalStatementSyntax>().FirstOrDefault();
                    if (parent is null && globalScope is not null) scope = globalScope;
                    var parentId = nodeSymbols.TryGetValue(scope, out var id) ? id
                        : Identity.Id("pci:scope:", current.Id, local.SyntaxTree.FilePath, scope.RawKind);
                    descriptor = Identity.Json("local", parentId, local.RawKind, ordinal);
                }
            }
            var syntax = (defining ?? current).Resolution == "syntaxOnly";
            var json = external
                ? Identity.Json(1, "external", repositoryId, "csharp", symbol.ContainingAssembly?.Identity.ToString(), Kind(symbol), descriptor)
                : Identity.Json(1, "source", repositoryId, (defining ?? current).Key, (defining ?? current).Id, "csharp", Kind(symbol), descriptor);
            return ((syntax && !external ? "pci:syntactic:" : "pci:sym:") + SourceFiles.Hash(Encoding.UTF8.GetBytes(json))[7..], json, external);
        }
    }

    private static bool IsDeclaration(SyntaxNode node) => node is BaseNamespaceDeclarationSyntax or BaseTypeDeclarationSyntax
        or DelegateDeclarationSyntax or BaseMethodDeclarationSyntax or PropertyDeclarationSyntax or IndexerDeclarationSyntax
        or EventDeclarationSyntax or AccessorDeclarationSyntax or LocalFunctionStatementSyntax or AnonymousFunctionExpressionSyntax
        || node is VariableDeclaratorSyntax { Parent.Parent: BaseFieldDeclarationSyntax };
    private static bool IsCallable(SyntaxNode node) => node is BaseMethodDeclarationSyntax or AccessorDeclarationSyntax
        or LocalFunctionStatementSyntax or AnonymousFunctionExpressionSyntax;
    private static string Kind(ISymbol symbol) => symbol switch
    {
        INamespaceSymbol => "namespace", INamedTypeSymbol => "type", IMethodSymbol m => m.MethodKind switch
        { MethodKind.Constructor or MethodKind.StaticConstructor => "constructor", MethodKind.LocalFunction or MethodKind.AnonymousFunction => "function",
          MethodKind.PropertyGet or MethodKind.PropertySet or MethodKind.EventAdd or MethodKind.EventRemove => "accessor", _ => "method" },
        IPropertySymbol => "property", IFieldSymbol => "field", IEventSymbol => "event", _ => symbol.Kind.ToString().ToLowerInvariant()
    };
    private static SourceRange Range(SyntaxTree tree, Microsoft.CodeAnalysis.Text.TextSpan span)
    {
        var range = tree.GetLineSpan(span); return new(new(range.StartLinePosition.Line, range.StartLinePosition.Character), new(range.EndLinePosition.Line, range.EndLinePosition.Character));
    }
}
