import { useMemo, useState } from "react";
import { Link } from "./router";

import { DateTime } from 'luxon';

import {
  Classes,
  Colors,
  Card,
  Button,
  Icon,
  Tag,
  Intent,
  InputGroup,
  NonIdealState,
  Spinner,
  Navbar,
  NavbarDivider,
  NavbarGroup,
  NavbarHeading,
  Alignment,
} from "@blueprintjs/core";
import { Container } from "./components/layout";
import { ProjectAvatar } from "./components/avatars";
import { LoadMore } from "./components/LoadMore";
import AuthButton from "./components/authentication/Auth"
import PrivateContent from "./components/authentication/PrivateContent"
import { WhatsNewLink } from './releaseNotes/ReleaseNotes'
import { useProjects, useSiteConfig, useUser } from './hooks'
import { usePrefsStore } from './stores/prefs'
import { match_query } from "./utils"
import { project_web_url, quota_url } from "./utils"


const LastCommitAt = ({ project, className }) => {
  let date_commit = project.latest_commit_datetime;
  let date_output = project.latest_output_datetime || project.data.latest_output_datetime;
  let date = date_output || date_commit
  return (
    <span className={className} style={{marginBottom: '5px'}}>
      <span style={{ color: "#555"}}>last {!!date_output ? "run" : "commit"}
      {" "}
      <span title={date}>{DateTime.fromISO(date, { zone: 'utc' }).toRelative()}</span>
      </span>
    </span>
  );
}

// Projects with recent results first, favorites on top
const sort_projects = favorites => ([id0, d0], [id1, d1]) => {
  const fav0 = !!favorites[id0];
  const fav1 = !!favorites[id1];
  if (fav0 !== fav1)
    return fav1 - fav0;
  const date0 = d0.latest_output_datetime || d0.data?.latest_output_datetime;
  const date1 = d1.latest_output_datetime || d1.data?.latest_output_datetime;
  if (!!date1 && !date0) return 1
  if (!date1 && !!date0) return -1
  if (!date1 && !date0) return new Date(d1.latest_commit_datetime) - new Date(d0.latest_commit_datetime)
  return new Date(date1) - new Date(date0);
}


const ProjectCard = ({ project_id, details }) => {
  const is_favorite = usePrefsStore(state => !!state.favorites[project_id]);
  const toggleFavorite = usePrefsStore(state => state.toggleFavorite);
  const data = details.data || {};
  const git = data.git || {};
  const qatools_config_project = data.qatools_config?.project || {};
  // from qaboard.yaml, else from GitHub/GitLab
  const description = qatools_config_project.description || git.description;
  const web_url = project_web_url(details)

  return (
    <Card
      style={{ margin: "15px", display: 'flex', alignItems: 'center'}}
      elevation={2}
    >
      <div style={{'alignSelf': 'center', flex: '0 0 auto', 'marginRight': '10px'}}>
        <ProjectAvatar
          project={project_id}
          data={data}
          href={`/${project_id}`}
        />
      </div>
      <div style={{'alignSelf': 'center', 'minWidth': 0}}>
        <h5 className={Classes.HEADING}><Link to={`/${project_id}`}>{project_id}</Link></h5>
        {description && <p style={{marginTop: '5px', marginBottom: '0px'}} className={Classes.TEXT_MUTED}>{description}</p>}
      </div>
      <div style={{'alignSelf': 'center', 'marginLeft': 'auto', textAlign: 'right', flex: '0 0 auto'}}>
        <p style={{marginBottom: '5px'}}>
          <Button
            minimal
            aria-label={is_favorite ? "Unpin" : "Pin"}
            title="Pin on top of the list."
            icon={<Icon icon={is_favorite ? "star" : "star-empty"} style={{color: Colors.GOLD5}}/>}
            onClick={() => toggleFavorite(project_id)}
          />
          <a href={web_url} style={{textDecoration: "none"}}><Button icon="git-repo" minimal round text="Source" style={{color: 'rgb(85, 85, 85)'}}/></a>
        </p>
        <p style={{marginBottom: '5px'}}><LastCommitAt project={details} /></p>
        <p style={{marginBottom: '0px'}}><span style={{ color: "#555" }}>
          {details.total_commits} commit{details.total_commits === 1 ? '' : 's'}
        </span></p>
      </div>
    </Card>
  );
}


// Not in a fragment: Blueprint gives icons a className
const github_cat = <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="#fff">
    <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
  </svg>

const EmptyProjects = ({ docs_root, support_url }) => <div style={{marginTop: '10vh'}}>
  <NonIdealState
    icon="heatmap"
    title="No projects yet."
    intent={Intent.PRIMARY}
    description={<p>Learn how to <a href={`${docs_root}docs/installation`}>get started</a>,<br/>and <a href={support_url}>ask the maintainers</a> if you run into issues.</p>}
  />
</div>;

// We render projects progressively: sites can have hundreds
const page_size = 50;


const ProjectsList = () => {
  const { data: projects = {}, error, isPending } = useProjects();
  const user = useUser();
  const { docs_root, support_url, quota_url_template } = useSiteConfig();
  const favorites = usePrefsStore(state => state.favorites);
  const [query, setQuery] = useState('');
  const [nb_shown, setNbShown] = useState(page_size);

  const rendered_projects = useMemo(() => {
    const matcher = match_query(query)
    return Object.entries(projects)
      .filter(([id]) => matcher(id))
      // legacy SIRC projects...
      .filter(([, data]) => !data.data?.legacy && data.data?.qatools_config?.project?.name !== undefined)
      .filter(([, details]) => details.latest_commit_datetime !== undefined && details.latest_commit_datetime !== null)
      .sort(sort_projects(favorites))
  }, [projects, query, favorites]);

  let warnings;
  if (error)
    warnings = <NonIdealState description={error.message} icon="error" />;
  if (isPending)
    warnings = <NonIdealState title="Loading projects..." icon={<Spinner />} />;

  const user_quota_url = user.is_logged && quota_url(quota_url_template, user.user_name);
  return (
    <>
      <Navbar className={Classes.DARK}>
          <NavbarGroup align={Alignment.LEFT}>
              <NavbarHeading><b>QA-Board</b></NavbarHeading>
              <NavbarDivider />
              <a href="https://github.com/Samsung/qaboard"><Button className={Classes.MINIMAL} icon={github_cat} text="GitHub" style={{color : "#fff"}}/></a>
              <a href={`${docs_root}docs/user-guide/overview`}><Button className={Classes.MINIMAL} icon={<Icon icon="help" color="#fff"/>} text="User guide" style={{color : "#fff"}}/></a>
              <WhatsNewLink via="projects-list"><Button className={Classes.MINIMAL} icon={<Icon icon="clean" color="#fff"/>} text="What's new" style={{color : "#fff"}}/></WhatsNewLink>
          </NavbarGroup>
          <NavbarGroup align={Alignment.RIGHT}>
            {user_quota_url && <a style={{paddingRight: '15px'}} href={user_quota_url} rel="noopener noreferrer" target="_blank">
              <Button icon="database" text="Quotas" style={{color : "#fff"}}/>
            </a>}
            <AuthButton/>
          </NavbarGroup>
      </Navbar>
      <Container>
        <PrivateContent>
          <div style={{display: "flex", justifyContent: "space-between", alignItems: "baseline"}}>
            <div style={{width: '300px', marginTop: '30px', marginBottom: '10px'}}>
                <InputGroup
                  intent={!!query ? Intent.PRIMARY : undefined}
                  value={query}
                  round
                  large
                  leftIcon="search"
                  placeholder="filter projects..."
                  onChange={e => {
                    setQuery(e.target.value);
                    setNbShown(page_size);
                  }}
                />
              </div>
            <div>
              <Tag intent={!!query ? Intent.PRIMARY : undefined} minimal>{rendered_projects.length} {!!query ? 'filtered ' : ''}project{rendered_projects.length === 1 ? '' : 's'}</Tag>
            </div>
          </div>
          {warnings}
          {!isPending && (rendered_projects.length === 0 ? <EmptyProjects docs_root={docs_root} support_url={support_url}/> : <div>
            {rendered_projects.slice(0, nb_shown).map(([project_id, details]) => <ProjectCard key={project_id} project_id={project_id} details={details}/>)}
            {nb_shown < rendered_projects.length && <LoadMore
              onLoadMore={() => setNbShown(nb => nb + page_size)}
              loaded={nb_shown}
              text={`Show more (${rendered_projects.length - nb_shown})`}
            />}
          </div>)}
        </PrivateContent>
      </Container>
    </>
  );
}

export default ProjectsList;
