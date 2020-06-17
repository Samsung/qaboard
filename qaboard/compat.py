"""
Deprecation warnings, backward compatibility, Windows compatibility
"""
import os
import sys
import click
from pathlib import Path


def ensure_cli_backward_compatibility():
    """Handle deprecate flag names here"""
    renamings = (
        ('--input-path', '--input'),
        ('--output-path', '--output'),
        ('save_artifacts', 'save-artifacts'),
        ('check_bit_accuracy', 'check-bit-accuracy'),
        ('--reference-branch', '--reference'),
        ('--batch-label', '--label'),
        ('--inputs-database', '--database'),
        ('--inputs-globs', 'REMOVED: Use "inputs.types" in qaboard.yaml'),
        ('--save-manifests', '--save-manifests-in-database'),
        ('--return-prefix-outputs-path', '--list-output-dirs'),
        ('--ci', '--share'),
        ('--dry-run', '--dryrun'),
        ('--group', '--batch'),
        ('--groups-file', '--batches-file'),
        ('--no-qa-database', '--offline'),
    )
    def renamed_deprecated(arg):
        for before, after in renamings:
            if arg == before:
                click.secho(f'DEPRECATION WARNING: "{before}" was replaced by "{after}" and will be removed in a future release.', fg='yellow')
                return after
        return arg
    sys.argv = [renamed_deprecated(arg) for arg in sys.argv]
    if '--lsf-sequential' in sys.argv:
        click.secho('DEPRECATION WARNING: "--lsf-sequential" was replaced with "--runner local"', fg='yellow', bold=True)



def cased_path(path):
    # Adapted from
    # https://stackoverflow.com/questions/3692261/in-python-how-can-i-get-the-correctly-cased-path-for-a-file/14742779#14742779
    if os.name != 'nt':
      return path
    import glob
    dirs = str(path).split('\\')
    # For absolute paths with drive names ("\\host\volume\..."), we must have the correct case at least at the beginning...
    # Still, then, we could always call .upper() if the length of the first part is 1 (drive letter..)
    if not dirs[0] and not dirs[1]:
      dirs = [f'\\\\{dirs[2]}\\{dirs[3]}', *dirs[4:]]
      test_name = [dirs[0]]
    elif not dirs[0]: # absolute paths like "\c\Users\..."
      dirs = [f'\\{dirs[1]}', *dirs[3:]]
      test_name = [dirs[0]]      
    elif dirs[0].endswith(':'): # e.g. C:\\
      test_name = [dirs[0]]
    else: # relative paths
      test_name = ["%s[%s]" % (dirs[0][:-1], dirs[0][-1])]
    for d in dirs[1:]:
        test_name += ["%s[%s]" % (d[:-1], d[-1])]
    res = glob.glob('\\'.join(test_name))
    if not res: #File not found
        return None
    return Path(res[0])



def escaped_for_cli(string):
  # we assume single_quotes are already escaped
  if os.name == 'nt':
    string_escaped = string.replace('\\', '\\\\')
    string_escaped = string_escaped.replace('"', '\\"')
    string_escaped = string_escaped.replace('|', '^|')
    return f'"{string_escaped}"'
  else:
    return 

