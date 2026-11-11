"""Run every MVP unit suite and retain real commands, exits, logs and source hashes."""
from pathlib import Path
import datetime
import hashlib
import json
import os
import subprocess
import sys

root = Path(__file__).resolve().parent.parent
out = root / 'evidence/verification'
out.mkdir(parents=True, exist_ok=True)
env = dict(os.environ)
env.setdefault('GOMODCACHE', '/private/tmp/abstract-wallet-gomod')
env.setdefault('GOCACHE', '/private/tmp/abstract-wallet-gocache')
solc = env.get('SOLC_PATH', '/private/tmp/abstract-wallet-solc-0.8.28')
if not Path(solc).is_file():
    raise SystemExit('Set SOLC_PATH to the pinned Solidity 0.8.28 compiler before running all suites.')
suites = [
    ('contracts', ['forge', 'test', '--root', 'contracts', '--use', solc, '--offline', '-vv'], root),
    ('typescript', ['npm', 'test'], root),
    ('backend', ['go', 'test', '-count=1', '-race', '-json', './...'], root / 'services/sponsorship'),
    ('backend-vet', ['go', 'vet', './...'], root / 'services/sponsorship'),
    ('typecheck', ['npm', 'run', 'typecheck'], root),
    ('build', ['npm', 'run', 'build'], root),
]
report = {'startedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'git': 'absent; not initialized', 'kind': 'final_regression_not_tdd_red', 'suites': [], 'sourceSha256': {}}
for folder in ['contracts/src', 'contracts/test', 'packages/sdk/src', 'packages/sdk/test', 'apps/wallet/src', 'apps/wallet/test', 'services/bundler/src', 'services/bundler/test', 'services/sponsorship']:
    for f in (root / folder).rglob('*'):
        if f.is_file() and f.suffix in ['.go', '.ts', '.tsx', '.sol', '.json', '.css']:
            report['sourceSha256'][str(f.relative_to(root))] = hashlib.sha256(f.read_bytes()).hexdigest()
for name, command, cwd in suites:
    result = subprocess.run(command, cwd=cwd, env=env, capture_output=True, text=True)
    log = out / (name + '.log')
    log.write_text(result.stdout + result.stderr)
    item = {'name': name, 'command': command, 'cwd': str(cwd.relative_to(root)) or '.', 'exitCode': result.returncode, 'log': str(log.relative_to(root))}
    if name == 'backend':
        events = []
        for line in result.stdout.splitlines():
            try:
                event = json.loads(line)
                if event.get('Action') in ['pass', 'fail', 'skip'] and event.get('Test'):
                    events.append({'test': event['Test'], 'result': event['Action']})
            except ValueError:
                pass
        item['tests'] = events
    report['suites'].append(item)
    print(name, 'exit=' + str(result.returncode), flush=True)
    if result.returncode:
        print((result.stdout + result.stderr)[-5000:], flush=True)
report['completedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
report['status'] = 'passed' if all(s['exitCode'] == 0 for s in report['suites']) else 'failed'
(out / 'final.json').write_text(json.dumps(report, indent=2) + '\n')
sys.exit(0 if report['status'] == 'passed' else 1)
