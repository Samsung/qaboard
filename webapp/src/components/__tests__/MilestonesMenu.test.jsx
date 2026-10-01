/**
 * Tests for MilestonesMenu component filter functionality.
 * 
 * Tests the filtering and sorting of milestones in the MilestonesMenu component.
 * Run with: cd webapp && npm test -- MilestonesMenu
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { act } from 'react';

import { MilestonesMenu } from '../milestones';


const mockMilestones = {
  'projA/abc999/default': { 
    commit: 'abc999', 
    branch: 'main', 
    batch: 'default', 
    filter: '',
    label: 'Alpha', 
    notes: 'First release', 
    date: '2024-01-15T10:00:00Z',
    project: 'projA',
    owners: [{user_name: 'alice', full_name: 'Alice User'}],
    committer_name: 'Bob Smith',
  },
  'projA/xyz888/test': {
    commit: 'xyz888', 
    branch: 'develop', 
    batch: 'test',
    filter: 'nightly',
    label: 'Beta', 
    notes: 'Beta release', 
    date: '2024-02-01T10:00:00Z',
    project: 'projA',
  },
  'projB/mno777/default': {
    commit: 'mno777',
    branch: 'feature',
    batch: 'default',
    filter: '',
    label: 'Gamma',
    notes: 'WIP feature',
    date: '2024-03-01T10:00:00Z',
    project: 'projB',
    owners: [{user_name: 'charlie', full_name: 'Charlie User'}],
  },
};

const defaultProps = {
  project: 'projA',
  milestones: mockMilestones,
  title: 'Milestones',
  icon: 'star',
  onSelect: vi.fn(),
  type: 'shared',
};

const typeFilter = async (filterText) => {
  const input = screen.getByPlaceholderText(/filter milestones/i);
  await act(async () => {
    fireEvent.change(input, { target: { value: filterText } });
  });
};

describe('MilestonesMenu filter functionality', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Filtering by label', () => {
    it('filters by exact label match', async () => {
      await act(async () => {
        render(<MilestonesMenu {...defaultProps} />);
      });
      await typeFilter('Alpha');
      expect(screen.getByText('Alpha')).toBeInTheDocument();
    });

    it('filters by unique label only', async () => {
      await act(async () => {
        render(<MilestonesMenu {...defaultProps} />);
      });
      await typeFilter('Gamma');
      expect(screen.getByText('Gamma')).toBeInTheDocument();
      // Should NOT show Alpha/Beta
      expect(screen.queryByText('Alpha')).not.toBeInTheDocument();
      expect(screen.queryByText('Beta')).not.toBeInTheDocument();
    });

    it('is case-insensitive for labels', async () => {
      await act(async () => {
        render(<MilestonesMenu {...defaultProps} />);
      });
      await typeFilter('alpha');
      expect(screen.getByText('Alpha')).toBeInTheDocument();
    });
  });

  describe('Filtering by commit', () => {
    it('filters by commit hash', async () => {
      await act(async () => {
        render(<MilestonesMenu {...defaultProps} />);
      });
      await typeFilter('abc999');
      expect(screen.getByText('Alpha')).toBeInTheDocument();
      // Should NOT match other commits
      expect(screen.queryByText('Beta')).not.toBeInTheDocument();
      expect(screen.queryByText('Gamma')).not.toBeInTheDocument();
    });

    it('filters by unique commit prefix', async () => {
      await act(async () => {
        render(<MilestonesMenu {...defaultProps} />);
      });
      await typeFilter('mno');
      expect(screen.getByText('Gamma')).toBeInTheDocument();
    });
  });

  describe('Filtering by batch', () => {
    it('filters by batch label', async () => {
      await act(async () => {
        render(<MilestonesMenu {...defaultProps} />);
      });
      await typeFilter('test');
      expect(screen.getByText('Beta')).toBeInTheDocument();
    });
  });

  describe('Filtering by filter (metric filter)', () => {
    it('filters by the filter/metric filter field', async () => {
      await act(async () => {
        render(<MilestonesMenu {...defaultProps} />);
      });
      await typeFilter('nightly');
      expect(screen.getByText('Beta')).toBeInTheDocument();
    });
  });

  describe('Filtering by notes', () => {
    it('filters by notes content', async () => {
      await act(async () => {
        render(<MilestonesMenu {...defaultProps} />);
      });
      await typeFilter('First');
      expect(screen.getByText('Alpha')).toBeInTheDocument();
    });

    it('filters by notes partial match', async () => {
      await act(async () => {
        render(<MilestonesMenu {...defaultProps} />);
      });
      await typeFilter('Beta');
      expect(screen.getByText('Beta')).toBeInTheDocument();
    });
  });

  describe('Filtering by owner', () => {
    it('filters by owner user_name', async () => {
      await act(async () => {
        render(<MilestonesMenu {...defaultProps} />);
      });
      await typeFilter('alice');
      expect(screen.getByText('Alpha')).toBeInTheDocument();
    });

    it('filters by owner full_name', async () => {
      await act(async () => {
        render(<MilestonesMenu {...defaultProps} />);
      });
      await typeFilter('Alice');
      expect(screen.getByText('Alpha')).toBeInTheDocument();
    });
  });

  describe('Filtering by committer', () => {
    it('filters by committer_name', async () => {
      await act(async () => {
        render(<MilestonesMenu {...defaultProps} />);
      });
      await typeFilter('Bob');
      expect(screen.getByText('Alpha')).toBeInTheDocument();
    });
  });

  describe('Filtering by project', () => {
    it('filters by project name', async () => {
      await act(async () => {
        render(<MilestonesMenu {...defaultProps} />);
      });
      await typeFilter('projB');
      expect(screen.getByText('Gamma')).toBeInTheDocument();
      // projA milestones should not show
      expect(screen.queryByText('Alpha')).not.toBeInTheDocument();
      expect(screen.queryByText('Beta')).not.toBeInTheDocument();
    });
  });

  describe('No matches', () => {
    it('shows nothing when filter has no matches', async () => {
      await act(async () => {
        render(<MilestonesMenu {...defaultProps} />);
      });
      await typeFilter('unknown123');
      // Should show no milestones
      expect(screen.queryByText('Alpha')).not.toBeInTheDocument();
      expect(screen.queryByText('Beta')).not.toBeInTheDocument();
      expect(screen.queryByText('Gamma')).not.toBeInTheDocument();
    });
  });

  describe('Empty filter', () => {
    it('shows all milestones when filter is empty', async () => {
      await act(async () => {
        render(<MilestonesMenu {...defaultProps} />);
      });
      await typeFilter('');
      expect(screen.getByText('Alpha')).toBeInTheDocument();
      expect(screen.getByText('Beta')).toBeInTheDocument();
    });
  });

  describe('Multiple token filtering', () => {
    it('matches all tokens (AND logic)', async () => {
      // Filter for "Beta" AND "release" - should match Beta (notes contain "release")
      await act(async () => {
        render(<MilestonesMenu {...defaultProps} />);
      });
      await typeFilter('Beta release');
      expect(screen.getByText('Beta')).toBeInTheDocument();
      // Alpha has notes "First release" but doesn't have "Beta"
      expect(screen.queryByText('Alpha')).not.toBeInTheDocument();
    });
  });
});

describe('MilestonesMenu sort functionality', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders without crashing with default sort', async () => {
    await act(async () => {
      render(<MilestonesMenu {...defaultProps} />);
    });
    expect(screen.getByText('Alpha')).toBeInTheDocument();
  });

  it('renders with ascending sort', async () => {
    await act(async () => {
      render(<MilestonesMenu {...defaultProps} />);
    });
    const select = screen.getByRole('combobox');
    await act(async () => {
      fireEvent.change(select, { target: { value: 'date ↑' } });
    });
    expect(screen.getByText('Alpha')).toBeInTheDocument();
  });
});

describe('MilestonesMenu edge cases', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('handles milestones with undefined fields', async () => {
    const milestonesWithMissing = {
      'test/abc/default': {
        commit: 'abc',
      },
    };
    await act(async () => {
      render(<MilestonesMenu {...defaultProps} milestones={milestonesWithMissing} />);
    });
    expect(screen.queryByRole('menuitem')).toBeInTheDocument();
  });

  it('shows filter input when there are multiple milestones', async () => {
    await act(async () => {
      render(<MilestonesMenu {...defaultProps} />);
    });
    expect(screen.getByPlaceholderText(/filter milestones/i)).toBeInTheDocument();
  });

  it('hides filter input when only one milestone', async () => {
    const singleMilestone = {
      'test/abc/default': { commit: 'abc', label: 'Only one' },
    };
    await act(async () => {
      render(<MilestonesMenu {...defaultProps} milestones={singleMilestone} />);
    });
    expect(screen.queryByPlaceholderText(/filter milestones/i)).not.toBeInTheDocument();
  });

  it('handles empty milestones object', async () => {
    await act(async () => {
      render(<MilestonesMenu {...defaultProps} milestones={{}} />);
    });
    expect(screen.queryByRole('menuitem')).not.toBeInTheDocument();
  });
});