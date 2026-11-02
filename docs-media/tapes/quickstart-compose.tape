# user: ines
# passenv: QABOARD_IMAGE QABOARD_VERSION
# alt: A terminal starts QA-Board with docker compose up: the database, the demo data, the backend, the image server and the web server start and turn healthy. The health check answers ok, and the projects API lists the Kitefin demo projects with their number of commits.
# caption: docker compose up waits until every service is healthy, then QA-Board answers on localhost:5151 with the demo projects.
# poster: last
# dedupe_mask: 0,122,1280,310
# dedupe_tolerance: 0.002
#
# quickstart/compose (docs-media/shots.yaml). Recorded by: uv run docs-media/tapes/record.py --only quickstart/compose
# The Docker Compose quickstart (website/docs/get-started/quickstart.mdx) from a clean state, with
# deployments/quickstart/compose.yml in an empty folder (the page downloads it with curl).
# - It answers on port 5151, the demo stack's: stop the demo stack first (docs-media.yml records it last, once the
#   demo stack is stopped). Its Compose project is qaboard-quickstart (COMPOSE_PROJECT_NAME), deleted at the end.
# - The images are this checkout's, QABOARD_IMAGE and QABOARD_VERSION (passenv), with the demo-data image built from
#   the snapshot (`snapshot.py image --tag $QABOARD_IMAGE:demo-data-$QABOARD_VERSION`, docs-media.yml's "Demo-data
#   image" step). Missing images (PostgreSQL, Redis) are pulled before it starts, out of the video.
# - Compose lists the volumes and containers in a different order every time, with how long each took: dedupe_mask
#   hides that list from publish.py's comparison (the 13 lines under "docker compose up").
# The dedupe tolerance: VHS types in real time, a character can show a frame later (up to 0.1% of a frame here).
Source "tapes/_settings.tape"
Output out/quickstart/compose/tape.mp4
Output out/quickstart/compose/tape.webm

Hide
Type "mkdir -p ~/qaboard && cp ../deployments/quickstart/compose.yml ~/qaboard/ && cd ~/qaboard && export COMPOSE_PROJECT_NAME=qaboard-quickstart"
Enter
Type "docker compose down --volumes > /dev/null 2>&1; docker compose pull --quiet --policy missing && clear"
Enter
Wait@600s /\$$/
Show

Sleep 800ms
Type "# the quickstart's compose.yml, in an empty folder"
Enter
Type "mkdir -p /tmp/qaboard"
Enter
Type "docker compose up -d --wait"
Sleep 700ms
Enter
# The demo data restores, then the backend starts: about a minute, cut
Hide
Wait@600s /\$$/
Show
Sleep 2500ms
Type "curl -s localhost:5151/api/v1/health"
Enter
Sleep 1500ms
Type "curl -s localhost:5151/api/v1/projects | jq 'map_values(.total_commits)'"
Enter
Sleep 2500ms
Type "# open http://localhost:5151"
Enter
Sleep 3s

Hide
Type "docker compose down --volumes > /dev/null 2>&1; clear"
Enter
Wait@300s /\$$/
