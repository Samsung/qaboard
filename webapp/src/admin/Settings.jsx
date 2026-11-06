// Admin → Settings: every setting, grouped, with where its value comes from (backend/settings.py). The environment
// wins over what's saved here, which wins over the default. Secrets are encrypted, and never shown again.
// The URL keeps the search and the filter (?q=&filter=), and links to a setting (?setting=key) or a group (?group=id).
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "react-router";
import { Button, Classes, HTMLSelect, Icon, InputGroup, Intent, KeyComboTag, Menu, MenuItem, NonIdealState, Tag } from "@blueprintjs/core";
import styled from "styled-components";

import { history } from "../router";
import { useSiteConfig } from "../hooks";
import { WithCode } from "../settings/format";
import { Loading } from "../settings/states";
import { AdminError } from "./states";
import { settingsDataQuery } from "./api";
import { filters, organize, readSettingsUrl, settingsUrl } from "./settings/model";
import { SettingRow, VariableRow, Rows, SettingsList, docsUrl } from "./settings/SettingRow";
import { EncryptionPanel } from "./settings/EncryptionPanel";
import { TestEmail } from "./settings/TestEmail";

// Used by other admin pages
export { SourceTag } from "./settings/Provenance";
export { SettingValue } from "./settings/values";
export { settingType } from "./settings/model";
export const SettingsTable = SettingsList;


const Layout = styled.div`
  display: grid;
  grid-template-columns: 220px minmax(0, 1fr);
  gap: 24px;
  align-items: start;
  .nav { position: sticky; top: 12px; }
  .nav .bp6-menu { background: transparent; padding: 0; }
  .jump { display: none; }
  @media (max-width: 960px) {
    grid-template-columns: minmax(0, 1fr);
    .nav { display: none; }
    .jump { display: block; }
  }
`;

const Toolbar = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
  margin-bottom: 20px;
  .search { flex: 0 1 380px; min-width: 220px; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; }
`;

const Section = styled.section`
  margin-bottom: 32px;
  scroll-margin-top: 16px;
  .heading { display: flex; align-items: center; gap: 8px; margin: 0 0 4px; }
  .heading h3 { margin: 0; font-size: 17px; }
  .group-description { margin: 0 0 12px; max-width: 80ch; }
  .variables-title { margin: 16px 0 8px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; display: flex; align-items: center; gap: 6px; }
`;

const Chip = ({ filter, count, active, onClick }) => <Button
  size="small"
  variant={active ? undefined : 'outlined'}
  intent={active ? Intent.PRIMARY : filter.intent === 'danger' && count ? Intent.DANGER : undefined}
  active={active}
  onClick={onClick}
  aria-pressed={active}
  title={filter.description}
  text={<>{filter.label} <Tag minimal round style={{ marginLeft: 4 }}>{count}</Tag></>}
/>;


const scrollTo = id => document.getElementById(id)?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });

export const Settings = ({ me }) => {
  const location = useLocation();
  const url = readSettingsUrl(location.search);
  const { data, isPending, error, refetch } = useQuery(settingsDataQuery);
  const { docs_root = '/' } = useSiteConfig();

  // the URL follows the search a moment after admins stop typing
  const [query, setQuery] = useState(url.query);
  const latest = useRef(url);
  useEffect(() => { latest.current = url; });
  useEffect(() => {
    if (query === latest.current.query) return;
    const timer = setTimeout(() => history.replace(settingsUrl({ ...latest.current, query, setting: null, group: null })), 250);
    return () => clearTimeout(timer);
  }, [query]);
  const setFilter = filter => history.replace(settingsUrl({ ...url, query, filter, setting: null, group: null }));

  // "/" searches
  const search_ref = useRef(null);
  useEffect(() => {
    const onKey = e => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target;
      if (target?.closest?.('input, textarea, select, [contenteditable="true"]')) return;
      e.preventDefault();
      search_ref.current?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const organized = useMemo(() => data ? organize(data, { query: url.query, filter: url.filter }) : null, [data, url.query, url.filter]);

  // links to a setting or a group scroll to it, and the setting flashes
  const loaded = !!data;
  useEffect(() => {
    if (!loaded) return;
    const id = url.setting ? `setting-${url.setting}` : url.group ? `group-${url.group}` : null;
    if (id) requestAnimationFrame(() => scrollTo(id));
  }, [loaded, url.setting, url.group]);
  const highlighted = url.setting;

  if (isPending) return <Loading label="Loading the settings"/>;
  if (error) return <AdminError error={error} refetch={refetch} what="the settings"/>;
  if (!data.settings.length) return <NonIdealState icon="cog" title="No settings" description="This server has no settings to show."/>;

  const { sections, counts } = organized;
  const filtered = !!url.query || url.filter !== 'all';
  const clear = () => { setQuery(''); history.replace(settingsUrl({})); };
  const email_enabled = !!data.settings.find(s => s.key === 'email.smtp_host')?.is_set;

  return <section aria-label="Settings">
    <p className={Classes.TEXT_MUTED} style={{ marginTop: 0, maxWidth: 820 }}>
      Change how this server works without a deploy: changes apply to every replica within a few seconds, and are kept
      in the database, with its backups. A variable set in the server's environment wins, and is read-only here.
      Secrets are encrypted, and never shown again. Click a setting's badge to see where its value comes from.
    </p>

    <Toolbar>
      <InputGroup
        className="search"
        inputRef={search_ref}
        leftIcon="search"
        placeholder="Search settings and variables…"
        aria-label="Search settings"
        value={query}
        onChange={e => setQuery(e.target.value)}
        onKeyDown={e => { if (e.key === 'Escape') { setQuery(''); e.currentTarget.blur(); } }}
        rightElement={query
          ? <Button variant="minimal" icon="cross" aria-label="Clear the search" onClick={() => { setQuery(''); history.replace(settingsUrl({ ...url, query: '' })); }}/>
          : <span className={Classes.TEXT_MUTED} style={{ display: 'inline-flex', height: '100%', alignItems: 'center', paddingRight: 8 }} title="Press / to search"><KeyComboTag combo="/" minimal/></span>}
      />
      <div className="chips" role="group" aria-label="Show">
        {filters.filter(f => f.id !== 'attention' || counts.attention > 0 || url.filter === 'attention').map(filter => <Chip
          key={filter.id}
          filter={filter}
          count={filter.id === 'all' ? counts.all : counts[filter.id]}
          active={url.filter === filter.id}
          onClick={() => setFilter(filter.id)}
        />)}
      </div>
    </Toolbar>

    {!sections.length
      ? <NonIdealState
        icon="search"
        title="No settings match"
        description={url.query ? <>Nothing matches “{url.query}”{url.filter !== 'all' ? ' with this filter' : ''}.</> : 'No setting matches this filter.'}
        action={<Button text="Show all the settings" icon="filter-remove" onClick={clear}/>}
      />
      : <Layout>
        <nav className="nav" aria-label="Setting groups">
          <Menu>
            {sections.map(section => <MenuItem
              key={section.id}
              icon={section.icon}
              text={section.title}
              label={String(section.settings.length || '')}
              onClick={() => { history.replace(settingsUrl({ ...url, query, setting: null, group: section.id })); scrollTo(`group-${section.id}`); }}
            />)}
          </Menu>
          {filtered && <Button size="small" variant="minimal" icon="filter-remove" text="Show all" onClick={clear} style={{ marginTop: 8 }}/>}
        </nav>
        <div style={{ minWidth: 0 }}>
          <div className="jump" style={{ marginBottom: 16 }}>
            <HTMLSelect
              aria-label="Go to a group of settings"
              value=""
              onChange={e => e.target.value && scrollTo(`group-${e.target.value}`)}
              options={[{ value: '', label: 'Go to…' }, ...sections.map(section => ({ value: section.id, label: section.title }))]}
            />
          </div>
          {sections.map(section => <Section key={section.id} id={`group-${section.id}`} aria-labelledby={`group-title-${section.id}`}>
            <div className="heading">
              <Icon icon={section.icon} className={Classes.TEXT_MUTED}/>
              <h3 id={`group-title-${section.id}`} className={Classes.HEADING}>{section.title}</h3>
              {section.docs && <a href={docsUrl(docs_root, section.docs)} target="_blank" rel="noopener noreferrer" style={{ marginLeft: 'auto', fontSize: 13 }}>
                Docs <Icon icon="share" size={11}/>
              </a>}
            </div>
            {section.description && <p className={`group-description ${Classes.TEXT_MUTED}`}><WithCode text={section.description}/></p>}
            {section.id === 'security' && !url.query && <EncryptionPanel status={data.encryption}/>}
            {section.settings.length > 0 && <Rows>
              {section.settings.map(setting => <SettingRow key={setting.key} setting={setting} highlighted={highlighted === setting.key}/>)}
              {section.id === 'email' && <TestEmail enabled={email_enabled} me={me}/>}
            </Rows>}
            {section.variables.length > 0 && <>
              {section.settings.length > 0 && <div className={`variables-title ${Classes.TEXT_MUTED}`}><Icon icon="lock" size={11}/> Only from the server's environment</div>}
              <Rows aria-label={`${section.title}: variables of the server's environment`}>
                {section.variables.map(variable => <VariableRow key={variable.key} variable={variable}/>)}
              </Rows>
            </>}
          </Section>)}
        </div>
      </Layout>}
  </section>;
};

export default Settings;
