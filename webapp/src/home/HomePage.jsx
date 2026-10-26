// Home, for signed-in users: their projects, their batches (running, failed, recent) and their teammates', what's new.
// Three columns on desktops, two on tablets, one on phones. Signed-out visitors get Explore instead (see App.jsx).
import { useEffect, useMemo } from "react";
import styled from "styled-components";

import Footer from "../components/Footer";
import { SiteNavbar } from "../explore/ExplorePage";
import { useUser } from "../hooks";
import { FromYourProjects, GetStarted, NeedsAttention, Recent, RunningNow, useFeed } from "./Feed";
import { useMyProjects, YourProjects } from "./YourProjects";
import { Learn, WhatsNew, YourStorage } from "./SideCards";


const Grid = styled.main`
  box-sizing: border-box;
  width: 100%;
  max-width: 1440px;
  margin: 0 auto;
  padding: 20px clamp(16px, 3%, 40px) 32px;
  display: grid;
  grid-template-columns: minmax(240px, 300px) minmax(0, 1fr) minmax(240px, 320px);
  grid-template-areas: "left center right";
  gap: 0 24px;
  align-items: start;
  > .qa-home-left { grid-area: left; }
  > .qa-home-center { grid-area: center; min-width: 0; }
  > .qa-home-right { grid-area: right; }
  @media (max-width: 1100px) {
    grid-template-columns: minmax(220px, 280px) minmax(0, 1fr);
    grid-template-areas: "left center" "right center";
    grid-template-rows: auto 1fr;
  }
  /* phones: what runs and failed first */
  @media (max-width: 720px) {
    grid-template-columns: minmax(0, 1fr);
    grid-template-areas: "center" "left" "right";
    grid-template-rows: none;
    padding: 16px 16px 24px;
  }
`;

// for screen readers: the cards' headings say the rest
const PageTitle = styled.h1`
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
`;

const HomePage = () => {
  const user = useUser();
  const feed = useFeed();
  useEffect(() => {
    document.title = 'Home - QA-Board';
  }, []);
  const my_batches = useMemo(() => [...(feed.running.data ?? []), ...(feed.recent.data ?? [])], [feed.running.data, feed.recent.data]);
  const { query: projects_query, projects } = useMyProjects(my_batches);
  const project_ids = useMemo(() => projects.slice(0, 50).map(p => p.id), [projects]);
  const usage = {
    has_batches: my_batches.length > 0,
    has_webapp: my_batches.some(b => b.origin === 'webapp'),
    has_running: my_batches.some(b => b.pending_outputs > 0),
  };

  return <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
    <SiteNavbar via="home"/>
    <Grid>
      <PageTitle>Home of {user.full_name || user.user_name}</PageTitle>
      <div className="qa-home-left">
        <YourProjects query={projects_query} projects={projects}/>
      </div>
      <div className="qa-home-center">
        {feed.is_new && <GetStarted/>}
        <RunningNow query={feed.running}/>
        <NeedsAttention query={feed.failed}/>
        {!feed.is_new && <Recent query={feed.recent}/>}
        <FromYourProjects projects={project_ids}/>
      </div>
      <aside className="qa-home-right" aria-label="News and help">
        <WhatsNew/>
        <YourStorage/>
        <Learn usage={usage}/>
      </aside>
    </Grid>
    <Footer/>
  </div>;
};

export default HomePage;
