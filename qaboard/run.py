import json
from pathlib import Path
from dataclasses import dataclass, field, asdict
from typing import List, Dict, Optional, Union, Any

import click

from .conventions import serialize_config, slugify_hash
from .utils import merge, input_metadata


@dataclass
class RunContext():
    """
    All the information describing a single `qa run`.
    It will be passed to the user's run(context) function. 
    """
    type: str
    input_path: Path             # absolute path to the input
    database: Path               # path to the database

    platform: str               # defaults to linux/windows

    configurations: List[Any]   # list of "configurations", meaning is user-defined 
    extra_parameters: Dict[str, Any] = field(default_factory=dict)  # used for tuning

    input_metadata: Dict = field(default_factory=dict)
    click_context: Optional[click.Context] = None

    # If we're in a batch, how we want the job to be executed by an async job runner
    # TODO: At some point we may prefer to give users tuning parameters via "configurations" only,
    #       to make the API easier... then we'd introduce something like this
    # has_tuning: Bool       # whether the run was provided tuning parameters
    #       Then we'd need to introduce has_tuning as a database field, and change how the frontend displays results
    #       > Or IMHO it's simpler to stay backward compatible and restore configurations/extra_params in api.py...
    job_options: Dict[str, Any] = field(default_factory=dict)   # TODO: use a "JobOptions"?

    # Where to save results
    output_dir: Path = Path()

    # How the run is translated into a command to be executed
    command: Optional[str] = None
    # command: Optional[Union[str, List[str]]] = None  # maybe at some point?

    @property
    def rel_input_path(self):
        """Returns the input's relative path from the database"""
        if self.database:
            return self.input_path.relative_to(self.database)
        else:
            return self.input_path.relative_to(self.database)

    @property
    def output_directory(self):
        return self.output_dir

    def asdict(self):
      self_dict = asdict(self)
      # this method is used for qa batch --list, before we can any idea about those members,
      # so they'll all be empty because uniniialized.. better not show them
      del self_dict['input_metadata']
      del self_dict['click_context']
      self_dict['rel_input_path'] = self.rel_input_path
      return self_dict



    def ran(self):
        return (self.output_dir / 'metrics.json').exists()

    def is_failed(self, verbose=False):
      metrics_path = self.output_dir / 'metrics.json'
      if metrics_path.exists():
          with metrics_path.open() as f:
            is_failed = json.load(f).get('is_failed', True)
            if verbose and is_failed:
                click.secho(f"ERROR: Failed run! More info at: {self.output_directory}/log.txt", fg='red', err=True)
            return is_failed
      else:
          if verbose:
              click.secho(f'ERROR: Failed run! Could not find {metrics_path}', fg='red', err=True)
          return True

    @staticmethod
    def from_click_run_context(ctx, config):
        if ctx.params['input_path'].is_absolute():
            database_str, *input_path_parts = ctx.params['input_path'].parts
            database = Path(database_str)
            input_path = Path(*input_path_parts)
            ctx.obj["database"] = database
        else:
            database = ctx.obj['database']
            input_path = ctx.params['input_path']
        if not database.is_absolute():
            database = database.resolve()
            # we don't want the absolute path to make its way to the QA-Board database
            # so we don't update obj later on.
        input_path_absolute = (database / input_path).resolve()
        if not input_path_absolute.exists():
            click.secho(f"[ERROR] {input_path_absolute} cannot be found", fg='red')
            exit(1)

        if not ctx.params.get('output_path'):
            assert input_path_absolute.relative_to(database)
            input_dir = input_path.with_suffix('')
            if len(input_dir.as_posix()) > 90:
                input_dir = Path(slugify_hash(input_dir.as_posix(), maxlength=90))
            output_dir = ctx.obj['batch_conf_dir'] / input_dir
            # we don't want people using ../ in the input causing issues 
            assert output_dir.resolve().relative_to(ctx.obj['batch_conf_dir'].resolve())
        else:
            output_dir = ctx.params.get('output_path')

        # Forwarded CLI arguments, e.g.: qa run -i image.jpg --args-for-wrapped-code
        extra_parameters = {}
        if ctx.params.get('forwarded_args'):
            extra_parameters["forwarded_args"] = ctx.params["forwarded_args"]
        extra_parameters.update(ctx.obj["extra_parameters"])
        ctx.obj["extra_parameters"] = extra_parameters
        run_context = RunContext(
            input_path=input_path_absolute,
            database=database,
            input_metadata=input_metadata(input_path_absolute, database, input_path, config),
            configurations=ctx.obj["configurations"],
            extra_parameters=extra_parameters,
            platform=ctx.obj["platform"],
            output_dir=output_dir,
            type=ctx.obj['input_type'],
            click_context=ctx,
        )

        # for backward compatibilty we need obj to behave nicely as the run_context...
        # it's also what we send to the API for now...
        ctx.obj["output_directory"] = run_context.output_dir
        ctx.obj["input_metadata"] = run_context.input_metadata
        ctx.obj["absolute_input_path"] = run_context.input_path
        ctx.obj["input_path"] = run_context.rel_input_path
        return run_context

    @property
    def dryrun(self):
        return self.click_context.obj['dryrun']

    @property
    def forwarded_args(self):
        return self.params.get("forwarded_args", [])


    @property
    def configs(self):
        _extra_parameters = self.extra_parameters
        if _extra_parameters:
            return [*self.configurations, self.extra_parameters]
        else:
            return self.configurations

    @property
    def params(self):
        # TODO: cache it in sef._parameters? but needs to ensure sync..
        parameters = {}
        for c in self.configs:
            if isinstance(c, dict):
                parameters = merge(c, parameters)
        return parameters

    # For backward compatibility and creative use to pass data around...
    @property
    def obj(self):
        # for now we use .obj to send data to the API
        # to ensure users can edit the metadata in run() and see it reflected...
        if self.click_context:
            self.click_context.obj['input_metadata'] = self.input_metadata
            return self.click_context.obj
        else:
            return {
                **self.asdict(),
                "rel_input_path": self.rel_input_path,
                # the API expects it to be relative for now... let's fix this when possible
                "input_path": self.rel_input_path,
                # backward compatibility with
                "output_directory": self.output_dir,
                "forwarded_args": self.forwarded_args,
                # backward compatibility with very old projects
                "configuration": serialize_config(self.configurations),
            }
