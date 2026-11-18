/**
 * Tests for where batches are defined: "Defined in qa/batches.yaml".
 * Run with: cd webapp && npm test -- BatchReport
 */
import { screen, fireEvent, within } from '@testing-library/react';

import { renderWithProviders } from '../../../test-utils';
import { BatchDefinitions, definitionsFiles } from '../BatchReport';


// A batch split in many batches, all in the same file
const split = Array.from({ length: 12 }, (_, idx) => ({ name: `nightly-${idx}`, files: ['qa/batches.yaml'], sources: ['commit'] }));
const context = {
  shared: 'extra-batches',
  user: 'alice',
  repoFileUrl: path => `https://github.com/org/repo/blob/abc/${path}`,
};

describe('definitionsFiles', () => {
  it('lists each file once, with the batches it defines', () => {
    expect(definitionsFiles(split)).toEqual([
      { path: 'qa/batches.yaml', source: 'commit', batches: split.map(d => d.name), wins: [] },
    ]);
  });

  it('says which file wins when several define a batch', () => {
    const files = definitionsFiles([
      { name: 'a', files: ['qa/batches.yaml'], sources: ['commit'] },
      { name: 'b', files: ['qa/batches.yaml', 'alice.yml'], sources: ['commit', 'qaboard'] },
    ]);
    expect(files.map(f => [f.path, f.source, f.batches, f.wins])).toEqual([
      ['qa/batches.yaml', 'commit', ['a', 'b'], []],
      ['alice.yml', 'qaboard', ['b'], ['b']],
    ]);
  });

  it('guesses where files come from without the sources', () => {
    const files = definitionsFiles([{ name: 'a', files: ['qa/a.yml', 'bob.yml', 'extra-batches.yml'] }], { shared: 'extra-batches', owner: 'bob' });
    expect(files.map(f => f.source)).toEqual(['commit', 'qaboard', 'qaboard']);
  });
});

describe('BatchDefinitions', () => {
  it('names the file once, not each batch', () => {
    renderWithProviders(<BatchDefinitions definitions={split} context={context} />);
    const defined = screen.getByLabelText('Where the batch is defined');
    expect(defined).toHaveTextContent(/^Defined in qa\/batches\.yaml$/);
    expect(within(defined).getByRole('link')).toHaveAttribute('href', 'https://github.com/org/repo/blob/abc/qa/batches.yaml');
    expect(within(defined).queryByText('nightly-0')).toBeNull();
  });

  it("doesn't link files outside the repository", () => {
    renderWithProviders(<BatchDefinitions definitions={[{ name: 'a', files: ['/mnt/batches.yaml'], sources: ['commit'] }]} context={context} />);
    const defined = screen.getByLabelText('Where the batch is defined');
    expect(defined).toHaveTextContent('Defined in /mnt/batches.yaml');
    expect(within(defined).queryByRole('link')).toBeNull();
  });

  it("opens QA-Board's files in Available Tests, at the batch", () => {
    const onOpen = vi.fn();
    renderWithProviders(<BatchDefinitions
      definitions={[
        { name: 'a', files: ['qa/batches.yaml', 'extra-batches.yml'], sources: ['commit', 'qaboard'] },
        { name: 'b', files: ['bob.yml'], sources: ['qaboard'] },
      ]}
      context={{ ...context, onOpen }}
    />);
    const defined = screen.getByLabelText('Where the batch is defined');
    expect(defined).toHaveTextContent("Defined in qa/batches.yaml, Shared batches and bob's private batches");
    expect(defined).toHaveTextContent('the shared batches override a');
    fireEvent.click(within(defined).getByRole('button', { name: /Shared batches/ }));
    expect(onOpen).toHaveBeenCalledWith({ file: 'extra-batches', batch: 'a' });
    // others' private files can't be opened
    expect(within(defined).queryByRole('button', { name: /bob/ })).toBeNull();
  });

  it("doesn't link the files sent from the command line to the repository", () => {
    renderWithProviders(<BatchDefinitions definitions={[{ name: 'a', files: ['qa/batches.yaml', 'qa/local.yaml'], sources: ['commit', 'sent'] }]} context={context} />);
    const defined = screen.getByLabelText('Where the batch is defined');
    expect(defined).toHaveTextContent('Defined in qa/batches.yaml and qa/local.yaml');
    // the commit's file is in the repository, the sent one may not be
    expect(within(defined).getAllByRole('link').map(link => link.getAttribute('href'))).toEqual(['https://github.com/org/repo/blob/abc/qa/batches.yaml']);
  });

  it('shows nothing without definitions', () => {
    const { container } = renderWithProviders(<BatchDefinitions definitions={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
