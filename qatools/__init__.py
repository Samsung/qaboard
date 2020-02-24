"""
For backward-compatibility: once qaboard was imported as "import qatools"
Inspired by https://stackoverflow.com/a/24324577/5993501
"""
# FIXME: for backward compatibility, maybe suffice to re-install the latest qatools @ispq, and in the docs/installation list both 
# pip install 'git+ssh://git@gitlab-srv/common-infrastructure/qatools@f2f993ea8'
import sys
import qaboard

modules = [
    # user only ever used config... 
    'qaboard',
    'qaboard.config',
    # 'qaboard.check_for_updates',
    # 'qaboard.utils',
    # 'qaboard.conventions',
    # 'qaboard.iterators',
    # 'qaboard.qa',
    # 'qaboard.lsf',
    # 'qaboard.api'
]
for m in modules:
    sys.modules[m.replace('qaboard', 'qatools')] = sys.modules[m]

