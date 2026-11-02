/**
 * The JUnit viewer: the run's tests against the reference's, filters, search, keyboard.
 * Run with: cd webapp && npm test -- junitViewer
 */
import { fireEvent, screen, within } from '@testing-library/react';

import JunitViewer, { JunitReport } from '../junit/JunitViewer';
import { is_junit } from '../OutputViewer';
import { renderWithProviders } from '../../test-utils';

vi.mock('copy-to-clipboard', () => ({ default: vi.fn(() => true) }));

// jsdom has no layout: the list's virtualizer would render no row
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(440);
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 800, height: 440, top: 0, left: 0, right: 800, bottom: 440, x: 0, y: 0 });
});
afterEach(() => vi.restoreAllMocks());

const report = cases => `<testsuites><testsuite name="pytest">${cases.join('\n')}</testsuite></testsuites>`;
const pass = (cls, name, time = 0.01) => `<testcase classname="${cls}" name="${name}" time="${time}"/>`;
const fail = (cls, name, message = 'assert 1 == 2') =>
  `<testcase classname="${cls}" name="${name}" time="0.02"><failure message="${message}">E   ${message}</failure></testcase>`;

const REF = report([
  pass('tests.codec.test_varint', 'test_small'),
  pass('tests.codec.test_varint', 'test_big'),
  fail('tests.missions.test_assign', 'test_reserve'),
  pass('tests.missions.test_assign', 'test_closest'),
  pass('tests.missions.test_reserve', 'test_gone'),
]);
const NEW = report([
  pass('tests.codec.test_varint', 'test_small'),
  fail('tests.codec.test_varint', 'test_big', 'assert 4294967296 == 0'),
  pass('tests.missions.test_assign', 'test_reserve'),
  pass('tests.missions.test_assign', 'test_closest'),
  pass('tests.planning.test_astar', 'test_new'),
]);

const render = props => renderWithProviders(<JunitReport xml={NEW} ref_xml={REF} path="junit.xml" {...props}/>);
const tree = () => screen.getByRole('tree', { name: 'Tests' });
const rowNames = () => within(tree()).getAllByRole('treeitem').map(row => row.querySelector('.qa-junit-name').textContent);
const testNames = () => within(tree()).getAllByRole('treeitem').filter(row => row.classList.contains('qa-junit-test'))
  .map(row => row.querySelector('.qa-junit-name').textContent);

describe('JunitReport', () => {
  it('counts the tests, against the reference', () => {
    render();
    expect(screen.getByRole('button', { name: /Failed\s*1/ })).toBeInTheDocument();
    expect(screen.getByRole('toolbar', { name: 'Changes' })).toHaveTextContent('1 new failure');
    expect(screen.getByRole('toolbar', { name: 'Changes' })).toHaveTextContent('1 fixed');
    expect(screen.getByRole('toolbar', { name: 'Changes' })).toHaveTextContent('1 added');
    expect(screen.getByRole('toolbar', { name: 'Changes' })).toHaveTextContent('1 removed');
  });

  it('opens on the new failure, with why it failed', () => {
    render();
    const selected = within(tree()).getAllByRole('treeitem').find(row => row.getAttribute('aria-selected') === 'true');
    expect(selected).toHaveTextContent('test_big');
    const details = document.querySelector('.qa-junit-details');
    expect(details).toHaveTextContent('assert 4294967296 == 0');
    // failed in the new run, passed in the reference
    expect(details).toHaveTextContent(/Status\s*new:\s*Failed\s*reference:\s*Passed\s*new failure/);
  });

  it('filters by status from the tiles', () => {
    render();
    fireEvent.click(screen.getByRole('button', { name: /Failed\s*1/ }));
    expect(testNames()).toEqual(['test_big']);
    expect(screen.getByText(/1 of 6 tests/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(screen.queryByText(/of 6 tests/)).not.toBeInTheDocument();
  });

  it('filters by change from the chips', () => {
    render();
    fireEvent.click(within(screen.getByRole('toolbar', { name: 'Changes' })).getByText('1 removed'));
    expect(testNames()).toEqual(['test_gone']);
  });

  it('searches tests and their messages', () => {
    render();
    fireEvent.change(screen.getByRole('textbox', { name: 'Search the tests' }), { target: { value: '4294967296' } });
    expect(testNames()).toEqual(['test_big']);
    fireEvent.change(screen.getByRole('textbox', { name: 'Search the tests' }), { target: { value: 'nothing-like-this' } });
    expect(screen.getByText('No tests match')).toBeInTheDocument();
  });

  it('moves with the keyboard, and jumps between failures', () => {
    render();
    const before = rowNames();
    fireEvent.keyDown(tree(), { key: 'Home' });
    expect(within(tree()).getAllByRole('treeitem')[0]).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(tree(), { key: 'ArrowDown' });
    expect(within(tree()).getAllByRole('treeitem')[1]).toHaveAttribute('aria-selected', 'true');
    // closes the selected group
    fireEvent.keyDown(tree(), { key: 'ArrowLeft' });
    expect(rowNames().length).toBeLessThan(before.length);
    fireEvent.keyDown(tree(), { key: 'n' });
    const selected = within(tree()).getAllByRole('treeitem').find(row => row.getAttribute('aria-selected') === 'true');
    expect(selected.textContent).toMatch(/test_big|test_gone/);
  });

  it('shows the new report alone without a reference', () => {
    render({ ref_xml: null });
    expect(screen.queryByRole('toolbar', { name: 'Changes' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Failed\s*1/ })).toBeInTheDocument();
  });

  it('says when the file is not a report', () => {
    render({ xml: '<html/>' });
    expect(screen.getByText(/not a JUnit XML report/)).toBeInTheDocument();
  });
});

describe('JunitViewer', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async url => new Response(String(url).includes('/ref/') ? REF : NEW, { headers: { 'Content-Type': 'application/xml' } })));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('downloads the run\'s report and the reference\'s', async () => {
    renderWithProviders(<JunitViewer path="junit.xml" output_new={{ output_dir_url: '/s/new' }} output_ref={{ output_dir_url: '/s/ref' }}/>);
    expect(await screen.findByRole('toolbar', { name: 'Changes' })).toHaveTextContent('1 new failure');
  });
});

describe('is_junit', () => {
  it('recognizes the names of JUnit reports', () => {
    expect(['junit.xml', 'out/junit.xml', 'codec.junit.xml', 'report-junit.xml', 'TEST-com.kitefin.ClientTest.xml'].every(is_junit)).toBe(true);
    expect(['data.xml', 'junit.xml.bak', 'notjunit.xml'].some(is_junit)).toBe(false);
  });
});
