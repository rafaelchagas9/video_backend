"""Package only approved numeric features for the private Colab CPU comparison."""
import gzip, hashlib, json, math, sys
from pathlib import Path
source=Path(sys.argv[1])
payload=json.loads(source.read_text())
allowed={'row','group','recording','y','base','audio','pilot','embedding'}
assert all(set(row)<=allowed for row in payload['rows'])
for row in payload['rows']:
    assert row['row'].startswith('x') and row['group'].startswith('g') and row['recording'].startswith('r')
    assert row['y'] in (0,1)
    assert len(row['base'])==2 and all(math.isfinite(x) for x in row['base'])
    if row['audio'] is not None:
        assert len(row['audio'])==4 and all(math.isfinite(x) for x in row['audio'])
    if 'embedding' in row:
        assert len(row['embedding'])==768 and all(math.isfinite(x) for x in row['embedding'])
package={'evaluator':Path(__file__).with_name('evaluate.py').read_text(),'payload':payload}
blob=gzip.compress(json.dumps(package,allow_nan=False).encode())
destination=source.parent/'colab_features_package.json.gz'
destination.write_bytes(blob);destination.chmod(0o600)
print(json.dumps({'bytes':len(blob),'sha256':hashlib.sha256(blob).hexdigest(),'rows':len(payload['rows']),
                  'embedding_rows':sum('embedding' in r for r in payload['rows']),'raw_media_included':False}))
