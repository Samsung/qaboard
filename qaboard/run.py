import json
from pathlib import Path
from dataclasses import dataclass, field, asdict
from typing import List, Dict, Optional, Union, Any

import click

from .conventions import serialize_config


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
        return self.input_path.relative_to(self.database)

    @property
    def output_directory(self):
        return self.output_dir

    def asdict(self):
      return asdict(self)


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


    # For backward compatibility
    @property
    def obj(self):
        return {
            **asdict(self),
            "output_directory": self.output_dir, 
            "input_path": self.rel_input_path,
            "absolute_input_path": self.input_path,
            "configuration": serialize_config(self.configurations),
            # TODO: If we do the change above, we need something like...
            # "configurations": self.configurations[:-1] if self.tuning else self.configurations,
            # "extra_parameters": self.configurations[-1] if self.tuning else {}
        }
