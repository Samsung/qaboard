// Short explanations of tuning concepts, next to where they show: most people who tune aren't optimization experts.
// <Learn topic="pareto"/> is a "?" that opens a few sentences and links to the best references we know.
import { Button, Classes, PopoverNext } from "@blueprintjs/core";
import styled from "styled-components";

import { useSiteConfig } from "../../hooks";

const Content = styled.div`
  padding: 14px 16px;
  max-width: 400px;
  font-size: 13px;
  font-weight: 400;
  line-height: 1.45;
  h5 { margin: 0 0 6px; font-size: 14px; }
  p { margin: 0 0 8px; }
  ul { margin: 0; padding-left: 18px; }
  li { margin-bottom: 2px; }
  .qa-learn-more { margin: 10px 0 4px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }
`;

const optuna = 'https://optuna.readthedocs.io/en/stable';

// {title, text, links: [[label, url]]}. `docs:` links are pages of QA-Board's docs.
export const topics = {
  parameter_sets: {
    title: 'Parameter sets',
    text: <>
      <p>A parameter set is one combination of values, like <em>threshold 0.3, kernel 5</em>. It usually ran on several tests.</p>
      <p>To compare sets fairly, QA-Board first combines each set's metric over its tests (their average, or their median), so
      a set that ran on more tests doesn't count more. Sets that are missing tests are left out of the ranking.</p>
    </>,
    links: [['Tune from the web app', 'docs:user-guide/running-from-the-webapp#tuning-analysis']],
  },
  aggregation: {
    title: 'Average or median?',
    text: <>
      <p>The <strong>average</strong> counts every test, so one test that gets much worse shows. It's what automated tuning
      optimizes.</p>
      <p>The <strong>median</strong> is the middle test: it ignores a few extreme ones. Use it when some tests are outliers
      you don't want to tune for.</p>
    </>,
    links: [['Average and median, Wikipedia', 'https://en.wikipedia.org/wiki/Median#Measures_of_location_and_dispersion']],
  },
  impact: {
    title: 'Impact of a parameter',
    text: <>
      <p>How much of the metric's ups and downs between parameter sets this parameter explains on its own. Near 100%: this
      parameter decides the result. Near 0%: changing it does little, in the range you tried.</p>
      <p>It is a hint, not a proof: with few parameter sets it is noisy, and two parameters that only matter together
      can both look unimportant. A low impact also depends on the range: a parameter tried between 0.49 and 0.51 won't
      matter much.</p>
    </>,
    links: [
      ['Effect size, Wikipedia', 'https://en.wikipedia.org/wiki/Effect_size#Eta-squared_(%CE%B7%C2%B2)'],
      ['How Optuna evaluates importance', `${optuna}/reference/importance.html`],
    ],
  },
  importance: {
    title: 'Impact of a parameter',
    text: <>
      <p>How much of the objective's variation each parameter explains: they add up to 100%. A parameter with a high
      impact is worth a careful range; one under 5% can be fixed, so the next search goes faster.</p>
      <p>It is estimated from the evaluations done so far, and only within the ranges searched: it gets more reliable with
      more evaluations.</p>
    </>,
    links: [
      ['How Optuna evaluates importance', `${optuna}/reference/importance.html`],
      ['fANOVA, the method behind it', 'https://proceedings.mlr.press/v32/hutter14.html'],
    ],
  },
  parallel: {
    title: 'How to read parallel coordinates',
    text: <>
      <p>Each vertical axis is a metric or a parameter. Each line is one parameter set: follow it to read its values.</p>
      <ul>
        <li>Lines are colored by a metric: look where the best-colored lines go on each parameter's axis.</li>
        <li>If the good lines all pass through the same part of an axis, that parameter matters, and that's its good range.</li>
        <li>If they spread over the whole axis, it doesn't matter much.</li>
        <li>Drag along an axis to keep only the lines in a range, for instance the best values of a metric.</li>
      </ul>
    </>,
    links: [
      ['Parallel coordinates, Wikipedia', 'https://en.wikipedia.org/wiki/Parallel_coordinates'],
      ['Tuning Analysis', 'docs:user-guide/running-from-the-webapp#tuning-analysis'],
    ],
  },
  pareto: {
    title: 'Best trade-offs: the Pareto front',
    text: <>
      <p>When two metrics pull in opposite directions, like sharpness and noise, there is no single best: improving one
      costs some of the other.</p>
      <p>The <strong>Pareto front</strong> is the short list worth choosing from: the parameter sets that nothing else beats on
      both metrics at once. Every other set is worse than one of them on both, so you can forget it.</p>
      <p>Which point of the front to pick is your call: it depends on how much of one metric you'd give for the other.</p>
    </>,
    links: [
      ['Pareto front, Wikipedia', 'https://en.wikipedia.org/wiki/Pareto_front'],
      ['Multi-objective optimization with Optuna', `${optuna}/tutorial/20_recipes/002_multi_objective.html`],
    ],
  },
  convergence: {
    title: 'Has the search converged?',
    text: <>
      <p>The line is the best result so far. Early on it drops in big steps; later the steps get rare and small: the
      search has found most of what there is to find in these ranges.</p>
      <p>Still dropping near the end: give it more evaluations. Flat for the last third: more evaluations won't help much,
      and changing the ranges or the parameters will.</p>
    </>,
    links: [['Read the results of an automated tuning', 'docs:user-guide/automated-tuning#results']],
  },
  objective: {
    title: 'The objective',
    text: <>
      <p>One number that says how good a set of parameters is: the metrics you chose, averaged over the batch's tests and
      added up with their weights. The search always looks for the <strong>lowest</strong> objective, so metrics where
      higher is better count negatively.</p>
      <p>With several metrics, the weights say how much of one you'd trade for another. If you can't say, use
      <strong> Find the best trade-offs</strong> instead: no weights, and you choose at the end.</p>
    </>,
    links: [['How the objective is computed', 'docs:auto-optimization']],
  },
  search: {
    title: 'How the search picks parameters',
    text: <>
      <p>It starts with a few random tries. Then it builds a model of which regions look promising from the results so far,
      and tries there, while still exploring a bit: this is <em>Bayesian optimization</em>. It usually finds better
      parameters than a grid with far fewer runs, because it doesn't waste runs where results are bad.</p>
      <p>A grid is still fine for 1 or 2 parameters with a handful of values, or when you want every combination to compare.</p>
    </>,
    links: [
      ['Exploring Bayesian Optimization, an illustrated introduction (Distill)', 'https://distill.pub/2020/bayesian-optimization/'],
      ["Optuna's search algorithms", `${optuna}/tutorial/10_key_features/003_efficient_optimization_algorithms.html`],
      ['Why random search beats grids (Bergstra & Bengio)', 'https://www.jmlr.org/papers/v13/bergstra12a.html'],
    ],
  },
  overfitting: {
    title: 'Check the best parameters on other tests',
    text: <>
      <p>Parameters tuned on a few tests can end up fitting those tests only, like a student who learned the answers of
      one exam. The more parameters and the fewer tests, the more likely.</p>
      <p>Before adopting them, run the best parameters on a larger batch the tuning didn't see, and compare with your
      reference.</p>
    </>,
    links: [
      ['Overfitting, Wikipedia', 'https://en.wikipedia.org/wiki/Overfitting'],
      ['Training, validation and test sets, Wikipedia', 'https://en.wikipedia.org/wiki/Training,_validation,_and_test_data_sets'],
    ],
  },
  log_scale: {
    title: 'Log scale',
    text: <>
      <p>For values that span orders of magnitude, like 0.001 to 1: a log scale gives as much room to 0.001–0.01 as to
      0.1–1. On a linear scale, everything under 0.1 would be squeezed in a corner.</p>
    </>,
    links: [['Logarithmic scale, Wikipedia', 'https://en.wikipedia.org/wiki/Logarithmic_scale']],
  },
  metrics: {
    title: 'Metrics',
    text: <>
      <p>A metric is a number that scores a run: sharpness, noise, an error, a runtime. Tuning compares parameters with
      them, so you need at least one.</p>
      <p>Your code can return metrics when it runs. You can also add them later, with a short script that reads each run's
      files and computes what you want: no need to run again.</p>
    </>,
    links: [
      ['Add metrics to runs from a script', 'docs:apis#log'],
      ['Computing metrics', 'docs:computing-quantitative-metrics'],
    ],
  },
};

export const learn_href = (url, docs_root) => url.startsWith('docs:') ? `${docs_root}docs/${url.slice(5)}` : url;

// A "?" next to a title. `label` instead shows a text link.
const Learn = ({ topic, label, placement = 'bottom-start' }) => {
  const { docs_root } = useSiteConfig();
  const content = topics[topic];
  if (!content) return null;
  const popover = <Content data-testid={`learn-${topic}`}>
    <h5>{content.title}</h5>
    {content.text}
    {content.links?.length > 0 && <>
      <div className={`qa-learn-more ${Classes.TEXT_MUTED}`}>Learn more</div>
      <ul>
        {content.links.map(([text, url]) => <li key={url}>
          <a href={learn_href(url, docs_root)} target="_blank" rel="noopener noreferrer">{text}</a>
        </li>)}
      </ul>
    </>}
  </Content>;
  return <PopoverNext content={popover} placement={placement} interactionKind="click">
    {label
      ? <Button variant="minimal" size="small" icon="help" text={label} aria-label={`${label}: ${content.title}`}/>
      : <Button variant="minimal" size="small" icon="help" aria-label={`Explain: ${content.title}`} className={Classes.TEXT_MUTED} style={{ minHeight: 20, minWidth: 20, padding: 2 }}/>}
  </PopoverNext>;
};

export default Learn;
