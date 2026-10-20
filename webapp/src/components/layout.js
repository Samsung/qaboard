import styled from "styled-components";


// The page's content: its width follows the content area (the window minus the sidebar), not the window,
// so that pages look the same whatever the sidebar takes. The side margins grow with the content area.
const Container = styled.div`
  box-sizing: border-box;
  width: 100%;
  margin-top: 20px;
  margin-bottom: 10px;
  /* percentages are of the content area's width */
  padding-left: clamp(16px, 4%, 96px);
  padding-right: clamp(16px, 4%, 96px);
`;

// A view of the page: as wide as the content area, wider if its content needs it (e.g. a table with many metrics)
const Section = styled.div`
  margin-bottom: 40px;
  margin-top: 30px;
  width: fit-content;
  min-width: 100%;
  box-sizing: border-box;
`;



const Layout = styled.div`
  display: flex;
  flex: auto;
  flex-direction: row;
  box-sizing: border-box;
  // style
  background: var(--qa-background);
  min-height: 750px;
`

export { Container, Section, Layout };


// The commit page's fixed header: a bar for the new commit, one for the reference (except in views about the new
// commit only), then the references' tabs when there are several (components/ReferenceTabs.jsx)
export const commit_bar_height = 75;
export const reference_tabs_height = 34;
export const shows_reference_bar = selected_views => !['logs', 'tuning', 'groups'].some(view => selected_views.includes(view));
export const commit_header_height = ({ selected_views, references }) => {
  if (!shows_reference_bar(selected_views)) return commit_bar_height;
  return 2 * commit_bar_height + (references.length > 1 ? reference_tabs_height : 0);
};
