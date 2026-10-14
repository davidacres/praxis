"""Validate actual tool samples against normative JSON Schema 2020-12 contracts.
Requires jsonschema 4.x; this is a verification dependency, not a service runtime dependency.
"""
import json
import sys
from pathlib import Path
from jsonschema import Draft202012Validator

contracts = json.loads((Path(__file__).resolve().parent.parent / 'contracts.json').read_text())
directory = Path(sys.argv[1])
seen = set()
count = 0
for path in sorted(directory.glob('*.json')):
    tool = path.name.split('-')[0]
    if tool not in contracts:
        raise RuntimeError(f'Unknown tool sample: {path.name}')
    schema = contracts[tool]['outputSchema']
    Draft202012Validator.check_schema(schema)
    errors = list(Draft202012Validator(schema).iter_errors(json.loads(path.read_text())))
    if errors:
        raise RuntimeError(f'{path.name}: {errors[0].message}')
    seen.add(tool)
    count += 1
missing = set(contracts) - seen
if missing:
    raise RuntimeError(f'Missing tool samples: {sorted(missing)}')
print(f'Validated {count} responses across {len(seen)} tools.')
