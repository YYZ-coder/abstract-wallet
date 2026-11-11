"""Install only the official, content-pinned EntryPoint v0.9.0 source archive."""
import hashlib
import io
import json
from pathlib import Path
import tarfile
import urllib.request

root = Path(__file__).resolve().parent.parent
lock = json.loads((root / 'deployments/entrypoint-source-lock.json').read_text())
target = root / '.deps/account-abstraction'
if not all((target / file).is_file() and hashlib.sha256((target / file).read_bytes()).hexdigest() == digest for file, digest in lock['files'].items()):
    req = urllib.request.Request(lock['source'], headers={'User-Agent': 'Mozilla/5.0'})
    archive = urllib.request.urlopen(req, timeout=60).read()
    if hashlib.sha256(archive).hexdigest() != lock['archiveSha256']:
        raise SystemExit('Official source archive hash mismatch')
    with tarfile.open(fileobj=io.BytesIO(archive), mode='r:gz') as tar:
        for member in tar.getmembers():
            relative = Path(*Path(member.name).parts[1:])
            name = str(relative)
            if name in lock['files'] and member.isfile():
                dest = target / relative
                dest.parent.mkdir(parents=True, exist_ok=True)
                dest.write_bytes(tar.extractfile(member).read())
for file, digest in lock['files'].items():
    if hashlib.sha256((target / file).read_bytes()).hexdigest() != digest:
        raise SystemExit('Source hash mismatch: ' + file)
print('Verified official EntryPoint v0.9.0 sources:', len(lock['files']), 'files')
