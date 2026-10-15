import { useEffect, useMemo, useState } from "react";
import styled from "styled-components";

import { DateTime } from 'luxon';


import {
  Button,
  Callout,
  Classes,
  Intent,
  NonIdealState,
  Spinner,
  Card,
  SegmentedControl,
  Tag,
  Tooltip,
} from "@blueprintjs/core";

import CommitRow, { CompactCommitList, CompactListContainer, compact_columns_css } from "./components/CommitRow";
import { Container } from "./components/layout";
import { LoadMore } from "./components/LoadMore";
import CommitsEvolution from "./CommitsEvolution";
import { groupBy } from "./utils";

import { useCommitsList, useProjectData, useSelected, useSiteConfig, updateSelected } from './hooks'
import { errorMessage } from './api/http'
import { useCommitListDensity, usePrefsStore } from './stores/prefs'



const WrapperCommitRows = styled.ul`
  list-style: none;
  margin: 0;
  padding: 0;
`;

const CommitRows = ({ commits, project, project_data, density }) => {
  const List = density === 'compact' ? CompactCommitList : WrapperCommitRows;
  return <List>
    {commits.map(commit => (
      <CommitRow
        commit={commit}
        project={project}
        project_data={project_data}
        density={density}
        key={commit.id}
      />
    ))}
  </List>;
};

// Above the commits, how to show them
const ListToolbar = styled.div`
  display: flex;
  justify-content: flex-end;
  margin-bottom: 8px;
`;

const density_options = [
  { value: 'comfortable', label: 'Comfortable', icon: 'list' },
  { value: 'compact', label: 'Compact', icon: 'list-columns' },
];

const DensityControl = () => {
  const density = useCommitListDensity();
  const setDensity = usePrefsStore(state => state.setCommitListDensity);
  return <Tooltip content="Comfortable: a few lines per commit. Compact: one line per commit, hover for details." placement="left" openOnTargetFocus={false}>
    <SegmentedControl
      aria-label="Commit list density"
      size="small"
      options={density_options}
      value={density}
      onValueChange={setDensity}
    />
  </Tooltip>;
};

// Compact rows line up across days: the days' cards and lists share the columns of this grid
const CompactDays = styled.div`
  ${compact_columns_css}
  & > .${Classes.CARD} {
    grid-column: 1 / -1;
    display: grid;
    grid-template-columns: subgrid;
  }
  & > .${Classes.CARD} > h4 {
    grid-column: 1 / -1;
  }
  & > .${Classes.CARD} > ul {
    grid-column: 1 / -1;
    grid-template-columns: subgrid;
  }
`;
const ComfortableDays = styled.div``;

// In compact lists, days take less room too
const DayCard = styled(Card)`
  margin-bottom: 15px;
  &.compact {
    padding: 12px 16px;
    margin-bottom: 10px;
  }
  &.compact h4 {
    font-size: 14px;
    line-height: 20px;
    margin-bottom: 4px;
  }
`;

// "Today — 1 commit", "3 days ago — 2 commits"
const count_commits = n => `${n} commit${n === 1 ? '' : 's'}`
const capitalize = text => text ? text.charAt(0).toUpperCase() + text.slice(1) : text

// e.g. "No commits with results in the last 3 days"
const no_commits_title = ([from, to], now) => {
  const relative = date => DateTime.fromJSDate(date).toRelativeCalendar({ unit: "days" })
  if (to <= now)
    return `No commits with results from ${relative(from)} to ${relative(to)}`
  const days = Math.round(DateTime.fromJSDate(now).startOf('day').diff(DateTime.fromJSDate(from).startOf('day'), 'days').days)
  return days < 1 ? "No commits with results today" : `No commits with results in the last ${days} day${days === 1 ? '' : 's'}`
}

const search_help = <span>
  Words must all match the commit id, message, committer, branch or batches. <code>-word</code> excludes,
  {" "}<code>branch:</code>, <code>committer:</code>, <code>batch:</code>, <code>message:</code> and <code>id:</code> look at a single field.
</span>

const SearchHeader = ({ search, nb_commits, has_more, isFetching }) => (
  <Callout icon={isFetching ? <Spinner size={16}/> : "search"} intent={Intent.PRIMARY} style={{marginBottom: '15px'}} title={<>
    Searching all commits for <q>{search}</q>
    {!isFetching && <Tag minimal round style={{marginLeft: '10px'}}>{nb_commits}{has_more ? '+' : ''} {nb_commits === 1 ? 'match' : 'matches'}</Tag>}
  </>}>
    <span className={Classes.TEXT_MUTED}>{search_help}</span>
  </Callout>
);




const CiCommitList = () => {
  const { project, branch, committer } = useSelected();
  const project_data = useProjectData(project);
  const { docs_root } = useSiteConfig();
  const { commits, error, refetch, isPending, isPlaceholderData, isSuccess, date_range, search, hasNextPage, fetchNextPage, isFetchingNextPage } = useCommitsList();
  // new results are on their way (background refreshes don't count)
  const loading = isPending || isPlaceholderData;
  const [now] = useState(() => new Date());
  const density = useCommitListDensity();
  const Days = density === 'compact' ? CompactDays : ComfortableDays;

  useEffect(() => {
    let name = project.split('/').slice(-1)[0];
    document.title = `${branch || committer || project} - ${name}`;
  }, [project, branch, committer]);

  const commits_by_day = useMemo(() => groupBy(commits, "authored_date"), [commits]);

  const is_branch = !!branch;
  const some_commits_loaded = commits.length > 0;
  const show_metrics_over_time = (isSuccess || some_commits_loaded) && !error && is_branch && !search;
  const loadMore = () => {
    if (hasNextPage && !isFetchingNextPage && !error) fetchNextPage();
  };
  // the range ends where we have commits, if there are no recent ones
  const show_older = () => updateSelected({ from: DateTime.fromJSDate(date_range[0]).minus({ days: 7 }).toJSDate() }, { replace: true });
  // On branches, the metrics configuration comes from the latest commit
  const evolution_project_data = useMemo(() => {
    if (!is_branch || !some_commits_loaded) return project_data;
    return { ...commits[0], data: { ...commits[0].data, git: project_data.data?.git } };
  }, [is_branch, some_commits_loaded, commits, project_data]);

  return (
    <Container style={{paddingTop: '50px'}}>
      {/* the chart has a fixed width: it scrolls rather than spill out of the card */}
      {show_metrics_over_time && <Card elevation={0} style={{marginBottom: '15px', overflowX: 'auto'}}>
        <h4 className={Classes.HEADING}>Performance over time</h4>
        <CommitsEvolution
          project={project}
          project_data={evolution_project_data}
          commits={commits}
          per_output_granularity={false}
        />
      </Card>}
      {!!search && <SearchHeader search={search} nb_commits={commits.length} has_more={hasNextPage} isFetching={loading}/>}
      {error && <NonIdealState
        icon="error"
        title="Could not load the commits"
        description={<p style={{ overflowWrap: 'anywhere' }}>
          <code>{errorMessage(error)}</code>
          {error.response?.status >= 500 && <><br/>If it persists, contact your QA-Board administrators.</>}
        </p>}
        action={<Button icon="refresh" text="Retry" onClick={() => refetch()}/>}
      />}
      {isPending && !error && <NonIdealState title="Loading commits…" icon={<Spinner />} />}
      {isSuccess && !loading && !error && !some_commits_loaded && !!search &&
        <NonIdealState title="No commit matches your search" icon="search" />}
      {isSuccess && !loading && !error && !some_commits_loaded && !search &&
        <NonIdealState
          title={no_commits_title(date_range, now)}
          description={<span>
            Results appear once <code>qa batch</code> runs in your CI.<br/>
            <a target="_blank" rel="noopener noreferrer" href={`${docs_root}docs/ci-integration`}>Set up your CI</a>
          </span>}
          icon="search"
          action={<Button icon="history" text="Search 7 more days" onClick={show_older}/>}
      />}
      {some_commits_loaded && !error && <ListToolbar><DensityControl/></ListToolbar>}
      <CompactListContainer><Days>{Object.keys(commits_by_day).map(day => (
        <DayCard key={day} elevation={0} className={density === 'compact' ? 'compact' : undefined}>
          <h4 className={Classes.HEADING}>
            {(!!day && day !== "undefined")
              ? `${capitalize(DateTime.fromISO(day, { zone: 'utc' }).toRelativeCalendar({unit: "days"}))} \u2014 ${count_commits(commits_by_day[day].length)}`
              : capitalize(count_commits(commits_by_day[day].length))}
          </h4>
          <CommitRows project={project} project_data={project_data} commits={commits_by_day[day]} density={density} />
        </DayCard>
      ))}</Days></CompactListContainer>
      {hasNextPage && some_commits_loaded && !error &&
        <LoadMore onLoadMore={loadMore} loading={isFetchingNextPage} loaded={commits.length} text="More commits"/>}
      {isSuccess && !hasNextPage && some_commits_loaded && !search && !loading &&
        <div style={{display: 'flex', justifyContent: 'center', margin: '15px'}}>
          <Button minimal icon="history" text="Older commits" title="Search 7 more days" onClick={show_older}/>
        </div>}
    </Container>
  );
}

export default CiCommitList;
