using Praxis.CodeIntelligence.Storage;

if (args is ["init", var path])
{
    new IndexDatabase(path).Initialize();
    Console.WriteLine("Index database initialized.");
    return 0;
}
if (args is ["doctor", var databasePath])
{
    var checks = new IndexDatabase(databasePath).Check();
    foreach (var check in checks) Console.WriteLine(check);
    return checks.Count == 0 ? 0 : 4;
}
Console.WriteLine("Reconstruction checkpoint: init <database-path> | doctor <database-path>");
return args.Length == 0 ? 0 : 2;
