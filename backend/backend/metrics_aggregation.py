"""
Per-batch aggregates of the runs' metrics, e.g. for the chart above a branch's commits and the tuning views.

The web app asks for some metrics (the `metrics` query parameter, {metric: target}), and gets for each batch
`{metric}_median`, `{metric}_average` and `{metric}_sum`, computed by PostgreSQL with one grouped query over all the batches.
"""
import json
import math
from typing import Dict, Iterable, List, Tuple


def parse_metrics_arg(value):
  """The `metrics` query parameter, JSON. Raises ValueError if it isn't."""
  if not value:
    return {}
  try:
    return json.loads(value)
  except ValueError as e:
    raise ValueError(f"`metrics` must be JSON, e.g. {{\"psnr\": 30}}: {e}")


def metric_names(metrics) -> List[str]:
  """The metrics asked for: the keys of {metric: target} (or a list of names), strings only, without duplicates"""
  if isinstance(metrics, dict):
    names = metrics.keys()
  elif isinstance(metrics, (list, tuple)):
    names = metrics
  else:
    return []
  return list(dict.fromkeys(m for m in names if isinstance(m, str) and m))


def aggregation_query(metrics: List[str]) -> Tuple[str, Dict]:
  """
  The SQL (with :named parameters) giving, per batch in :batch_ids, the median, average and sum of each metric.
  Only the valid runs count: not failed, not pending, not deleted. Values that are null, missing or not
  numbers (strings, booleans, objects...) are ignored. A metric without any value gives NULLs.
  """
  values, aggregates, params = [], [], {}
  for index, metric in enumerate(metrics):
    params[f'metric_{index}'] = metric
    # metrics is a json column; ::json also accepts a jsonb one
    values.append(
      f"CASE WHEN json_typeof(metrics::json -> :metric_{index}) = 'number' "
      f"THEN (metrics::json ->> :metric_{index})::float8 END AS value_{index}"
    )
    aggregates.append(
      f"percentile_cont(0.5) WITHIN GROUP (ORDER BY value_{index}) AS median_{index}, "
      f"avg(value_{index}) AS average_{index}, "
      f"sum(value_{index}) AS sum_{index}"
    )
  sql = (
    f"SELECT batch_id, {', '.join(aggregates)} "
    f"FROM ("
    f"SELECT batch_id, {', '.join(values)} "
    f"FROM outputs "
    f"WHERE batch_id = ANY(:batch_ids) "
    f"AND is_failed IS NOT TRUE AND is_pending IS NOT TRUE AND deleted IS NOT TRUE"
    f") AS runs "
    f"GROUP BY batch_id"
  )
  return sql, params


def is_number(value) -> bool:
  return value is not None and not (isinstance(value, float) and math.isnan(value))


def aggregates_from_rows(rows, metrics: List[str]) -> Dict[int, Dict[str, float]]:
  """{batch_id: {'{metric}_median': ..., '{metric}_average': ..., '{metric}_sum': ...}} from the query's rows, without missing values"""
  aggregated = {}
  for row in rows:
    batch_id, numbers = row[0], row[1:]
    batch = {}
    for index, metric in enumerate(metrics):
      median, average, total = numbers[3 * index:3 * index + 3]
      if is_number(median):
        batch[f'{metric}_median'] = float(median)
      if is_number(average):
        batch[f'{metric}_average'] = float(average)
      if is_number(total):
        batch[f'{metric}_sum'] = float(total)
    aggregated[batch_id] = batch
  return aggregated


def aggregated_metrics(session, batch_ids: Iterable[int], metrics) -> Dict[int, Dict[str, float]]:
  """
  {batch_id: {'{metric}_median': ..., '{metric}_average': ..., '{metric}_sum': ...}} for each batch, with one query.
  Batches without any value for the metrics get {}. Without metrics or batches, nothing is queried.
  """
  names = metric_names(metrics)
  batch_ids = list(dict.fromkeys(batch_ids))
  if not names or not batch_ids:
    return {batch_id: {} for batch_id in batch_ids}
  from sqlalchemy import text
  sql, params = aggregation_query(names)
  rows = session.execute(text(sql), {**params, 'batch_ids': batch_ids}).fetchall()
  aggregated = aggregates_from_rows(rows, names)
  return {batch_id: aggregated.get(batch_id, {}) for batch_id in batch_ids}
