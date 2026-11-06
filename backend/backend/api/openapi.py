"""
The API's description, where tools expect it:
- GET /api/v1/openapi.json: the OpenAPI document (backend/openapi.yaml, written by hand for now)
- GET /api/v1/docs/: Swagger UI, to browse it and try requests. Its files come with the flask-swagger-ui package,
  so it works without internet access; without the package, from a CDN.

Both are public, also when the server requires signing in (backend/actor.py: PUBLIC_ENDPOINTS): they describe the
API, not the data. The requests made from Swagger UI are authenticated like the web app's (the session cookie), or by
the token users paste in "Authorize". We don't keep that token in the browser's storage: the origin also serves the
users' HTML files.
"""
import copy
import json
import html
import functools
import mimetypes
from pathlib import Path

from flask import Response, jsonify, redirect, request, send_from_directory

from backend import app


SPEC_PATH = Path(__file__).resolve().parent.parent / 'openapi.yaml'
# When flask-swagger-ui isn't installed
SWAGGER_UI_CDN = 'https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.17.14'


@functools.lru_cache(maxsize=1)
def load_spec() -> dict:
  import yaml
  with SPEC_PATH.open(encoding='utf-8') as f:
    return yaml.safe_load(f)


def api_root() -> str:
  """The API's path, also behind a reverse proxy that serves QA-Board under a path prefix"""
  prefix = request.headers.get('X-Forwarded-Prefix', '').rstrip('/') + request.script_root.rstrip('/')
  return f"{prefix}/api/v1"


def spec_for_request() -> dict:
  spec = copy.deepcopy(load_spec())
  spec['servers'] = [{'url': api_root(), 'description': 'This server'}]
  return spec


@app.route('/api/v1/openapi.json')
def openapi_json():
  # not jsonify: it sorts the keys, and the order of the paths and fields is the order people read them in
  response = Response(json.dumps(spec_for_request()), mimetype='application/json')
  # it changes with each version of the server
  response.headers['Cache-Control'] = 'no-cache'
  return response


def swagger_ui_dist():
  """The folder of Swagger UI's files, or None"""
  try:
    import flask_swagger_ui
  except ImportError:
    return None
  dist = Path(flask_swagger_ui.__file__).resolve().parent / 'dist'
  return dist if (dist / 'swagger-ui-bundle.js').exists() else None


DOCS_PAGE = """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>QA-Board API</title>
  <link rel="stylesheet" href="{assets}/swagger-ui.css">
  <style>
    body {{ margin: 0; }}
    .qaboard-banner {{ font: 14px/1.5 sans-serif; padding: 10px 20px; background: #f6f7f9; border-bottom: 1px solid #dde1e6; }}
    .qaboard-banner a {{ color: #2d72d2; }}
  </style>
</head>
<body>
  <div class="qaboard-banner">
    Requests from this page use your QA-Board session if you're signed in. To use a token instead, click
    <b>Authorize</b>. <a href="{docs}">Guide and examples</a>
  </div>
  <div id="swagger-ui"></div>
  <script src="{assets}/swagger-ui-bundle.js"></script>
  <script>
    window.ui = SwaggerUIBundle({{
      url: "../openapi.json",
      dom_id: "#swagger-ui",
      deepLinking: true,
      // the session cookie of the web app, for the same origin
      withCredentials: true,
      persistAuthorization: false,
      displayRequestDuration: true,
      tryItOutEnabled: true,
      filter: true,
      defaultModelsExpandDepth: 0,
      docExpansion: "list",
    }});
  </script>
</body>
</html>
"""


@app.route('/api/v1/docs')
def api_docs_redirect():
  # relative: the page's links are relative to /docs/, also behind a path prefix
  return redirect('docs/', code=301)


@app.route('/api/v1/docs/')
@app.route('/api/v1/docs/<path:filename>')
def api_docs(filename=None):
  dist = swagger_ui_dist()
  if filename:
    if dist is None:
      return jsonify({"error": f"Not found: {filename}"}), 404
    response = send_from_directory(dist, filename, mimetype=mimetypes.guess_type(filename)[0])
    response.headers['Cache-Control'] = 'public, max-age=86400'
    return response
  assets = '.' if dist is not None else SWAGGER_UI_CDN
  # The docs this server serves match its version (web.docs_root, like the web app's links)
  from ..settings import setting
  docs = (setting('web.docs_root') or '/').rstrip('/') + '/docs/http-api'
  return Response(DOCS_PAGE.format(assets=assets, docs=html.escape(docs, quote=True)), mimetype='text/html')
