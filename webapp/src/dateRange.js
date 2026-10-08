import { createTransform } from 'redux-persist'

import { default_date_range } from './defaults'


// Returns a copy of `date_range` that spans whole days: from 00:00 on the first day to 23:59:59.999 on the last.
// Accepts Dates or anything `new Date()` parses (redux-persist rehydrates Dates as ISO strings),
// and never mutates its input, which often comes from the redux store.
export const day_range = date_range => {
  const from = new Date(date_range[0]);
  const to = new Date(date_range[1]);
  from.setHours(0, 0, 0, 0);
  to.setHours(23, 59, 59, 999);
  return [from, to];
}


const is_valid_date = date => date instanceof Date && !isNaN(date);

// redux-persist stores the state as JSON, so the commit lists' `date_range` come back as strings.
// We turn them back into Dates when rehydrating the `projects` slice.
export const restore_date_ranges = projects => {
  if (!projects?.data)
    return projects;
  const data = Object.fromEntries(Object.entries(projects.data).map(([project, project_data]) => {
    if (!project_data?.commits)
      return [project, project_data];
    const commits = Object.fromEntries(Object.entries(project_data.commits).map(([key, commits_data]) => {
      if (!Array.isArray(commits_data?.date_range))
        return [key, commits_data];
      let date_range = commits_data.date_range.map(d => (d === null || d === undefined) ? d : new Date(d));
      // older versions could store a half-selected range, e.g. [from, null]
      if (date_range.length !== 2 || !date_range.every(is_valid_date))
        date_range = default_date_range();
      return [key, { ...commits_data, date_range }];
    }));
    return [project, { ...project_data, commits }];
  }));
  return { ...projects, data };
}

export const dateRangesTransform = createTransform(
  inbound => inbound,
  outbound => restore_date_ranges(outbound),
  { whitelist: ['projects'] },
)
