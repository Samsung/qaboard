"""
Deprecation warnings, backward compatibility, Windows compatibility
"""
import sys
import click


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
