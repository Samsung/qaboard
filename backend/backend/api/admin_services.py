"""
Admin services that nginx serves next to QA-Board, for its admins only: Flower and pgAdmin.
Before proxying them, nginx asks these endpoints (auth_request): see services/nginx/snippets/qaboard-admins-only.conf
and services/nginx/snippets/pgadmin.conf.
"""
import os

from flask import jsonify

from backend import app
from .auth import admin_required


@app.route('/api/v1/admin/authorize')
@admin_required
def authorize_admin():
  """204 for admins, else 401 (sign in) or 403"""
  return '', 204


@app.route('/api/v1/admin/pgadmin/authorize')
@admin_required
def authorize_pgadmin():
  """
  204 with the pgAdmin account in X-Pgadmin-User for admins, else 401 (sign in) or 403.
  pgAdmin trusts the account nginx passes in this header (its "webserver" authentication).
  """
  # All admins share pgAdmin's default account: it owns the preconfigured server (services/pgadmin/servers.json)
  account = os.getenv('QABOARD_PGADMIN_USER') or os.getenv('PGADMIN_DEFAULT_EMAIL')
  if not account:
    return jsonify({"error": "Signing in to pgAdmin with QA-Board isn't set up: set PGADMIN_DEFAULT_EMAIL for the backend."}), 404
  return '', 204, {'X-Pgadmin-User': account}
