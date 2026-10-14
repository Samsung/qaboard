# The demo-data image (ghcr.io/<owner>/qaboard:demo-data): the docs' demo projects, restored into a QA-Board server
# by restore.sh, the first time it starts. Built by `docs-media/snapshot.py image` from a snapshot of the demo stack,
# which writes db.sql, results.tar, metadata.json and demo-data.txt next to this file (docs-media/README.md).
# On the image of the quickstarts' database: its layers are already there, and psql matches the server.
FROM postgres:16-alpine
# The data first: a new script alone doesn't change the big layer
COPY metadata.json demo-data.txt db.sql results.tar /demo/
COPY restore.sh /demo/restore.sh
ENTRYPOINT ["/demo/restore.sh"]
CMD []
