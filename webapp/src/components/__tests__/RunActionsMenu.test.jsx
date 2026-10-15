/**
 * Tests for what users can do with a run: redo it, delete it...
 * Run with: cd webapp && npm test -- RunActionsMenu
 */
import { screen, fireEvent, waitFor, within } from '@testing-library/react';
import { Button, PopoverNext } from '@blueprintjs/core';

import { RunActionsMenu } from '../tags';
import { toaster } from '../../toaster';
import { renderWithProviders } from '../../test-utils';


const output = { id: 7, test_input_path: 'scenes/indoor.mp4', test_input_metadata: {}, is_pending: false, deleted: false };
const renderMenu = () => renderWithProviders(<RunActionsMenu output={output} project="p" commit={{ id: 'abc' }} />, { siteConfig: {} });


describe('RunActionsMenu', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 }))));
  afterEach(() => vi.unstubAllGlobals());

  it('asks before deleting a run, then names it', async () => {
    renderMenu();
    fireEvent.click(screen.getByText('Delete…'));
    const alert = within(screen.getByRole('alertdialog'));
    expect(alert.getByText('Delete scenes/indoor.mp4?')).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
    fireEvent.click(alert.getByText('Delete run'));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/v1/output/7/', expect.objectContaining({ method: 'DELETE' })));
    // the toaster is mocked in setupTests.js
    await waitFor(() => expect(toaster.show).toHaveBeenCalledWith(expect.objectContaining({ message: 'Deleted scenes/indoor.mp4' }), 'run-action-7'));
  });

  it("can delete only the run's files", async () => {
    renderMenu();
    fireEvent.click(screen.getByText('Delete Output Files…'));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByText('Delete files'));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/v1/output/7/?soft=true', expect.objectContaining({ method: 'DELETE' })));
  });

  it('confirms from the popover menu of the logs', async () => {
    renderWithProviders(<PopoverNext content={<RunActionsMenu output={output} project="p" commit={{ id: 'abc' }} />}>
      <Button aria-label="Run actions" />
    </PopoverNext>, { siteConfig: {} });
    fireEvent.click(screen.getByLabelText('Run actions'));
    fireEvent.click(await screen.findByText('Delete…'));
    const confirm = within(await screen.findByRole('alertdialog')).getByText('Delete run');
    fireEvent.mouseDown(confirm);
    fireEvent.click(confirm);
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/v1/output/7/', expect.objectContaining({ method: 'DELETE' })));
  });

  it('cancels', async () => {
    renderMenu();
    fireEvent.click(screen.getByText('Delete…'));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByText('Cancel'));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(fetch).not.toHaveBeenCalled();
  });
});
