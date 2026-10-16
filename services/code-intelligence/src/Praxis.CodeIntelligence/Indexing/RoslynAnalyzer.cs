using System.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Operations;

namespace Praxis.CodeIntelligence.Indexing;

/// <summary>In-memory compiler analysis from explicit inputs. Never evaluates a project or executes generators.</summary>
public sealed class RoslynAnalyzer
{
    public const string AdapterVersion = "roslyn-5.9/v6";
    private sealed record CompilationInput(PassiveProject Project, IndexedContext Context, CSharpCompilation Compilation, IReadOnlyList<Diagnostic> Diagnostics);
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
        var metadataCache = new Dictionary<string, (string Hash, PortableExecutableReference Reference)>(StringComparer.Ordinal);
        long totalMetadataBytes = 0;
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
        // Keep each semantic model for this analysis only: declaration, call and
        // relationship passes share its bound-node cache without retaining old snapshots.
        var models = inputs.Values.SelectMany(input => input.Compilation.SyntaxTrees
            .Select(tree => (Tree: tree, Model: input.Compilation.GetSemanticModel(tree))))
            .ToDictionary(entry => entry.Tree, entry => entry.Model);
        var identities = new Dictionary<string, Dictionary<ISymbol, (string Id, string Json, bool External)>>(StringComparer.Ordinal);
        var symbols = new Dictionary<string, IndexedSymbol>(StringComparer.Ordinal);
        var projectRoots = new Dictionary<string, string>(StringComparer.Ordinal);
        var nodeSymbols = new Dictionary<SyntaxNode, string>();
        var sourceMethods = new Dictionary<string, (IMethodSymbol Symbol, IndexedContext Context)>();
        var sourceTypes = new Dictionary<string, (INamedTypeSymbol Symbol, IndexedContext Context)>();
        var calls = new List<IndexedCall>(); var diagnostics = new List<IndexedDiagnostic>();

        foreach (var input in inputs.Values)
        {
            var rootIdentity = Identity.Json(1, "synthetic", repositoryId, input.Context.Id, "projectRoot");
            var rootId = Identity.Id(input.Context.Resolution == "syntaxOnly" ? "pci:syntactic:" : "pci:sym:", rootIdentity);
            projectRoots[input.Context.Id] = rootId;
            symbols[rootId] = new(rootId, rootIdentity, input.Context.Id, "module", "[synthetic projectRoot]",
                input.Project.AssemblyName + " [synthetic projectRoot]", "[synthetic projectRoot]",
                input.Context.Hash, input.Context.Resolution == "syntaxOnly" ? "syntaxOnly" : "resolved", null, false,
                "Synthetic context containment root; not a source declaration.", []);
            foreach (var tree in input.Compilation.SyntaxTrees)
            {
                cancellationToken.ThrowIfCancellationRequested();
                var source = byPath[tree.FilePath]; var model = models[tree];
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
                var model = models[tree]; var source = byPath[tree.FilePath];
                if (source.Role == "semanticSupport") continue;
                foreach (var node in tree.GetRoot(cancellationToken).DescendantNodes().Where(n => n is InvocationExpressionSyntax or ObjectCreationExpressionSyntax or ImplicitObjectCreationExpressionSyntax or BaseTypeSyntax
                    || n is MethodDeclarationSyntax methodDeclaration && methodDeclaration.Modifiers.Any(SyntaxKind.OverrideKeyword)))
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    var ownerNode = node is MethodDeclarationSyntax ? node : node.Ancestors().FirstOrDefault(n => nodeSymbols.TryGetValue(n, out var ownerId)
                        && symbols[ownerId].Kind is "type" or "method" or "function" or "constructor" or "accessor" or "module");
                    if (ownerNode is null) continue;
                    ISymbol? target = node switch
                    {
                        BaseTypeSyntax baseType => model.GetTypeInfo(baseType.Type, cancellationToken).Type,
                        MethodDeclarationSyntax methodDeclaration => (model.GetDeclaredSymbol(methodDeclaration, cancellationToken) as IMethodSymbol)?.OverriddenMethod,
                        _ => model.GetSymbolInfo(node, cancellationToken).Symbol
                    };
                    if (target is ITypeSymbol { TypeKind: TypeKind.Error }) target = null;
                    var relationKind = node is MethodDeclarationSyntax ? "overrides" : node is BaseTypeSyntax
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
                            else if (target is IMethodSymbol { MethodKind: MethodKind.Constructor, IsImplicitlyDeclared: true }
                                && symbols.TryGetValue(Identify(target.ContainingType, input.Context, null).Id, out var containingType))
                                symbols[targetId] = new(targetId, identity.Json, containingType.ContextId, "constructor", target.Name,
                                    target.ToDisplayString(SymbolDisplayFormat.CSharpErrorMessageFormat), target.ToDisplayString(SignatureFormat),
                                    SourceFiles.Hash(Encoding.UTF8.GetBytes(identity.Json + containingType.Revision)), "resolved", containingType.Id, false,
                                    "Implicit source constructor inferred by the compiler; no explicit declaration.", []);
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
            foreach (var diagnostic in input.Diagnostics.Take(1000))
            {
                var tree = diagnostic.Location.SourceTree;
                diagnostics.Add(new(input.Context.Id, tree?.FilePath, diagnostic.Id,
                    diagnostic.Severity == DiagnosticSeverity.Error ? "error" : diagnostic.Severity == DiagnosticSeverity.Warning ? "warning" : "info",
                    diagnostic.GetMessage()[..Math.Min(diagnostic.GetMessage().Length, 4096)],
                    tree is null ? null : Range(tree, diagnostic.Location.SourceSpan)));
            }
        }
        var relationships = new List<IndexedCall>();
        var relationshipIds = new HashSet<string>(StringComparer.Ordinal);
        foreach (var input in inputs.Values)
        {
            if (input.Context.Resolution == "syntaxOnly") continue;
            foreach (var tree in input.Compilation.SyntaxTrees)
            {
                var source = byPath[tree.FilePath]; if (source.Role == "semanticSupport") continue;
                var model = models[tree]; var root = tree.GetRoot(cancellationToken);
                string? Owner(SyntaxNode node) => node.AncestorsAndSelf().Where(nodeSymbols.ContainsKey)
                    .Select(node => nodeSymbols[node]).FirstOrDefault(id => symbols[id].Kind is "type" or "method" or "function" or "constructor" or "accessor" or "module");
                void Add(SyntaxNode node, string owner, ISymbol target, string kind)
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    if (target is ITypeSymbol { TypeKind: TypeKind.Error }) return;
                    var identity = Identify(target, input.Context, null);
                    if (!symbols.ContainsKey(identity.Id))
                    {
                        if (!identity.External) return;
                        symbols[identity.Id] = new(identity.Id, identity.Json, "", Kind(target), target.Name,
                            target.ToDisplayString(SymbolDisplayFormat.CSharpErrorMessageFormat), target.ToDisplayString(SignatureFormat),
                            SourceFiles.Hash(Encoding.UTF8.GetBytes(identity.Json)), "resolved", null, true, "", []);
                    }
                    var occurrenceId = Identity.Id("pci:occ:", input.Context.Id, source.Path, source.Hash, node.SpanStart, node.Span.End, owner, kind, identity.Id);
                    if (!relationshipIds.Add(occurrenceId)) return;
                    relationships.Add(new(occurrenceId,
                        input.Context.Id, source.Path, source.Hash, owner, identity.Id, node.SpanStart, node.Span.End, Range(tree, node.Span),
                        input.Context.Resolution == "complete" ? "resolved" : "possible", kind));
                    if (relationships.Count + calls.Count > 200_000 || symbols.Count > 50_000)
                        throw new IOException("INPUT_TOO_LARGE: semantic fact limit exceeded.");
                }
                foreach (var directive in root.DescendantNodes().OfType<UsingDirectiveSyntax>())
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    if (directive.Name is null || Owner(directive) is not string owner) continue;
                    var imported = model.GetSymbolInfo(directive.Name, cancellationToken).Symbol;
                    // Merged namespaces may span multiple defining projects/assemblies.
                    // Resolve each constituent rather than assigning a referencing-context identity.
                    if (imported is INamespaceSymbol importedNamespace)
                    {
                        foreach (var constituent in importedNamespace.ConstituentNamespaces)
                            if (constituent.ContainingAssembly is not null)
                                Add(directive.Name, owner, constituent, "imports");
                    }
                    else if (imported is INamedTypeSymbol) Add(directive.Name, owner, imported, "imports");
                }
                foreach (var name in root.DescendantNodes().OfType<SimpleNameSyntax>())
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    var target = model.GetSymbolInfo(name, cancellationToken).Symbol;
                    if (target is not (INamedTypeSymbol or IMethodSymbol or IFieldSymbol or IPropertySymbol or IEventSymbol)
                        || Owner(name) is not string owner) continue;
                    Add(name, owner, target, "references");
                    if (target is not (IFieldSymbol or IPropertySymbol)) continue;
                    var expression = name.Parent is MemberAccessExpressionSyntax access && access.Name == name ? (SyntaxNode)access
                        : name.Parent is MemberBindingExpressionSyntax binding ? binding : name;
                    var operation = model.GetOperation(expression, cancellationToken);
                    if (operation is not (IFieldReferenceOperation or IPropertyReferenceOperation)) continue;
                    // nameof produces a reference, never a runtime access classification.
                    if (Ancestors(operation).Any(parent => parent is INameOfOperation)) continue;
                    var parent = operation.Parent; var read = true; var write = false;
                    if (parent is ISimpleAssignmentOperation assignment && assignment.Target == operation) { read = false; write = true; }
                    else if (parent is ICompoundAssignmentOperation compound && compound.Target == operation
                        || parent is ICoalesceAssignmentOperation coalesce && coalesce.Target == operation
                        || parent is IIncrementOrDecrementOperation) write = true;
                    else if (parent is IArgumentOperation argument)
                    {
                        if (argument.Parameter?.RefKind == RefKind.Out) { read = false; write = true; }
                        else if (argument.Parameter?.RefKind == RefKind.Ref) write = true;
                    }
                    else if (Ancestors(operation).Any(parent => parent is IDeconstructionAssignmentOperation)) continue;
                    if (read) Add(name, owner, target, "reads");
                    if (write) Add(name, owner, target, "writes");
                }
                foreach (var node in root.DescendantNodes())
                {
                    if (node is PropertyDeclarationSyntax or IndexerDeclarationSyntax or EventDeclarationSyntax
                        && nodeSymbols.TryGetValue(node, out var memberOwner))
                    {
                        var overridden = model.GetDeclaredSymbol(node, cancellationToken) switch
                        {
                            IPropertySymbol property => (ISymbol?)property.OverriddenProperty,
                            IEventSymbol eventSymbol => eventSymbol.OverriddenEvent,
                            _ => null
                        };
                        if (overridden is not null) Add(node, memberOwner, overridden, "overrides");
                    }
                    if (node is BaseTypeDeclarationSyntax && model.GetDeclaredSymbol(node, cancellationToken) is INamedTypeSymbol { TypeKind: TypeKind.Class or TypeKind.Struct } implementingType)
                    {
                        foreach (var contract in implementingType.AllInterfaces)
                            foreach (var member in contract.GetMembers())
                            {
                                cancellationToken.ThrowIfCancellationRequested();
                                if (implementingType.FindImplementationForInterfaceMember(member) is not ISymbol implementation) continue;
                                var implementationId = Identify(implementation, input.Context, null).Id;
                                if (symbols.TryGetValue(implementationId, out var indexed) && !indexed.External)
                                    Add(node, implementationId, member, "implements");
                            }
                    }
                    if (node is ThrowStatementSyntax or ThrowExpressionSyntax or InvocationExpressionSyntax or AssignmentExpressionSyntax
                        && Owner(node) is string occurrenceOwner)
                    {
                        var thrown = node switch { ThrowStatementSyntax statement => statement.Expression, ThrowExpressionSyntax expression => expression.Expression, _ => null };
                        if (thrown is not null && model.GetTypeInfo(thrown, cancellationToken).Type is INamedTypeSymbol exception)
                            Add(node, occurrenceOwner, exception, "throws_explicitly");
                        if (node is InvocationExpressionSyntax && model.GetOperation(node, cancellationToken) is IInvocationOperation { TargetMethod.MethodKind: MethodKind.DelegateInvoke } invocation)
                        {
                            var receiver = invocation.Instance;
                            if (receiver is IConditionalAccessInstanceOperation)
                                receiver = Ancestors(invocation).OfType<IConditionalAccessOperation>().FirstOrDefault()?.Operation;
                            if (receiver is IEventReferenceOperation emitted) Add(node, occurrenceOwner, emitted.Event, "emits_event");
                        }
                        if (node is AssignmentExpressionSyntax && model.GetOperation(node, cancellationToken) is IEventAssignmentOperation { Adds: true } subscription
                            && subscription.EventReference is IEventReferenceOperation subscribed)
                        {
                            var handler = subscription.HandlerValue is IDelegateCreationOperation creation ? creation.Target : subscription.HandlerValue;
                            IMethodSymbol? handlerMethod = handler switch { IMethodReferenceOperation reference => reference.Method, IAnonymousFunctionOperation anonymous => anonymous.Symbol, _ => null };
                            if (handlerMethod is not null && symbols.ContainsKey(Identify(handlerMethod, input.Context, null).Id))
                                Add(node, Identify(handlerMethod, input.Context, null).Id, subscribed.Event, "handles_event");
                            else diagnostics.Add(new(input.Context.Id, source.Path, "EVENT_HANDLER_UNRESOLVED", "info",
                                "Event subscription handler is not a directly bound indexed source callable; runtime handler flow is not inferred.", Range(tree, node.Span)));
                        }
                    }
                    TypeSyntax? declared = node switch
                    {
                        MethodDeclarationSyntax method => method.ReturnType,
                        DelegateDeclarationSyntax declaration => declaration.ReturnType,
                        PropertyDeclarationSyntax property => property.Type,
                        IndexerDeclarationSyntax indexer => indexer.Type,
                        VariableDeclarationSyntax variable => variable.Type,
                        ParameterSyntax parameter => parameter.Type,
                        EventDeclarationSyntax eventDeclaration => eventDeclaration.Type,
                        ForEachStatementSyntax loop => loop.Type,
                        _ => null
                    };
                    if (declared is null || Owner(node) is not string owner) continue;
                    if (node is MethodDeclarationSyntax or DelegateDeclarationSyntax
                        && nodeSymbols.TryGetValue(node, out var callable)
                        && model.GetTypeInfo(declared, cancellationToken).Type is INamedTypeSymbol returnType)
                        Add(declared, callable, returnType, "returns_type");
                    var dependencyOwners = nodeSymbols.TryGetValue(node, out var declarationOwner) ? new[] { declarationOwner }
                        : node is VariableDeclarationSyntax { Parent: BaseFieldDeclarationSyntax } fields
                            ? fields.Variables.Where(nodeSymbols.ContainsKey).Select(variable => nodeSymbols[variable]).ToArray()
                            : new[] { owner };
                    foreach (var type in declared.DescendantNodesAndSelf().OfType<TypeSyntax>())
                        if (model.GetTypeInfo(type, cancellationToken).Type is INamedTypeSymbol dependency)
                            foreach (var dependencyOwner in dependencyOwners) Add(type, dependencyOwner, dependency, "uses_type");
                }
            }
        }
        // Lift observed source references to project dependencies without inventing
        // source evidence for an unused configuration-only project reference.
        var projectDependencies = new Dictionary<string, IndexedCall>(StringComparer.Ordinal);
        var contextResolutions = inputs.Values.ToDictionary(input => input.Context.Id, input => input.Context.Resolution, StringComparer.Ordinal);
        foreach (var fact in calls.Concat(relationships))
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (fact.TargetId is null || !symbols.TryGetValue(fact.TargetId, out var target) || target.External
                || target.ContextId == fact.ContextId || !projectRoots.TryGetValue(target.ContextId, out var targetRoot)) continue;
            var ownerRoot = projectRoots[fact.ContextId];
            var dependencyId = Identity.Id("pci:occ:", fact.ContextId, fact.FilePath, fact.Hash, fact.Start, fact.End, ownerRoot, "depends_on", targetRoot);
            projectDependencies.TryAdd(dependencyId, fact with { Id = dependencyId, OwnerId = ownerRoot, TargetId = targetRoot, Kind = "depends_on",
                Resolution = fact.Resolution == "resolved" && contextResolutions[target.ContextId] == "complete" ? "resolved" : "possible" });
            if (calls.Count + relationships.Count + projectDependencies.Count > 200_000)
                throw new IOException("INPUT_TOO_LARGE: semantic fact limit exceeded.");
        }
        relationships.AddRange(projectDependencies.Values);
        return new(inputs.Values.Select(x => x.Context).ToArray(), symbols.Values.OrderBy(x => x.Id, StringComparer.Ordinal).ToArray(), calls, diagnostics)
            { Relationships = relationships };

        static IEnumerable<IOperation> Ancestors(IOperation operation)
        {
            while (operation.Parent is IOperation parent) { yield return parent; operation = parent; }
        }


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
            var references = new List<MetadataReference>();
            foreach (var metadata in project.Metadata ?? [])
            {
                if (!metadataCache.TryGetValue(metadata.Path, out var cachedMetadata))
                {
                    var bytes = PassiveManifest.ReadExternal(metadata.Path);
                    totalMetadataBytes += bytes.Length;
                    if (totalMetadataBytes > 512L * 1024 * 1024) throw new IOException("INPUT_TOO_LARGE: repository metadata limit exceeded.");
                    if (SourceFiles.Hash(bytes) != metadata.ContentHash) throw new IOException("INDEX_STALE: captured metadata changed.");
                    cachedMetadata = (metadata.ContentHash, MetadataReference.CreateFromImage(bytes));
                    metadataCache[metadata.Path] = cachedMetadata;
                }
                if (cachedMetadata.Hash != metadata.ContentHash) throw new IOException("INDEX_STALE: conflicting captured metadata hashes.");
                references.Add(cachedMetadata.Reference.WithProperties(MetadataReferenceProperties.Assembly
                    .WithAliases(metadata.Aliases ?? []).WithEmbedInteropTypes(metadata.EmbedInteropTypes)));
            }
            var dependencies = (project.References ?? []).Select(Build).ToArray();
            references.AddRange(dependencies.Select(x => x.Compilation.ToMetadataReference()));
            if (!Enum.TryParse<NullableContextOptions>(project.Nullable, ignoreCase: true, out var nullable)) throw new ArgumentException("Invalid nullable context option.");
            var outputKind = project.OutputKind.ToLowerInvariant() switch { "library" => OutputKind.DynamicallyLinkedLibrary, "exe" => OutputKind.ConsoleApplication, "winexe" => OutputKind.WindowsApplication, _ => throw new ArgumentException("Invalid output kind.") };
            var compilation = CSharpCompilation.Create(project.AssemblyName, trees, references,
                new CSharpCompilationOptions(outputKind, allowUnsafe: project.AllowUnsafe, nullableContextOptions: nullable));
            var syntaxOnly = manifest is null || key == "uncovered-syntax";
            var compilerDiagnostics = compilation.GetDiagnostics(cancellationToken);
            var resolution = syntaxOnly ? "syntaxOnly" : compilerDiagnostics.Any(d => d.Severity == DiagnosticSeverity.Error) ? "partial" : "complete";
            var hash = SourceFiles.Hash(Encoding.UTF8.GetBytes(AdapterVersion + System.Text.Json.JsonSerializer.Serialize(project)
                + string.Join("|", projectSources.Select(s => s.Hash)) + string.Join("|", dependencies.Select(d => d.Context.Hash))));
            var context = new IndexedContext(key, key == "syntax" || key == "uncovered-syntax" ? "" : key,
                Identity.Id("pci:ctx:", repositoryId, key), hash, resolution, projectSources);
            var input = new CompilationInput(project, context, compilation, compilerDiagnostics); inputs[key] = input; visiting.Remove(key); return input;
        }

        (string Id, string Json, bool External) Identify(ISymbol symbol, IndexedContext current, SyntaxNode? declaration)
        {
            symbol = (symbol is IMethodSymbol { ReducedFrom: not null } reduced ? reduced.ReducedFrom : symbol).OriginalDefinition;
            if (symbol is IMethodSymbol { PartialDefinitionPart: not null } method) symbol = method.PartialDefinitionPart;
            var localCallable = symbol is IMethodSymbol { MethodKind: MethodKind.LocalFunction or MethodKind.AnonymousFunction };
            if (!identities.TryGetValue(current.Id, out var contextIdentities))
                identities[current.Id] = contextIdentities = new(SymbolEqualityComparer.Default);
            if (!localCallable && contextIdentities.TryGetValue(symbol, out var cachedIdentity)) return cachedIdentity;
            var reference = symbol.DeclaringSyntaxReferences.FirstOrDefault();
            if (reference is null && symbol is IMethodSymbol { IsImplicitlyDeclared: true })
                reference = symbol.ContainingType?.DeclaringSyntaxReferences.FirstOrDefault();
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
            var result = ((syntax && !external ? "pci:syntactic:" : "pci:sym:") + SourceFiles.Hash(Encoding.UTF8.GetBytes(json))[7..], json, external);
            // Local callable descriptors depend on declaration ownership established
            // during traversal, so they deliberately bypass the symbol-only cache.
            if (!localCallable) contextIdentities[symbol] = result;
            return result;
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
