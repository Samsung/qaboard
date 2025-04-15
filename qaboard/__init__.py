# need to be update setup.py as well
__version__ = '1.0.2'
import os
if os.environ.get("CI"):
    import urllib3
    urllib3.disable_warnings()
    import sentry_sdk
    class InsecureHttpTransport(sentry_sdk.transport.HttpTransport):
        def _get_pool_options(self):
            options = super()._get_pool_options()
            options["cert_reqs"] = "CERT_NONE" # Ignore SSL Errors
            return options
    sentry_sdk.init(
        dsn="https://09ed52c49322629052df6b6e6cf334c5@sentry.transchip.com/30",
        transport=InsecureHttpTransport,
        # Set traces_sample_rate to 1.0 to capture 100%
        # of transactions for tracing.
        traces_sample_rate=1.0,
    )

from .check_for_updates import check_for_updates
check_for_updates()

from .config import on_windows, on_linux, on_lsf, on_vdi, is_ci, config
from .utils import merge
from .conventions import slugify
from .qa import qa
