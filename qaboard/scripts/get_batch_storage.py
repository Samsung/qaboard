"""
Used this script to get a batch's total storage.

```
export QABOARD_URL=http://localhost:5152  # else the server qa uses
python get_batch_storage.py some/project commit_id [batch_label]
#=> batch_label: 240MB for 30 outputs
```
"""
import os
import sys
import json

from qaboard.api import url_to_dir


def server() -> str:
  # QABOARD_HOST was this script's variable, with a URL
  if os.environ.get("QABOARD_HOST", "").startswith(("http://", "https://")):
    return os.environ["QABOARD_HOST"]
  from qaboard.credentials import default_server
  return default_server()[0]


def fetch_commit(hexsha, project):
  # with timeouts, retries, and the token qa is signed in with
  from qaboard.http_client import request_json, RETRY_DELAYS
  return request_json(server(), "commit/", params={
    "commit": hexsha,
    "project": project,
    "with_outputs": True,
  }, retries=RETRY_DELAYS)



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
