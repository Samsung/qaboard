import { vi, beforeEach, afterEach, it, expect } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';

const analytics = vi.hoisted(() => ({ captureException: vi.fn(() => 'abc'), captureFeedback: vi.fn(), reportsErrors: vi.fn(() => false) }));
vi.mock('../../analytics', () => analytics);
// Monaco that crashes, e.g. on what people pasted
vi.mock('../MonacoEditorImpl', () => ({
  default: () => { throw new Error('monaco boom'); },
  MonacoDiffEditorImpl: () => { throw new Error('diff boom'); },
}));
const batches_file = vi.hoisted(() => ({ analyzeBatches: vi.fn() }));
vi.mock('../tuning/batches_file', async importOriginal => ({ ...await importOriginal(), ...batches_file }));

import { renderWithProviders } from '../../test-utils';
import MonacoEditor, { MonacoDiffEditor } from '../MonacoEditor';
import { SectionErrorBoundary } from '../ErrorFallback';
import { safeAnalyzeBatches } from '../tuning/BatchesEditor';

beforeEach(() => {
  analytics.captureException.mockClear();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => console.error.mockRestore());

it('keeps the text editable when Monaco crashes, and reports it', async () => {
  const onChange = vi.fn();
  renderWithProviders(<MonacoEditor value="batch: {inputs: [a.jpg]}" onChange={onChange} height={200}/>);
  const textarea = await screen.findByRole('textbox', { name: 'Plain text editor' });
  expect(textarea).toHaveValue('batch: {inputs: [a.jpg]}');
  fireEvent.change(textarea, { target: { value: 'batch: {inputs: [b.jpg]}' } });
  expect(onChange).toHaveBeenCalledWith('batch: {inputs: [b.jpg]}');
  expect(screen.getByText(/keep editing as plain text/)).toBeInTheDocument();
  expect(analytics.captureException).toHaveBeenCalledWith(expect.objectContaining({ message: 'monaco boom' }), expect.objectContaining({ tags: { error_boundary: 'editor' } }));
});

it('read-only editors stay read-only', async () => {
  renderWithProviders(<MonacoEditor value="a" options={{ readOnly: true }}/>);
  expect(await screen.findByRole('textbox', { name: 'Plain text editor' })).toHaveAttribute('readonly');
});

it('says when the diff crashes', async () => {
  renderWithProviders(<MonacoDiffEditor original="a" value="b"/>);
  expect(await screen.findByText('Could not show the changes')).toBeInTheDocument();
  expect(analytics.captureException).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ tags: { error_boundary: 'diff-editor' } }));
});

it('a section that crashes leaves the rest of the page', () => {
  const Broken = () => { throw new Error('section boom'); };
  renderWithProviders(<>
    <SectionErrorBoundary><Broken/></SectionErrorBoundary>
    <p>Metrics Table</p>
  </>);
  expect(screen.getByText('This part of the page crashed')).toBeInTheDocument();
  expect(screen.getByText('Metrics Table')).toBeInTheDocument();
  expect(analytics.captureException).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ tags: { error_boundary: 'section' } }));
});

it('batch files that the analysis chokes on stay editable, and are reported once', () => {
  batches_file.analyzeBatches.mockImplementation(() => { throw new TypeError('weird paste'); });
  const first = safeAnalyzeBatches('\u0000weird', {});
  expect(first.items).toEqual([]);
  expect(first.problems).toEqual([expect.objectContaining({ severity: 'warning', message: expect.stringContaining('could not check this file') })]);
  // at each keystroke
  safeAnalyzeBatches('\u0000weirder', {});
  expect(analytics.captureException).toHaveBeenCalledTimes(1);
  expect(analytics.captureException).toHaveBeenCalledWith(expect.objectContaining({ message: 'weird paste' }), expect.objectContaining({ tags: { error_boundary: 'batches-analysis' } }));
});
