using System.Text;
using Praxis.CodeIntelligence.Indexing;

namespace Praxis.CodeIntelligence.Interop;

public enum ScipDescriptorKind
{
    Namespace,
    Type,
    Term,
    Method,
    Parameter,
    TypeParameter,
    Meta
}

public sealed record ScipDescriptor(string Name, ScipDescriptorKind Kind, string? Disambiguator = null);

public sealed record ScipSymbol(
    string Scheme,
    string PackageManager,
    string PackageName,
    string Version,
    IReadOnlyList<ScipDescriptor> Descriptors
);

/// <summary>
/// Source Code Intelligence Protocol (SCIP) symbol encoding, decoding, and mapping (CI-021 / TASK-461).
/// Specification: https://github.com/sourcegraph/scip/blob/main/scip.proto
/// </summary>
public static class ScipInterop
{
    public static string Format(ScipSymbol symbol)
    {
        var sb = new StringBuilder();
        sb.Append(EscapeSpace(symbol.Scheme)).Append(' ');
        sb.Append(EscapeSpace(symbol.PackageManager)).Append(' ');
        sb.Append(EscapeSpace(symbol.PackageName)).Append(' ');
        sb.Append(EscapeSpace(symbol.Version)).Append(' ');

        foreach (var desc in symbol.Descriptors)
        {
            var escapedName = EscapeDescriptorName(desc.Name);
            sb.Append(escapedName);
            switch (desc.Kind)
            {
                case ScipDescriptorKind.Namespace:
                    sb.Append('/');
                    break;
                case ScipDescriptorKind.Type:
                    sb.Append('#');
                    break;
                case ScipDescriptorKind.Term:
                    sb.Append('.');
                    break;
                case ScipDescriptorKind.Method:
                    sb.Append('(');
                    if (!string.IsNullOrEmpty(desc.Disambiguator)) sb.Append(desc.Disambiguator);
                    sb.Append(").");
                    break;
                case ScipDescriptorKind.Parameter:
                    sb.Append('(');
                    if (!string.IsNullOrEmpty(desc.Disambiguator)) sb.Append(desc.Disambiguator);
                    sb.Append(')');
                    break;
                case ScipDescriptorKind.TypeParameter:
                    sb.Append('[');
                    if (!string.IsNullOrEmpty(desc.Disambiguator)) sb.Append(desc.Disambiguator);
                    sb.Append(']');
                    break;
                case ScipDescriptorKind.Meta:
                    sb.Append(':');
                    break;
            }
        }

        return sb.ToString();
    }

    public static ScipSymbol Parse(string symbolString)
    {
        if (string.IsNullOrWhiteSpace(symbolString))
            throw new ArgumentException("SCIP symbol string cannot be blank.", nameof(symbolString));

        var parts = SplitPackageParts(symbolString);
        if (parts.Length < 4)
            throw new FormatException($"Invalid SCIP symbol header: '{symbolString}'. Expected scheme, package manager, package name, and version.");

        var scheme = parts[0];
        var packageManager = parts[1];
        var packageName = parts[2];
        var version = parts[3];
        var descriptorPart = parts.Length > 4 ? parts[4] : "";

        var descriptors = ParseDescriptors(descriptorPart);

        return new ScipSymbol(scheme, packageManager, packageName, version, descriptors);
    }

    public static ScipSymbol ToScipSymbol(IndexedSymbol symbol, string packageManager, string packageName, string version)
    {
        var scheme = symbol.ContextId.Contains("ts") || symbol.ContextId.Contains("js") ? "scip-typescript" : "scip-dotnet";
        var descriptors = new List<ScipDescriptor>();

        // Break qualified name into segments
        var qualifiedName = symbol.QualifiedName;
        var parts = qualifiedName.Split('.');
        for (var i = 0; i < parts.Length; i++)
        {
            var part = parts[i];
            if (i == parts.Length - 1)
            {
                // Last segment maps to symbol kind
                var kind = symbol.Kind switch
                {
                    "method" or "function" => ScipDescriptorKind.Method,
                    "class" or "interface" or "struct" or "enum" or "type" => ScipDescriptorKind.Type,
                    "property" or "field" or "constant" => ScipDescriptorKind.Term,
                    "namespace" => ScipDescriptorKind.Namespace,
                    _ => ScipDescriptorKind.Term
                };
                descriptors.Add(new ScipDescriptor(part, kind));
            }
            else
            {
                // Intermediate segments are namespaces or enclosing types
                descriptors.Add(new ScipDescriptor(part, ScipDescriptorKind.Namespace));
            }
        }

        return new ScipSymbol(scheme, packageManager, packageName, version, descriptors);
    }

    private static string[] SplitPackageParts(string str)
    {
        var result = new List<string>(5);
        var sb = new StringBuilder();
        var i = 0;
        while (i < str.Length && result.Count < 4)
        {
            if (str[i] == ' ')
            {
                result.Add(sb.ToString());
                sb.Clear();
                i++;
                continue;
            }
            sb.Append(str[i]);
            i++;
        }
        if (i < str.Length)
        {
            result.Add(str[i..]);
        }
        else if (sb.Length > 0)
        {
            result.Add(sb.ToString());
        }
        return result.ToArray();
    }

    private static IReadOnlyList<ScipDescriptor> ParseDescriptors(string descriptorPart)
    {
        var descriptors = new List<ScipDescriptor>();
        if (string.IsNullOrEmpty(descriptorPart)) return descriptors;

        var i = 0;
        while (i < descriptorPart.Length)
        {
            var nameSb = new StringBuilder();
            var isEscaped = false;
            while (i < descriptorPart.Length)
            {
                var ch = descriptorPart[i];
                if (ch == '`')
                {
                    isEscaped = !isEscaped;
                    i++;
                    continue;
                }
                if (!isEscaped && (ch == '/' || ch == '#' || ch == '.' || ch == '(' || ch == '[' || ch == ':'))
                {
                    break;
                }
                nameSb.Append(ch);
                i++;
            }

            if (i >= descriptorPart.Length)
            {
                if (nameSb.Length > 0)
                    descriptors.Add(new ScipDescriptor(nameSb.ToString(), ScipDescriptorKind.Term));
                break;
            }

            var delimiter = descriptorPart[i++];
            var name = nameSb.ToString();

            switch (delimiter)
            {
                case '/':
                    descriptors.Add(new ScipDescriptor(name, ScipDescriptorKind.Namespace));
                    break;
                case '#':
                    descriptors.Add(new ScipDescriptor(name, ScipDescriptorKind.Type));
                    break;
                case '.':
                    descriptors.Add(new ScipDescriptor(name, ScipDescriptorKind.Term));
                    break;
                case '(':
                    var paramSb = new StringBuilder();
                    while (i < descriptorPart.Length && descriptorPart[i] != ')')
                    {
                        paramSb.Append(descriptorPart[i++]);
                    }
                    if (i < descriptorPart.Length && descriptorPart[i] == ')') i++;
                    var isMethod = i < descriptorPart.Length && descriptorPart[i] == '.';
                    if (isMethod) i++;
                    descriptors.Add(new ScipDescriptor(name, isMethod ? ScipDescriptorKind.Method : ScipDescriptorKind.Parameter, paramSb.ToString()));
                    break;
                case '[':
                    var typeParamSb = new StringBuilder();
                    while (i < descriptorPart.Length && descriptorPart[i] != ']')
                    {
                        typeParamSb.Append(descriptorPart[i++]);
                    }
                    if (i < descriptorPart.Length && descriptorPart[i] == ']') i++;
                    descriptors.Add(new ScipDescriptor(name, ScipDescriptorKind.TypeParameter, typeParamSb.ToString()));
                    break;
                case ':':
                    descriptors.Add(new ScipDescriptor(name, ScipDescriptorKind.Meta));
                    break;
            }
        }

        return descriptors;
    }

    private static string EscapeSpace(string s) => s.Replace(" ", "\\ ");
    private static string EscapeDescriptorName(string name)
    {
        if (name.IndexOfAny(['/', '#', '.', '(', ')', '[', ']', ' ', '`']) >= 0)
            return "`" + name + "`";
        return name;
    }
}
