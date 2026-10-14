"""Explicit model provisioning only. Runtime queries never download assets."""
import hashlib
import shutil
import sys
import urllib.request
from pathlib import Path

destination = Path(sys.argv[1]); destination.mkdir(parents=True, exist_ok=True)
revision = '1110a243fdf4706b3f48f1d95db1a4f5529b4d41'
assets = [
    ('onnx/model.onnx', 'model.onnx', '6fd5d72fe4589f189f8ebc006442dbb529bb7ce38f8082112682524616046452', 90405214),
    ('vocab.txt', 'vocab.txt', '07eced375cec144d27c900241f3e339478dec958f92fddbc551f295c992038a3', 231508)
]
for remote, name, checksum, size in assets:
    path = destination / name
    if path.exists() and path.stat().st_size == size and hashlib.sha256(path.read_bytes()).hexdigest() == checksum:
        continue
    temporary = path.with_suffix(path.suffix + '.partial')
    try:
        digest = hashlib.sha256(); count = 0
        with urllib.request.urlopen(f'https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/{revision}/{remote}', timeout=60) as response, temporary.open('wb') as output:
            while chunk := response.read(1024 * 1024):
                count += len(chunk)
                if count > size: raise RuntimeError(f'{name}: exceeds pinned size')
                digest.update(chunk); output.write(chunk)
        if count != size or digest.hexdigest() != checksum: raise RuntimeError(f'{name}: pinned checksum/size mismatch')
        temporary.replace(path)
    finally: temporary.unlink(missing_ok=True)
shutil.copyfile(Path(__file__).resolve().parent.parent / 'models/minilm-manifest.json', destination / 'manifest.json')
print('Pinned assets provisioned; install validates local inference before activation.')
