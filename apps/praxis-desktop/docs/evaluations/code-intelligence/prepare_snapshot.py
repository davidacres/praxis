"""Back up an existing index and matching source; never start its background owner."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import sqlite3
import subprocess
import platform
from xml.sax.saxutils import escape


def digest(path):
    return hashlib.file_digest(path.open('rb'), 'sha256').hexdigest()


def prepare(source, live_data, build, destination, transport):
    # Refusing existing destinations prevents accidental reuse or replacement.
    destination.mkdir()
    data = destination / 'data'
    data.mkdir()
    fixture = destination / 'source'
    fixture.mkdir()
    origin = sqlite3.connect((live_data / 'index.db').as_uri() + '?mode=ro', uri=True)
    database = sqlite3.connect(data / 'index.db')
    origin.backup(database)
    origin.close()
    repos = database.execute('SELECT repository_id,canonical_root,structural_generation,query_epoch FROM repositories').fetchall()
    matches = [row for row in repos if Path(row[1]).resolve() == source]
    if len(matches) != 1:
        raise ValueError('Expected exactly one registered source root')
    repository, original_root, generation, epoch = matches[0]
    files = database.execute('SELECT relative_path,observed_hash FROM files WHERE repository_id=? ORDER BY relative_path', (repository,)).fetchall()
    manifest = []
    for name, expected in files:
        relative = Path(name)
        if relative.is_absolute() or '..' in relative.parts:
            raise ValueError('Unsafe indexed path: ' + name)
        current = source / relative
        if 'sha256:' + digest(current) != expected:
            raise ValueError('Indexed source changed: ' + name)
        target = fixture / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(current, target)
        if 'sha256:' + digest(target) != expected:
            raise ValueError('Source changed during copy: ' + name)
        manifest.append({'path': name, 'sha256': expected})
    # Only the private backup is relocated. Symbol identities, vectors, documents,
    # compiler facts, ranking candidates and snapshot numbers remain unchanged.
    database.execute('UPDATE repositories SET canonical_root=? WHERE repository_id=?', (str(fixture), repository))
    database.commit()
    assert database.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
    database.close()
    shutil.copytree(live_data / 'models', data / 'models')
    runner = destination / 'transport'
    runner.mkdir()
    shutil.copy2(transport, runner / 'Program.cs')
    project = '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net10.0</TargetFramework><Nullable>enable</Nullable></PropertyGroup><ItemGroup>'
    for dll in sorted(build.glob('*.dll')):
        project += f'<Reference Include="{escape(dll.stem)}"><HintPath>{escape(str(dll))}</HintPath><Private>true</Private></Reference>'
    project += f'<Content Include="{escape(str(build))}/runtimes/**/*"><Link>runtimes/%(RecursiveDir)%(Filename)%(Extension)</Link><CopyToOutputDirectory>PreserveNewest</CopyToOutputDirectory></Content>'
    project += '</ItemGroup></Project>'
    (runner / 'Transport.csproj').write_text(project)
    subprocess.run(['dotnet', 'build', str(runner / 'Transport.csproj'), '--ignore-failed-sources', '-v', 'quiet'], check=True)
    # Assembly references do not carry NuGet's native runtime asset metadata.
    # Put the current host's unmodified native libraries beside the transport.
    rid = {'Darwin': 'osx', 'Linux': 'linux', 'Windows': 'win'}[platform.system()]
    arch = 'arm64' if platform.machine().lower() in ('arm64', 'aarch64') else 'x64'
    for native in (build / 'runtimes' / f'{rid}-{arch}' / 'native').glob('*'):
        if native.is_file(): shutil.copy2(native, runner / 'bin/Debug/net10.0' / native.name)
    metadata = dict(repositoryId=repository,originalRoot=original_root,fixtureRoot=str(fixture),
        database=str(data/'index.db'),models=str(data/'models'),indexGeneration=generation,queryEpoch=epoch,
        assemblySha256=digest(build/'Praxis.CodeIntelligence.dll'),
        serviceAssembly=str(build/'Praxis.CodeIntelligence.dll'),transportSha256=digest(transport),
        runtimeAssets={f.name:digest(f) for f in (runner/'bin/Debug/net10.0').iterdir() if f.suffix in ('.dll','.dylib','.so')},
        transport=str(runner/'bin/Debug/net10.0/Transport.dll'),sourceFiles=manifest,
        sourceManifestSha256=hashlib.sha256(json.dumps(manifest,sort_keys=True).encode()).hexdigest(),
        databaseSha256=digest(data/'index.db'),method='SQLite online backup, verified source copy, production QueryService without scheduler')
    (destination/'snapshot.praxis.json').write_text(json.dumps(metadata,indent=2)+'\n')
    print(json.dumps({k:v for k,v in metadata.items() if k!='sourceFiles'},indent=2))


if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source',type=Path,required=True)
    parser.add_argument('--live-data',type=Path,required=True)
    parser.add_argument('--build',type=Path,required=True)
    parser.add_argument('--destination',type=Path,required=True)
    args=parser.parse_args()
    prepare(args.source.resolve(),args.live_data.resolve(),args.build.resolve(),args.destination.resolve(),Path(__file__).parent/'transport/Program.cs')
