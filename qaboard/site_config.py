"""
Site-specific configuration via Python entry points.

Priority order (highest wins):
1. Environment variables
2. Installed site package defaults (e.g. qaboard-site-sirc)
3. Hardcoded open-source defaults

Install a site package to auto-configure:
    # for SIRC 
    pip install --upgrade "qaboard-site-sirc @ git+ssh://git@gitlab-srv/common-infrastructure/qaboard#subdirectory=deployments/sirc/cli"    # SIRC defaults
    # for DSK (replace the repo URL with one you can access)
    pip install --upgrade "qaboard-site-dsk @ git+ssh://git@gitlab-srv/common-infrastructure/qaboard#subdirectory=deployments/dsk/cli"    # DSK defaults
"""
import os
from pathlib import Path
from importlib.metadata import entry_points

import yaml


def _load_site_defaults():
    """Discover and load site defaults from installed entry points."""
    defaults = {}
    try:
        eps = entry_points(group="qaboard.site")
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


secrets_path = os.getenv('QA_SECRETS', _site_defaults.get("QA_SECRETS"))
if secrets_path and Path(secrets_path).exists():
  with Path(secrets_path).open() as f:
    secrets = yaml.load(f, Loader=yaml.SafeLoader)
else:
  secrets = {}



def site_config(key, default=None):
    """Get a config value: ENV > secrets > site package > default."""
    return os.getenv(key, secrets.get(key, _site_defaults.get(key, default)))

