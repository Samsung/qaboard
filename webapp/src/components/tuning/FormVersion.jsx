// Run Tests / Tuning has a new form, and keeps the previous one for a while: people switch both ways, and say why.
// Their answers are usage events (`tuning_form_feedback`), with the project: Admin → Usage lists the events.
import { useState } from "react";
import { Button, Callout, Checkbox, Classes, Dialog, DialogBody, DialogFooter, Intent, TextArea } from "@blueprintjs/core";

import { usePrefsStore } from "../../stores/prefs";
import { track } from "../../analytics";
import { toaster } from "../../toaster";

const REASONS = [
  ['harder', 'Harder to use'],
  ['slower', 'Slower to do what I do every day'],
  ['missing', 'Something I need is missing'],
  ['bug', 'Something doesn’t work'],
  ['habit', 'I prefer what I know'],
];
const MAX_COMMENT = 1000;
// usage events keep strings of 200 characters at most (backend/backend/usage.py): a longer comment goes in pieces
const pieces = text => text.match(/[\s\S]{1,200}/g) ?? [];

/** "new" or "previous": the form people chose, remembered with their preferences */
export const useTuningFormVersion = () => usePrefsStore(state => state.tuningForm === 'previous' ? 'previous' : 'new');

const FeedbackDialog = ({ isOpen, onClose, project, going_back }) => {
  const setTuningForm = usePrefsStore(state => state.setTuningForm);
  const [reasons, setReasons] = useState([]);
  const [comment, setComment] = useState('');
  const send = back => {
    track('tuning_form_feedback', {
      reasons: reasons.length ? reasons : undefined,
      comment: comment.trim() ? pieces(comment.trim().slice(0, MAX_COMMENT)) : undefined,
      switched_to: back ? 'previous' : undefined,
    }, { project_id: project });
    if (back) setTuningForm('previous');
    setReasons([]);
    setComment('');
    onClose();
    toaster.show({
      message: back ? 'Thanks. You are on the previous form: the new one is a click away at the top.' : 'Thanks for your feedback.',
      intent: Intent.SUCCESS, icon: 'chat',
    }, 'tuning-form-feedback');
  };
  return <Dialog isOpen={isOpen} onClose={onClose} title={going_back ? 'Go back to the previous form?' : 'What do you think of this form?'} icon="chat" style={{ width: 'min(520px, 94vw)' }}>
    <DialogBody>
      <p style={{ marginTop: 0 }}>
        {going_back
          ? 'You can switch back at any time. Telling us why helps us fix the new form before the previous one goes away.'
          : 'This form is new. Tell us what helps and what gets in the way: the team that runs QA-Board reads every answer.'}
      </p>
      <div role="group" aria-label="Reasons">
        {REASONS.map(([value, label]) => <Checkbox
          key={value}
          label={label}
          checked={reasons.includes(value)}
          onChange={e => setReasons(r => e.target.checked ? [...r, value] : r.filter(v => v !== value))}
        />)}
      </div>
      <label htmlFor="tuning-form-comment" style={{ display: 'block', margin: '10px 0 4px' }}>What should we change? <span className={Classes.TEXT_MUTED}>(optional)</span></label>
      <TextArea id="tuning-form-comment" fill rows={3} maxLength={MAX_COMMENT} value={comment} onChange={e => setComment(e.target.value)}/>
      <p className={Classes.TEXT_MUTED} style={{ fontSize: 12, margin: '6px 0 0' }}>Sent with your name and the project.</p>
    </DialogBody>
    <DialogFooter actions={going_back
      ? <>
        <Button text="Stay on the new form" onClick={onClose}/>
        <Button intent={Intent.PRIMARY} text="Go back" onClick={() => send(true)} data-testid="tuning-form-go-back"/>
      </>
      : <>
        <Button text="Cancel" onClick={onClose}/>
        <Button intent={Intent.PRIMARY} text="Send" disabled={!reasons.length && !comment.trim()} onClick={() => send(false)} data-testid="tuning-form-send-feedback"/>
      </>}/>
  </Dialog>;
};

/** On the new form: feedback, and the way back to the previous form */
export const NewFormActions = ({ project }) => {
  const [dialog, setDialog] = useState(null);
  return <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 4 }}>
    <Button variant="minimal" size="small" icon="chat" text="Feedback" onClick={() => setDialog('feedback')} data-testid="tuning-form-feedback"/>
    <Button variant="minimal" size="small" icon="undo" text="Use the previous form" onClick={() => setDialog('back')} data-testid="tuning-form-previous"/>
    <FeedbackDialog isOpen={dialog !== null} going_back={dialog === 'back'} onClose={() => setDialog(null)} project={project}/>
  </span>;
};

/** Above the previous form: the new one is a click away */
export const PreviousFormBanner = ({ project }) => {
  const setTuningForm = usePrefsStore(state => state.setTuningForm);
  return <Callout icon="clean" intent={Intent.PRIMARY} style={{ marginBottom: 15 }} data-testid="tuning-form-banner">
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
      <span style={{ flex: '1 1 320px' }}>
        <strong>This is the previous form.</strong> The new one lists the batches with their tests, puts the values to try
        in a table, and starts from a batch you ran before.
      </span>
      <Button intent={Intent.PRIMARY} text="Use the new form" onClick={() => {
        track('tuning_form_feedback', { switched_to: 'new' }, { project_id: project });
        setTuningForm('new');
      }} data-testid="tuning-form-new"/>
    </div>
  </Callout>;
};
