#!/usr/bin/env bash
# A demo-data image for CI's quickstart tests (ci.yaml: quickstart, helm-e2e), from the seeder's test story
# (docs-media/tests/fixture) instead of the docs' demo snapshot, which is in a private bucket: the same steps as
# .github/workflows/docs-media.yml, a few minutes instead of an hour, and they test the seeder too.
#   .github/scripts/demo_data_fixture.sh ghcr.io/<owner>/qaboard:demo-data-<version>
# Runs the demo stack (docs-media/compose.demo.yml) with $QABOARD_IMAGE:<service>-$QABOARD_VERSION, on port 5151,
# with its results in /mnt/qaboard, then stops it.
set -euo pipefail
tag=$1
cd "$(dirname "$0")/../.."

uv run docs-media/seed.py --story docs-media/tests/fixture/story.yaml --fresh --quiet
uv run docs-media/snapshot.py save --no-upload --key ci-fixture --level 3
uv run docs-media/seed.py down --volumes
uv run docs-media/snapshot.py image --key ci-fixture --tag "$tag"
