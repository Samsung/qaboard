"""
For backward-compatibility: once qaboard was imported as "import qatools"
Inspired by https://stackoverflow.com/a/24324577/5993501
"""
import sys
import qaboard

modules = [
    'qaboard',
    'qaboard.check_for_updates',
    'qaboard.config',
    'qaboard.utils',
    'qaboard.conventions',
    'qaboard.iterators',
    'qaboard.qa',
    'qaboard.lsf',
    'qaboard.api'
]
for m in modules:
    sys.modules[m.replace('qaboard', 'qatools')] = sys.modules[m]
