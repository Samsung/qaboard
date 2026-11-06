// Where a setting's value comes from. The environment wins over what's saved here, that wins over the default:
// the badge says which one is used, its popover what each layer says.
import { Button, Classes, Icon, Intent, Popover, Tag } from "@blueprintjs/core";
import styled from "styled-components";

import { Time } from "../../settings/format";
import { SettingValue } from "./values";


const sources = {
  env: { label: 'Environment', icon: 'lock', intent: Intent.WARNING, help: "Set in the server's environment, read-only here." },
  database: { label: 'Saved here', icon: 'floppy-disk', intent: Intent.PRIMARY, help: "Saved in the database from this page." },
  default: { label: 'Default', icon: null, intent: Intent.NONE, help: "Not set: QA-Board uses its default." },
};

const Layers = styled.ol`
  list-style: none;
  margin: 0;
  padding: 0;
  li {
    display: grid;
    grid-template-columns: 18px minmax(0, 1fr);
    gap: 2px 8px;
    padding: 8px 0;
    border-top: 1px solid var(--qa-border);
  }
  li:first-child { border-top: none; padding-top: 0; }
  .layer-title { display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; }
  .layer-body { grid-column: 2; min-width: 0; overflow-wrap: anywhere; font-size: 13px; }
  .ignored { opacity: 0.7; }
`;

const Layer = ({ used, title, status, children }) => <li className={used ? undefined : 'ignored'}>
  <Icon icon={used ? 'tick-circle' : 'circle'} intent={used ? Intent.SUCCESS : Intent.NONE} size={14} aria-label={used ? 'In use' : undefined} style={{ marginTop: 2 }}/>
  <span className="layer-title">
    <strong>{title}</strong>
    {used ? <Tag minimal round intent={Intent.SUCCESS}>in use</Tag> : status && <span className={Classes.TEXT_MUTED}>{status}</span>}
  </span>
  {children && <div className="layer-body">{children}</div>}
</li>;

const Problem = ({ text }) => <div style={{ color: 'var(--qa-text-danger)', marginTop: 4 }} role="alert">{text}</div>;

export const ProvenanceDetails = ({ setting }) => {
  const { env, database, default: fallback } = setting.layers ?? {};
  const source = setting.source;
  return <div style={{ padding: 14, maxWidth: 380 }} data-testid="provenance">
    <div style={{ fontWeight: 600, marginBottom: 10 }}>Where this value comes from</div>
    <Layers>
      <Layer
        used={source === 'env'}
        title="Server's environment"
        status={env?.name ? (env.set ? 'set, but invalid' : 'not set') : 'no variable'}
      >
        {env?.name && <div><code>${env.name}</code>{source === 'env' && <> · change it where the server is deployed</>}</div>}
        {env?.error && <Problem text={env.error}/>}
        {env?.set && source === 'env' && <div style={{ marginTop: 4 }}><SettingValue setting={setting} value={env.value}/></div>}
      </Layer>
      <Layer
        used={source === 'database'}
        title="Saved here"
        status={database?.set ? (source === 'env' ? 'ignored: the environment wins' : 'not readable') : 'nothing saved'}
      >
        {database?.set && <>
          {database.value !== null && database.value !== undefined && source !== 'database' && <div style={{ marginBottom: 4 }}><SettingValue setting={setting} value={database.value}/></div>}
          <span className={Classes.TEXT_MUTED}>
            {database.updated_by ? <>By <strong>{database.updated_by}</strong>, </> : 'From the command line, '}
            <Time iso={database.updated_at} never="at an unknown date"/>
          </span>
        </>}
        {database?.error && <Problem text={database.error}/>}
      </Layer>
      <Layer used={source === 'default'} title="Default" status={null}>
        <SettingValue setting={setting} value={fallback?.value}/>
        {fallback?.text && <div className={Classes.TEXT_MUTED} style={{ marginTop: 2 }}>{fallback.text}</div>}
      </Layer>
    </Layers>
  </div>;
};

// The badge, with what each layer says in a popover
export const SourceTag = ({ setting }) => {
  const source = sources[setting.source] ?? sources.default;
  const problem = !!(setting.layers?.env?.error || setting.layers?.database?.error);
  const tag = <Tag
    minimal
    round
    interactive={!!setting.layers}
    icon={problem ? 'warning-sign' : source.icon}
    intent={problem ? Intent.DANGER : source.intent}
    aria-label={`${source.label}: where the value of ${setting.label ?? setting.key} comes from`}
    title={source.help}
  >
    {source.label}
  </Tag>;
  if (!setting.layers) return tag;
  return <Popover content={<ProvenanceDetails setting={setting}/>} placement="bottom-start" hasBackdrop={false}>
    {tag}
  </Popover>;
};

// For a setting the environment sets: copy it here, so that the variable can be removed
export const EnvActions = ({ setting, importing, onImport, onDeleteSaved }) => {
  if (setting.source !== 'env') return null;
  const name = setting.env;
  if (setting.env_matches_database)
    return <Hint icon="tick" intent={Intent.SUCCESS}>
      The same value is saved here: remove <code>${name}</code> from the server's environment, and manage it from this page.
    </Hint>;
  return <Hint icon="lock">
    Set by <code>${name}</code> in the server's environment, which wins over this page.
    {setting.can_import_env && <> <Button size="small" variant="minimal" intent={Intent.PRIMARY} icon="import" loading={importing} onClick={onImport} text="Save it here"/>
      <span className={Classes.TEXT_MUTED}>then remove the variable.</span></>}
    {setting.shadowed && <> A different value saved here is ignored. <Button size="small" variant="minimal" icon="trash" onClick={onDeleteSaved} text="Delete it"/></>}
  </Hint>;
};

const HintLine = styled.div`
  display: flex;
  gap: 6px;
  align-items: baseline;
  font-size: 12px;
  color: var(--qa-text-muted);
  margin-top: 6px;
  line-height: 1.6;
  .bp6-icon { position: relative; top: 2px; }
  > span { min-width: 0; overflow-wrap: anywhere; }
`;

export const Hint = ({ icon, intent, children }) => <HintLine>
  {icon && <Icon icon={icon} size={12} intent={intent}/>}
  <span>{children}</span>
</HintLine>;
