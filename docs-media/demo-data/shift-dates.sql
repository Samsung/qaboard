-- Moves every date of the demo database by :demo_shift seconds, so that the snapshot's T0 (the demo's "now") becomes
-- the time of the restore: the demo commits look as recent to a new user as they were at T0.
-- restore.sh runs it with psql, right after db.sql, in the same transaction: only when it restores the database.
--   psql --single-transaction -v demo_shift=<seconds> -f shift-dates.sql
-- - Every timestamp column of every table, whatever the backend's models have (commits, batches, runs, milestones...).
-- - The dates the web app shows from JSON columns, in the same format:
--   batches.data: commands.*.command_created_at_datetime (`qa batch`), submissions.*.created_at (from the web app);
--   ci_commits.data: artifacts_deleted.at, artifacts_recreation.at and .done_at; projects.data: latest_output_datetime.
-- - Not what has dates in its text: paths (e.g. qa-batch-logs/<date>-<id>/), logs, configurations, metrics.
-- CI checks that the quickstarts' commits moved (.github/scripts/demo_data_e2e.py).

-- pg_dump's db.sql empties the search path
SET LOCAL search_path TO public;
SET LOCAL TimeZone TO 'UTC';

-- An ISO 8601 date and time moved by `shift`, written like it was (without a time zone: UTC, like the backend's).
-- Anything else is returned as it is.
CREATE FUNCTION pg_temp.qaboard_demo_shift_date(value text, shift interval) RETURNS text
LANGUAGE plpgsql STABLE AS $$
DECLARE
  parts text[] := regexp_match(value, '^\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d(:?\d\d)?)?$');
  moved timestamp;
BEGIN
  IF parts IS NULL THEN
    RETURN value;
  END IF;
  moved := CASE WHEN parts[2] IS NULL THEN value::timestamp ELSE value::timestamptz AT TIME ZONE 'UTC' END + shift;
  RETURN to_char(moved, 'YYYY-MM-DD"T"HH24:MI:SS')
    || CASE WHEN parts[1] IS NULL THEN '' ELSE to_char(moved, '.US') END
    || CASE WHEN parts[2] IS NULL THEN '' WHEN parts[2] = 'Z' THEN 'Z' ELSE '+00:00' END;
EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format OR invalid_parameter_value THEN
  RETURN value;  -- e.g. 2026-13-45T00:00:00
END $$;

-- An object with the dates in its `keys` moved. Anything else is returned as it is.
CREATE FUNCTION pg_temp.qaboard_demo_shift_keys(item jsonb, keys text[], shift interval) RETURNS jsonb
LANGUAGE plpgsql STABLE AS $$
DECLARE
  key text;
BEGIN
  IF jsonb_typeof(item) IS DISTINCT FROM 'object' THEN
    RETURN item;
  END IF;
  FOREACH key IN ARRAY keys LOOP
    IF jsonb_typeof(item -> key) = 'string' THEN
      item := jsonb_set(item, ARRAY[key], to_jsonb(pg_temp.qaboard_demo_shift_date(item ->> key, shift)));
    END IF;
  END LOOP;
  RETURN item;
END $$;

-- {id: item}, with the dates in each item's `keys` moved. Anything else is returned as it is.
CREATE FUNCTION pg_temp.qaboard_demo_shift_items(items jsonb, keys text[], shift interval) RETURNS jsonb
LANGUAGE plpgsql STABLE AS $$
BEGIN
  IF jsonb_typeof(items) IS DISTINCT FROM 'object' OR items = '{}'::jsonb THEN
    RETURN items;
  END IF;
  RETURN (SELECT jsonb_object_agg(key, pg_temp.qaboard_demo_shift_keys(value, keys, shift)) FROM jsonb_each(items));
END $$;

-- data, with the object under `field` changed by `shift_keys` or `shift_items`. Without that object, data as it is.
CREATE FUNCTION pg_temp.qaboard_demo_shift_field(data jsonb, field text, keys text[], items boolean, shift interval) RETURNS jsonb
LANGUAGE plpgsql STABLE AS $$
BEGIN
  IF jsonb_typeof(data -> field) IS DISTINCT FROM 'object' THEN
    RETURN data;
  END IF;
  RETURN jsonb_set(data, ARRAY[field], CASE
    WHEN items THEN pg_temp.qaboard_demo_shift_items(data -> field, keys, shift)
    ELSE pg_temp.qaboard_demo_shift_keys(data -> field, keys, shift)
  END);
END $$;

-- Every timestamp column: one UPDATE per table
CREATE FUNCTION pg_temp.qaboard_demo_shift_columns(shift interval) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  tbl record;
BEGIN
  FOR tbl IN
    SELECT c.table_name, string_agg(format('%1$I = %1$I + $1', c.column_name), ', ' ORDER BY c.column_name) AS assignments
    FROM information_schema.columns c
    JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE' AND c.is_generated = 'NEVER'
      AND c.data_type IN ('timestamp without time zone', 'timestamp with time zone')
    GROUP BY c.table_name
    ORDER BY c.table_name
  LOOP
    EXECUTE format('UPDATE public.%I SET %s', tbl.table_name, tbl.assignments) USING shift;
  END LOOP;
END $$;

-- The seconds-only interval doesn't depend on time zones (days would, around DST changes)
SELECT pg_temp.qaboard_demo_shift_columns(make_interval(secs => :demo_shift));

UPDATE batches SET data = pg_temp.qaboard_demo_shift_field(
    pg_temp.qaboard_demo_shift_field(data::jsonb, 'commands', '{command_created_at_datetime}', true, make_interval(secs => :demo_shift)),
    'submissions', '{created_at}', true, make_interval(secs => :demo_shift))
  WHERE jsonb_typeof(data::jsonb -> 'commands') = 'object' OR jsonb_typeof(data::jsonb -> 'submissions') = 'object';

UPDATE ci_commits SET data = pg_temp.qaboard_demo_shift_field(
    pg_temp.qaboard_demo_shift_field(data::jsonb, 'artifacts_deleted', '{at}', false, make_interval(secs => :demo_shift)),
    'artifacts_recreation', '{at,done_at}', false, make_interval(secs => :demo_shift))
  WHERE jsonb_typeof(data::jsonb -> 'artifacts_deleted') = 'object' OR jsonb_typeof(data::jsonb -> 'artifacts_recreation') = 'object';

UPDATE projects SET data = pg_temp.qaboard_demo_shift_keys(data::jsonb, '{latest_output_datetime}', make_interval(secs => :demo_shift))
  WHERE jsonb_typeof(data::jsonb -> 'latest_output_datetime') = 'string';

DROP FUNCTION pg_temp.qaboard_demo_shift_columns(interval), pg_temp.qaboard_demo_shift_field(jsonb, text, text[], boolean, interval),
  pg_temp.qaboard_demo_shift_items(jsonb, text[], interval), pg_temp.qaboard_demo_shift_keys(jsonb, text[], interval),
  pg_temp.qaboard_demo_shift_date(text, interval);
