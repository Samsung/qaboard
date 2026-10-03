import os

# Tests should not depend on the site package installed on the machine (e.g. qaboard-site-sirc's qaboard.yaml)
os.environ['QABOARD_SITE_CONFIG'] = ''
