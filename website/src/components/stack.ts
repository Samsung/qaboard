// The reader's stack: the tab groups that <StackPicker /> sets at once, and their values (docs-media/README.md#stackpicker).
// This is the only place they're defined. Pages use them in plain Docusaurus tabs:
//   <Tabs groupId="ci" queryString>
//     <TabItem value="github-actions" label="GitHub Actions" default>...</TabItem>
// The build checks those tabs against this file (website/plugins/stack): known groups and values, the same labels,
// `queryString`, and `default` on the group's default. The first value of each group is its default.
export type StackGroup = 'server' | 'forge' | 'ci' | 'runner' | 'code';

export type StackOption = {value: string; label: string};

export type StackGroupInfo = {
  id: StackGroup;
  /** The picker's label for the group */
  label: string;
  options: StackOption[];
};

export const STACK_GROUPS: StackGroupInfo[] = [
  {
    id: 'server',
    label: 'Server',
    options: [
      {value: 'compose', label: 'Docker Compose'},
      {value: 'k8s', label: 'Kubernetes (Helm)'},
    ],
  },
  {
    id: 'forge',
    label: 'Code hosting',
    options: [
      {value: 'github', label: 'GitHub'},
      {value: 'gitlab', label: 'GitLab'},
    ],
  },
  {
    id: 'ci',
    label: 'CI',
    options: [
      {value: 'github-actions', label: 'GitHub Actions'},
      {value: 'gitlab-ci', label: 'GitLab CI'},
      {value: 'jenkins', label: 'Jenkins'},
    ],
  },
  {
    id: 'runner',
    label: 'Runs on',
    options: [
      {value: 'local', label: 'Local'},
      {value: 'lsf', label: 'LSF'},
      {value: 'dask', label: 'Dask'},
      {value: 'celery', label: 'Celery'},
    ],
  },
  {
    id: 'code',
    label: 'Your code',
    options: [
      {value: 'python', label: 'Python'},
      {value: 'executable', label: 'Any executable'},
    ],
  },
];

/** The storage slot of Docusaurus tabs with this groupId: the picker and the tabs share it */
export const storageKey = (group: StackGroup) => `docusaurus.tab.${group}`;

export const defaultValue = (group: StackGroupInfo) => group.options[0].value;

export default STACK_GROUPS;
