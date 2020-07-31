"""
Used this script to get a batch's total storage.

```
export QABOARD_HOST=http://localhost:5152
python get_batch_storage.py some/project commit_id [batch_label]
#=> batch_label: 240MB for 30 outputs
```
"""
import os
import sys
import json

import click
import requests
from qaboard.api import url_to_dir

qaboard_host = os.environ.get("QABOARD_HOST", "http://qa")

def fetch_batch(batch_id):
  r = requests.get(f"{qaboard_host}/api/v1/batch/{batch_id}/")
  print(r.text)
  return r.json()

def fetch_commit(hexsha, project):
  r = requests.get(
    f"{qaboard_host}/api/v1/commit/",
    params={
      "commit": hexsha,
      "project": project,
      "with_outputs": True,
    }
  )
  return r.json()



def used_storage(batch):
  total_size = 0
  for output in batch['outputs'].values():
      if output['is_pending']:
        continue
      output_storage = output.get('data', {}).get('storage', {})
      if output_storage:
        total_size += output_storage
        continue

      output_dir = url_to_dir(output['output_dir_url'])
      manifest_path = output_dir / 'manifest.outputs.json'
      print(output)
      with manifest_path.open() as f:
          manifest = json.load(f)
      sizes = [f['st_size'] for f in manifest.values()]
      total_size += sum(sizes)
  return total_size


if __name__ == "__main__":
    project = sys.argv[1]
    hexsha = sys.argv[2]
    batch_label = sys.argv[3] if len(sys.argv) > 3 else None
    # print(project, hexsha, batch_label)
    commit = fetch_commit(hexsha, project)
    # print(commit)

    for label, batch in commit['batches'].items():
      if batch_label and batch_label != label:
        continue
      storage = used_storage(batch)
      print(f"{label}: {storage / 1e6:.01f}MB for {len(batch['outputs'])} outputs")