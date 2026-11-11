"""Load a local protected env file without echoing its secrets, then start Go API."""
import os
from pathlib import Path
import sys

root = Path(__file__).resolve().parent.parent
env_file = Path(sys.argv[1]) if len(sys.argv) > 1 else root / '.secrets/local-api.env'
for line in env_file.read_text().splitlines():
    if line and not line.startswith('#'):
        key, value = line.split('=', 1)
        os.environ[key] = value
os.environ.setdefault('GOMODCACHE', '/private/tmp/abstract-wallet-gomod')
os.environ.setdefault('GOCACHE', '/private/tmp/abstract-wallet-gocache')
os.chdir(root / 'services/sponsorship')
os.execvp('go', ['go', 'run', './cmd/server'])
