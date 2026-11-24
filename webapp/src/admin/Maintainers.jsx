// Admin → Overview: QA-Board's maintainers would love to help. "Write to them" opens the admin's email app with a
// message to edit (backend/maintainers.py): QA-Board sends them nothing by itself. Once admins wrote, or said no
// thanks (web.maintainers_contact), the card stops asking, for every admin, but still says how to reach them.
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AnchorButton, Button, Card, Classes, Intent } from "@blueprintjs/core";

import { errorMessage } from "../api/http";
import { toaster } from "../toaster";
import { useSiteConfig } from "../hooks";
import { repository_url } from "../components/Footer";
import { docsUrl } from "./settings/SettingRow";
import { overviewQuery, saveSetting } from "./api";


const DOCS = '/docs/backend-admin/support';

// mailto: wants %20 for spaces, which encodeURIComponent does (URLSearchParams would write +)
export const mailtoUrl = ({ email, subject, body }) =>
  `mailto:${email}?subject=${encodeURIComponent(subject ?? '')}&body=${encodeURIComponent(body ?? '')}`;


export const Maintainers = ({ maintainers }) => {
  const queryClient = useQueryClient();
  const { docs_root = '/' } = useSiteConfig();
  const [wrote, setWrote] = useState(false);
  const [saving, setSaving] = useState(null);
  if (!maintainers?.email) return null;
  const asking = !maintainers.status;

  const save = status => {
    setSaving(status);
    saveSetting(queryClient, 'web.maintainers_contact', status)
      .then(() => queryClient.invalidateQueries({ queryKey: overviewQuery.queryKey }))
      .catch(error => toaster.show({ message: `Could not save it: ${errorMessage(error)}`, intent: Intent.DANGER }))
      .finally(() => setSaving(null));
  };

  return <Card id="maintainers" aria-label="Help from QA-Board's maintainers" style={{ maxWidth: 820, marginTop: 28 }}>
    <h4 className={Classes.HEADING}>Help from QA-Board's maintainers</h4>
    <p>
      QA-Board's maintainers would love to help you make it work for your teams: setting up the server, integrating
      your projects, choosing runners, getting the most out of the viewers. If you have more advanced needs,
      they're happy to talk about them too.
    </p>
    <p style={{ marginBottom: asking ? 16 : 0 }}>
      Write to <a href={`mailto:${maintainers.email}`}>{maintainers.email}</a>, or <a href={`${repository_url}/issues`} target="_blank" rel="noopener noreferrer">open an issue on GitHub</a>.
      {' '}<a href={docsUrl(docs_root, DOCS)} target="_blank" rel="noopener noreferrer">More about support</a>
    </p>
    {asking && <>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <AnchorButton intent={Intent.PRIMARY} icon="envelope" href={mailtoUrl(maintainers)} onClick={() => setWrote(true)} text="Tell them about your team"/>
        {wrote
          ? <Button variant="minimal" icon="tick" loading={saving === 'sent'} onClick={() => save('sent')} text="I sent it"/>
          : <Button variant="minimal" loading={saving === 'dismissed'} onClick={() => save('dismissed')} text="No thanks"/>}
      </div>
      <p className={Classes.TEXT_MUTED} style={{ margin: '10px 0 0', fontSize: 12 }}>
        Your email app opens with a message to edit: who you are, what you'd like help with, whether to hear about security
        fixes and new releases, and how this server is set up (version, sign-in, runner, rough size), without projects,
        people or hostnames. Nothing is sent unless you send it.
      </p>
    </>}
  </Card>;
};
