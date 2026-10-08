"""
Site-specific configuration via Python entry points.

Priority order (highest wins):
1. Environment variables
2. Installed site package defaults (e.g. qaboard-site-sirc)
3. Hardcoded open-source defaults

Site packages can also provide a base `qaboard.yaml` that all projects' configurations are merged on,
by pointing QABOARD_SITE_CONFIG to it (see `site_qaboard_config`).

Install a site package to auto-configure:
    # for SIRC 
    pip install --upgrade "qaboard-site-sirc @ git+ssh://git@gitlab-srv/common-infrastructure/qaboard#subdirectory=deployments/sirc/cli"    # SIRC defaults
    # for DSK (replace the repo URL with one you can access)
    pip install --upgrade "qaboard-site-dsk @ git+ssh://git@gitlab-srv/common-infrastructure/qaboard#subdirectory=deployments/dsk/cli"    # DSK defaults
"""
import os
import json
from pathlib import Path
from typing import Any, Dict, List, Optional

import yaml


def site_entry_points(group):
    """Installed entry points in a group, e.g. qaboard.site or qaboard.hooks."""
    try:
        from importlib.metadata import entry_points
    except ImportError: # python 3.7
        try:
            from importlib_metadata import entry_points # type: ignore
        except ImportError:
            return []
    eps = entry_points()
    if hasattr(eps, 'select'): # python>=3.10
        return eps.select(group=group)
    return eps.get(group, [])


def _load_site_defaults():
    """Discover and load site defaults from installed entry points."""
    defaults = {}
    try:
        eps = site_entry_points("qaboard.site")
        for ep in eps:
            site_module = ep.load()
            if isinstance(site_module, dict):
                defaults.update(site_module)
            elif hasattr(site_module, 'defaults'):
                defaults.update(site_module.defaults)
    except Exception:
        pass
    return defaults


_site_defaults = _load_site_defaults()


def _load_secrets(path, check_permissions=False):
  path = Path(path).expanduser()
  try:
    if not path.exists():
      return {}
    if not os.access(path, os.R_OK):
      return {}
    if check_permissions and os.name != 'nt' and path.stat().st_mode & 0o077:
      import sys
      print(f"WARNING: {path} contains secrets but is readable by other users. Run: chmod 600 {path}", file=sys.stderr)
    with path.open() as f:
      return yaml.load(f, Loader=yaml.SafeLoader) or {}
  except (OSError, yaml.YAMLError) as e:
    import sys
    print(f"WARNING: Could not read {path}: {e}", file=sys.stderr)
    return {}

# Shared secrets, e.g. for the CI service account
secrets_path = os.getenv('QA_SECRETS', _site_defaults.get("QA_SECRETS"))
secrets = _load_secrets(secrets_path) if secrets_path else {}
# Per-user secrets, e.g. a personal QA_TOKEN to use the API from scripts. They win over shared secrets.
user_secrets_path = os.getenv('QA_USER_SECRETS', '~/.qaboard/secrets.yaml')
user_secrets = _load_secrets(user_secrets_path, check_permissions=True)
secrets = {**secrets, **user_secrets}


def user_secret(key, default=None):
    """Get a personal secret: ENV > per-user secrets file. Never read from shared secrets."""
    return os.getenv(key, user_secrets.get(key, default))



def site_config(key, default=None):
    """Get a config value: ENV > secrets > site package > default."""
    return os.getenv(key, secrets.get(key, _site_defaults.get(key, default)))


def as_requests_verify(value):
    """
    Parses a setting like QABOARD_API_VERIFY into requests' `verify` argument:
    true/false, or the path to a CA bundle.
    """
    if value is None or isinstance(value, bool):
        return value is not False
    value = str(value).strip()
    if value.lower() in ('', '1', 'true', 'yes', 'on'):
        return True
    if value.lower() in ('0', 'false', 'no', 'off'):
        return False
    return value


# Locations can be specified as a path, {linux, windows}, {outputs, artifacts}...
# They are not merged key by key: when projects define them, they replace the site's.
LOCATION_KEYS = (('storage',), ('inputs', 'database'))


def site_qaboard_config_path() -> Optional[Path]:
    """
    Path to the site's base qaboard.yaml, if any. Set QABOARD_SITE_CONFIG="" to ignore the site's.
    Like other locations, it can depend on the platform, e.g. for a variable shared by Linux and Windows CI runners:
        QABOARD_SITE_CONFIG='{"linux": "/mnt/qaboard/site.yaml", "windows": "//server/qaboard/site.yaml"}'
    """
    from .conventions import location_from_spec
    spec = site_config('QABOARD_SITE_CONFIG')
    if isinstance(spec, str) and spec.lstrip().startswith('{'):
        try:
            spec = json.loads(spec)
        except json.JSONDecodeError as e:
            raise ValueError(f"QABOARD_SITE_CONFIG is not valid JSON: {e}") from e
    if not spec:
        return None
    return location_from_spec(spec).expanduser()


def site_qaboard_config() -> Dict[str, Any]:
    """The site's base qaboard.yaml: projects' qaboard.yaml are merged on top of it."""
    try:
        path = site_qaboard_config_path()
        if not path:
            return {}
        with path.open() as f:
            site_qaboard = yaml.load(f, Loader=yaml.SafeLoader) or {}
        if not isinstance(site_qaboard, dict):
            raise ValueError("expected a mapping at the top level")
    except (OSError, yaml.YAMLError, ValueError) as e:
        import click
        click.secho(f"ERROR: Could not read the site's base qaboard.yaml (QABOARD_SITE_CONFIG={site_config('QABOARD_SITE_CONFIG')}): {e}", fg='red', err=True)
        return {}
    # The project's identity can't have site-wide defaults
    for key in ('name', 'url'):
        (site_qaboard.get('project') or {}).pop(key, None)
    return site_qaboard


def without_locations_from(site: Dict[str, Any], configs: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Removes from the site config the locations that are defined by the projects' configs."""
    for *parents, key in LOCATION_KEYS:
        if not any(key in get_path(c, parents) for c in configs):
            continue
        get_path(site, parents).pop(key, None)
    return site


def get_path(d: Dict[str, Any], keys) -> Dict[str, Any]:
    """d[k1][k2]... or {} if it's not a mapping."""
    value: Any = d
    for k in keys:
        value = value.get(k) if isinstance(value, dict) else None
    return value if isinstance(value, dict) else {}
