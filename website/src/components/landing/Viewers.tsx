// The landing page's showcase of the viewers: one tab per kind of output, each with one strong shot or clip.
// Only the selected tab's media is in the page; clips load and play when in view (see Clip).
// Every claim is checked against the web app's code: see website/STYLE.md#claims.
import React, {type ReactNode} from 'react';
import clsx from 'clsx';
import Link from '@docusaurus/Link';
import Shot from '@site/src/components/Shot';
import Clip from '@site/src/components/Clip';
import {useTabs} from './useTabs';
import styles from './Viewers.module.css';

type Point = {term: string; text: ReactNode};
type Viewer = {
  name: string;
  icon: ReactNode;
  title: string;
  lead: ReactNode;
  points: Point[];
  link: string;
  linkLabel: string;
  media: ReactNode;
};

// 24x24 line icons, drawn with currentColor
const icon = (paths: ReactNode) => (
  <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    {paths}
  </svg>
);

const VIEWERS: Viewer[] = [
  {
    name: 'Images',
    icon: icon(
      <>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <circle cx="9" cy="10" r="2" />
        <path d="m21 16-5-5-9 9" />
      </>,
    ),
    title: 'Images, down to the pixel',
    lead: 'Zoom from a 113 MP test wall to single pixels of a Siemens star, and the reference follows. The viewer loads only the tiles it shows.',
    points: [
      {term: 'Wipe and flip', text: 'Drag a divider across the two images, or flip between them in place: differences jump out.'},
      {
        term: 'The difference',
        text: 'Perceptual, ΔE 2000, absolute or signed. Raise its maximum until only what really changed stands out.',
      },
      {term: 'Blind tests', text: 'The two images in a random order, A and B: pick the better one, then reveal which was new.'},
    ],
    link: '/docs/user-guide/image-viewer',
    linkLabel: 'The image viewer',
    media: <Clip id="commit/deep-zoom" caption="" />,
  },
  {
    name: 'Videos',
    icon: icon(
      <>
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <path d="M10 9.5v5l4.5-2.5z" />
      </>,
    ),
    title: 'Videos, frame by frame',
    lead: 'New and reference play in sync. Paused, they show the same frame, numbered from the file’s own timestamps. Step, zoom, wipe, flip or diff them like images.',
    points: [
      {
        term: 'The codec’s values',
        text: 'The server decodes the frame you look at: Y′, Cb and Cr as the file stores them, 10-bit included, next to the 8-bit RGB your browser shows.',
      },
      {
        term: 'What’s in the files',
        text: (
          <>
            Codec, pixel format (<code>yuv420p10le</code>), chroma subsampling, color range, keyframes and dropped frames,
            side by side, with what differs highlighted.
          </>
        ),
      },
      {
        term: 'Where they differ',
        text: (
          <>
            The server compares every decoded frame: the timeline shows how much each one differs, and <kbd>n</kbd> jumps to
            the next peak.
          </>
        ),
      },
    ],
    link: '/docs/user-guide/video-viewer',
    linkLabel: 'The video viewer',
    media: <Clip id="commit/video-compare" caption="" />,
  },
  {
    name: '3D and robotics',
    icon: icon(
      <>
        <path d="m12 3 8 4.5v9L12 21l-8-4.5v-9z" />
        <path d="m12 12 8-4.5M12 12v9m0-9L4 7.5" />
      </>,
    ),
    title: 'Point clouds, trajectories, depth',
    lead: 'The map a robot built, against the ground truth: orbit around it, show or hide each cloud. Here false loop closures put shelves meters away from where they are.',
    points: [
      {term: '6DoF trajectories', text: 'x, y, z and orientation over time, and the path in 3D: new, reference and ground truth together.'},
      {term: 'Depth video in sync', text: 'The depth camera next to the path so far, playing with the reference’s, frame by frame.'},
      {term: 'Error over time', text: 'A plot your code draws, with the reference’s curve on the same axes.'},
    ],
    link: '/docs/user-guide/other-viewers#point-clouds-and-trajectories',
    linkLabel: 'Point clouds and trajectories',
    media: <Shot id="commit/pointcloud" caption="" />,
  },
  {
    name: 'Performance',
    icon: icon(<path d="M12 3c.6 3.2 4.8 5.2 4.8 10a4.8 4.8 0 0 1-9.6 0c0-2.4 1.3-3.9 2.4-5 .2 1.5.9 2.5 1.8 3 .2-2.7-.4-5.4.6-8z" />),
    title: 'Flame graphs and latency tails',
    lead: 'See which functions changed, not only that p99 did. In a differential flame graph, new frames are orange, slower ones red, faster ones blue.',
    points: [
      {term: 'Latency percentiles', text: 'Your percentile plots, with the reference’s line on the same axes, out to the far tail.'},
      {term: 'Any figure your benchmark draws', text: 'CPU per core, throughput against p99: new next to reference, or overlaid.'},
      {term: 'Text outputs, diffed', text: 'Percentile distributions, logs or any text file, line by line against the reference’s.'},
    ],
    link: '/docs/user-guide/other-viewers#flame-graphs',
    linkLabel: 'Flame graphs',
    media: <Shot id="commit/flame-diff" caption="" />,
  },
  {
    name: 'Plots and reports',
    icon: icon(
      <>
        <path d="M4 4v16h16" />
        <path d="m7.5 15 3.5-4.5 3 3 5-6.5" />
      </>,
    ),
    title: 'Plots, reports and transcripts',
    lead: 'Whatever your code draws or writes, next to the reference’s. Text is diffed side by side: here, after a change, an assistant reboots a robot without asking.',
    points: [
      {term: 'Plotly figures', text: 'Precision-recall curves, CDFs, anything you plot: the reference’s traces on the same axes, dashed or faded.'},
      {term: 'HTML reports', text: 'Your own page per run, with its tables and images, in the run’s card next to the reference’s.'},
      {term: 'Images your code draws', text: 'Detections, masks or maps get the image viewer: synced, wiped and diffed.'},
    ],
    link: '/docs/user-guide/other-viewers#plots',
    linkLabel: 'Plots, reports and text',
    media: <Shot id="commit/transcript-diff" caption="" />,
  },
];

export default function Viewers() {
  const {selected, tabListProps, tabProps, panelProps} = useTabs(VIEWERS.length, 'Viewers');
  const viewer = VIEWERS[selected];
  return (
    <div className={styles.viewers}>
      <div className={styles.tabs} {...tabListProps}>
        {VIEWERS.map((v, index) => (
          <button key={v.name} {...tabProps(index)} className={clsx(styles.tab, index === selected && styles.tabSelected)}>
            {v.icon}
            <span>{v.name}</span>
          </button>
        ))}
      </div>
      <div className={styles.panel} {...panelProps}>
        <div className={styles.text}>
          <h3 className={styles.title}>{viewer.title}</h3>
          <p className={styles.lead}>{viewer.lead}</p>
          <ul className={styles.points}>
            {viewer.points.map(({term, text}) => (
              <li key={term}>
                <strong>{term}</strong>
                <span>{text}</span>
              </li>
            ))}
          </ul>
          <Link to={viewer.link}>{viewer.linkLabel} →</Link>
        </div>
        {/* Only the selected viewer's media is in the page: the others load when picked */}
        <div className={styles.media} key={viewer.name}>
          {viewer.media}
        </div>
      </div>
    </div>
  );
}
