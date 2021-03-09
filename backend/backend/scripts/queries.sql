drop view storage;
create view storage as
 SELECT outputs.id,
    ((outputs.data ->> 'storage'::text)::double precision) / 1000::double precision / 1000::double precision / 1000::double precision AS total_storage_gb,
    (outputs.data->>'user')::text as username,
    outputs.created_date,
    outputs.deleted,
    batches.id AS batch_id,
    batches.label AS batch_label,
    ci_commits.hexsha,
    ci_commits.branch,
    ci_commits.committer_name,
    projects.id AS project
   FROM outputs
     JOIN batches ON batches.id = outputs.batch_id
     JOIN ci_commits ON ci_commits.id = batches.ci_commit_id
     JOIN projects ON projects.id::text = ci_commits.project_id::text
  WHERE NOT (outputs.data ->> 'storage'::text) IS NULL;

-- WIP per batch
select
 batches.id as id, 
 (sum(outputs.data->>'storage')::bigint) / 1000 / 1000 / 1000 as total_storage_gb,
 count(*) as nb_outputs,
 ci_commits.hexsha, batches.label, projects.id, ci_commits.branch
from outputs
  inner join batches    on batches.id    = outputs.batch_id
  inner join ci_commits on ci_commits.id = batches.ci_commit_id
  inner join projects   on projects.id   = ci_commits.project_id
where
  outputs.created_date > current_date - 31
group by (outputs.batch_id, ci_commits.hexsha, ci_commits.branch, batches.label, batches.id, projects.id)
ORDER BY storage_GB DESC NULLS LAST;


-- per project
select
 (sum((outputs.data->>'storage')::bigint) / 1000 / 1000 / 1000) as storage_GB,
 count(*) as nb_outputs,
 projects.id
from outputs
  inner join batches    on batches.id    = outputs.batch_id
  inner join ci_commits on ci_commits.id = batches.ci_commit_id
  inner join projects   on projects.id   = ci_commits.project_id
where
  outputs.created_date > current_date - 31
group by (projects.id)
ORDER BY storage_GB DESC NULLS LAST;


-- per branch
select
 (sum((outputs.data->>'storage')::bigint) / 1000 / 1000 / 1000) as storage_GB,
 count(*) as nb_outputs,
 projects.id, ci_commits.branch
from outputs
  inner join batches    on batches.id    = outputs.batch_id
  inner join ci_commits on ci_commits.id = batches.ci_commit_id
  inner join projects   on projects.id   = ci_commits.project_id
where
  outputs.created_date > current_date - 31
group by (ci_commits.branch, projects.id)
ORDER BY storage_GB DESC NULLS LAST;
