import os
import sys
from pathlib import Path

# Test this checkout, not a `qaboard` that is installed (e.g. the deployed CLI), also in subprocesses
root = str(Path(__file__).resolve().parent.parent)
sys.path.insert(0, root)
os.environ['PYTHONPATH'] = os.pathsep.join([root, *filter(None, [os.environ.get('PYTHONPATH')])])
