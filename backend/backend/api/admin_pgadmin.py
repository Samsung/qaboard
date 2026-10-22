"""
pgAdmin signs QA-Board's admins in: nginx asks this endpoint before proxying /pgadmin4/ (auth_request),
and passes the pgAdmin account it answers in a header that pgAdmin trusts (its "webserver" authentication).
See services/nginx/snippets/pgadmin.conf.
"""
import os

from flask import jsonify

from backend import app
from .auth import admin_required


@app.route('/api/v1/admin/pgadmin/authorize')
@admin_required
def authorize_pgadmin():
  """204 with the pgAdmin account in X-Pgadmin-User for admins, else 401 (sign in) or 403"""
  # All admins share pgAdmin's default account: it owns the preconfigured server (services/pgadmin/servers.json)
  account = os.getenv('QABOARD_PGADMIN_USER') or os.getenv('PGADMIN_DEFAULT_EMAIL')
  if not account:
    return jsonify({"error": "Signing in to pgAdmin with QA-Board isn't set up: set PGADMIN_DEFAULT_EMAIL for the backend."}), 404
  return '', 204, {'X-Pgadmin-User': account}
