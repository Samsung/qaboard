// On the views of a batch's results: says that the batch tried several parameters, and that Tuning Analysis compares them.
// Without it, people look at the runs one by one and never open the analysis.
import { Button, Callout, Intent } from "@blueprintjs/core";

import { updateSelected } from "../../hooks";
import { tuning_kind } from "./analysis";
import { plural } from "./report";

const TuningBanner = ({ batch }) => {
  const kind = tuning_kind(batch);
  if (!kind) return null;
  const open = () => updateSelected({ selected_views: 'optimization' });
  return <Callout compact intent={Intent.PRIMARY} icon="predictive-analysis" data-testid="tuning-banner" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px 12px' }}>
    <span style={{ flex: 1, minWidth: 240 }}>
      {kind.kind === 'automated'
        ? <>This batch is an <strong>automated tuning</strong>: {plural(kind.evaluations, 'evaluation')}. The runs below are those of its best parameters.</>
        : <>This batch tried <strong>{plural(kind.sets, 'parameter set')}</strong> of {kind.parameters.slice(0, 3).map((name, i) => <span key={name}>{i > 0 && ', '}<code>{name}</code></span>)}{kind.parameters.length > 3 && ` and ${kind.parameters.length - 3} more`}{kind.tests > 1 && <> on {plural(kind.tests, 'test')}</>}.</>}
    </span>
    <Button size="small" intent={Intent.PRIMARY} endIcon="arrow-right" text={kind.kind === 'automated' ? 'See what it found' : kind.has_metrics ? 'See which is best' : 'Compare them'} onClick={open}/>
  </Callout>;
};

export default TuningBanner;
