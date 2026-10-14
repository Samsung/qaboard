/**
 * Tests for the warning about a commit's missing artifacts.
 * Run with: cd webapp && npm test -- ArtifactsCallout
 */
import { screen, fireEvent } from '@testing-library/react';
import { renderWithProviders } from '../../test-utils';

const alice = { is_logged: true, user_name: 'alice' };
const render = (ui, options) => renderWithProviders(ui, { user: alice, ...options });

import { ArtifactsCallout } from '../ArtifactsCallout';


describe('ArtifactsCallout', () => {
  it('renders nothing when the artifacts are fine', () => {
    const { container } = render(<ArtifactsCallout deleted={false} artifacts={{ok: true, problems: []}} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing for commits whose artifacts were never saved', () => {
    const { container } = render(<ArtifactsCallout deleted={false} artifacts={{ok: false, exists: false, problems: ['The artifacts folder does not exist: /x']}} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('only warns when some files are missing', () => {
    render(<ArtifactsCallout deleted={false} artifacts={{ok: true, exists: true, problems: [], warnings: ['1 artifacts listed in the manifests are missing, like build/bin/tool']}} />)
    expect(screen.getByText("Some of this commit's artifacts are missing")).toBeInTheDocument()
    expect(screen.getByText(/You can still redo runs/)).toBeInTheDocument()
  })

  it('warns about artifacts deleted behind QA-Board\'s back', () => {
    const problems = ["The subproject's qaboard.yaml is missing from /x: runs would use the parent project's configuration, and be saved in the wrong project."]
    render(<ArtifactsCallout deleted={false} artifacts={{ok: false, problems}} onRestore={() => {}} />)
    expect(screen.getByText("This commit's artifacts are incomplete")).toBeInTheDocument()
    expect(screen.getByText(problems[0])).toBeInTheDocument()
    expect(screen.getByText('recreate_artifacts').closest('a')).toHaveAttribute('href', '/docs/storage/deleting-old-data#recreating-artifacts')
    expect(screen.getByText('Restore the artifacts')).toBeInTheDocument()
  })

  it('says who deleted them, and offers to recreate them', () => {
    const onRestore = vi.fn()
    render(<ArtifactsCallout
      deleted
      artifacts={{ok: false, problems: ["The artifacts were deleted."], recreate: 'the GitlabCI job "build"', deletion: {at: '2026-10-01T10:00:00+00:00', by: 'garbage collection'}}}
      onRestore={onRestore}
    />)
    expect(screen.getByText("This commit's artifacts were deleted")).toBeInTheDocument()
    expect(screen.getByText(/by garbage collection/)).toBeInTheDocument()
    expect(screen.queryByText("The artifacts were deleted.")).not.toBeInTheDocument()
    fireEvent.click(screen.getByText('Recreate the artifacts'))
    expect(onRestore).toHaveBeenCalled()
  })

  it('shows a recreation in progress', () => {
    render(<ArtifactsCallout
      deleted
      artifacts={{ok: false, problems: [], recreate: 'the Jenkins job http://jenkins/job/x', recreation: {status: 'triggered', via: 'the Jenkins job http://jenkins/job/x', at: new Date().toISOString(), web_url: 'http://jenkins/job/x/12'}}}
      onRestore={() => {}}
    />)
    expect(screen.getByText("This commit's artifacts are being recreated")).toBeInTheDocument()
    expect(screen.getByText('Follow the build')).toHaveAttribute('href', 'http://jenkins/job/x/12')
  })

  it('asks logged-out users to log in', () => {
    render(<ArtifactsCallout deleted artifacts={{ok: false, problems: []}} onRestore={() => {}} />, { user: { is_logged: false } })
    expect(screen.getByText('Restore the artifacts').closest('button')).toBeDisabled()
    expect(screen.getByText('Log in')).toBeInTheDocument()
  })

  it('shows configuration errors', () => {
    render(<ArtifactsCallout deleted artifacts={{ok: false, problems: [], recreate: 'a webhook to ci', recreate_errors: ['Unknown variable ${commit.sha}.']}} />)
    expect(screen.getByText(/Unknown variable/)).toBeInTheDocument()
  })
})
