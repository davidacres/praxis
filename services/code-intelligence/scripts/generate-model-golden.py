"""Generate independent baseline vectors; never imports service tokenizer/inference code.

Verification-only dependencies: tokenizers==0.21.4 onnxruntime==1.23.2 numpy==2.5.4.
Run with a checksum-verified provisioned model bundle and an output JSON path.
CPU-only ONNX, single thread. Review fixture diffs; do not regenerate to hide failures.
"""
import hashlib
import json
import sys
from pathlib import Path
import numpy as np
import onnxruntime as ort
import tokenizers
from tokenizers import BertWordPieceTokenizer

assert tokenizers.__version__ == '0.21.4'
assert ort.__version__ == '1.23.2'
assert np.__version__ == '2.5.4'
bundle, output = map(Path, sys.argv[1:])
manifest = json.loads((bundle / 'manifest.json').read_text())
for name, key in [('model.onnx', 'modelSha256'), ('vocab.txt', 'vocabSha256')]:
    assert hashlib.sha256((bundle / name).read_bytes()).hexdigest() == manifest[key]
tokenizer = BertWordPieceTokenizer(str(bundle / 'vocab.txt'), lowercase=True)
options = ort.SessionOptions()
options.intra_op_num_threads = options.inter_op_num_threads = 1
session = ort.InferenceSession(str(bundle / 'model.onnx'), options, providers=['CPUExecutionProvider'])
texts = ['', 'parse authentication token', 'Héllo, worlds! Café naïve résumé.',
         'namespace App { string ParseToken(string value) => value; }',
         '中文 日本語 한글 😀', 'line\r\nnext\tcolumn\u0000value',
         '[CLS] [SEP] [UNK] [PAD] [MASK]', 'authentication token parser ' * 400,
         'İstanbul Cafe\u0301 \ufffd hello', 'prefix 😀 suffix \U00020000 end']
cases = []
for index, text in enumerate(texts):
    encoded = tokenizer.encode(text, add_special_tokens=False)
    ids = encoded.ids
    chunks = [[101] + ids[offset:offset + 254] + [102] for offset in range(0, max(1, len(ids)), 254)][:4]
    def utf16(position):
        return len(text[:position].encode('utf-16-le')) // 2
    spans = []
    for chunk_index, chunk in enumerate(chunks):
        first = chunk_index * 254
        end = first + len(chunk) - 2
        spans.append({'start': utf16(encoded.offsets[first][0]) if end > first else 0,
                      'end': utf16(encoded.offsets[end - 1][1]) if end > first else 0,
                      'firstToken': first, 'endToken': end, 'truncated': len(ids) > 4 * 254})
    case = {'text': text, 'tokenChunks': chunks, 'chunkSpans': spans}
    if index in (0, 1, 2, 4):
        # A query embeds the manifest's query prefix + text, first chunk only.
        query_ids = tokenizer.encode(manifest['queryPrefix'] + text, add_special_tokens=False).ids
        tokens = np.array([[101] + query_ids[:254] + [102]], dtype=np.int64)
        hidden = session.run(None, {'input_ids': tokens, 'attention_mask': np.ones_like(tokens), 'token_type_ids': np.zeros_like(tokens)})[0]
        pooled = hidden[0, 0] if manifest['pooling'] == 'cls' else hidden.mean(axis=1)[0]
        vector = pooled / np.linalg.norm(pooled)
        case['queryVector'] = vector.tolist()
    cases.append(case)
data = {'version': 1, 'reference': {'tokenizers': tokenizers.__version__, 'onnxruntime': ort.__version__, 'numpy': np.__version__, 'provider': 'CPUExecutionProvider'},
        'modelId': manifest['modelId'], 'pooling': manifest['pooling'], 'queryPrefix': manifest['queryPrefix'],
        'modelSha256': manifest['modelSha256'], 'vocabSha256': manifest['vocabSha256'],
        'absoluteTolerance': 0.00001, 'minimumCosine': 0.99999, 'cases': cases}
output.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')
print(hashlib.sha256(output.read_bytes()).hexdigest(), output)
