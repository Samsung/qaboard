/**
 * Avatars fall back to initials, on a color derived from the name, when there is no picture or it fails to load.
 * Run with: cd webapp && npm test -- avatars
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

import { Avatar, CommitAvatar, ProjectAvatar, avatar_colors, avatarColor, initials, initialsImage } from '../avatars';


// What the fallback image shows
const svg = (img: HTMLElement) => decodeURIComponent(img.getAttribute('src')!.replace('data:image/svg+xml,', ''));

// WCAG 2 contrast ratio
const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(c => c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
};


describe('initials', () => {
  it('uses the first and last names', () => {
    expect(initials('Alice Martin')).toBe('AM');
    expect(initials('jean-pierre de la fontaine')).toBe('JF');
    expect(initials('alice.martin')).toBe('AM');
    expect(initials('alice.martin@example.com')).toBe('AM');
    expect(initials('alice')).toBe('A');
    expect(initials('  Élodie  (QA) ')).toBe('ÉQ');
  });

  it('can use only the first name', () => {
    expect(initials('Alice Martin', 1)).toBe('A');
  });

  it('uses the last part of project ids', () => {
    expect(initials('group/repo')).toBe('R');
    expect(initials('dvs/psp_swip')).toBe('PS');
  });

  it('is empty without a name', () => {
    expect(initials(undefined)).toBe('');
    expect(initials('')).toBe('');
    expect(initials(' - ')).toBe('');
  });
});


describe('avatarColor', () => {
  it('is the same for the same name, wherever it shows', () => {
    expect(avatarColor('Alice Martin')).toBe(avatarColor(' alice martin'));
    expect(avatar_colors).toContain(avatarColor('Alice Martin'));
    const names = ['Alice', 'Bob', 'Carol', 'Dave', 'Erin', 'Frank', 'Grace', 'Heidi', 'Ivan', 'Judy'];
    expect(new Set(names.map(avatarColor)).size).toBeGreaterThan(4);
  });

  it('is gray without a name', () => {
    expect(avatar_colors).not.toContain(avatarColor(''));
    expect(avatarColor(null)).toBe(avatarColor(''));
  });

  it('keeps white initials readable', () => {
    for (const color of avatar_colors)
      expect(contrast(color, '#ffffff')).toBeGreaterThanOrEqual(4.5);
  });
});


describe('Avatar', () => {
  it('shows the picture', () => {
    render(<Avatar name="Alice Martin" src="/alice.png" />);
    expect(screen.getByRole('img', { name: 'Alice Martin' })).toHaveAttribute('src', '/alice.png');
  });

  it('shows initials without a picture', () => {
    render(<Avatar name="Alice Martin" />);
    const img = screen.getByRole('img', { name: 'Alice Martin' });
    expect(img).toHaveAttribute('src', initialsImage('Alice Martin'));
    expect(img).toHaveAttribute('title', 'Alice Martin');
    expect(svg(img)).toContain('>AM</text>');
    expect(svg(img)).toContain(`fill="${avatarColor('Alice Martin')}"`);
  });

  it('shows a single letter on small avatars', () => {
    render(<Avatar name="Alice Martin" size="20px" />);
    expect(svg(screen.getByRole('img', { name: 'Alice Martin' }))).toContain('>A</text>');
  });

  it('shows initials when the picture fails to load, and retries new pictures', () => {
    const { rerender } = render(<Avatar name="Alice Martin" src="/broken.png" img_style={{ filter: 'hue-rotate(90deg)' }} />);
    const img = screen.getByRole('img', { name: 'Alice Martin' });
    fireEvent.error(img);
    expect(img).toHaveAttribute('src', initialsImage('Alice Martin'));
    expect(img.style.filter).toBe('');
    rerender(<Avatar name="Alice Martin" src="/alice.png" />);
    expect(img).toHaveAttribute('src', '/alice.png');
  });

  it('links to pages of the app', () => {
    const onClick = vi.fn<() => void>();
    render(<MemoryRouter><Avatar name="Alice" href="/group/repo/committer/Alice" onClick={onClick} /></MemoryRouter>);
    const link = screen.getByRole('link', { name: 'Alice' });
    expect(link).toHaveAttribute('href', '/group/repo/committer/Alice');
    fireEvent.click(link);
    expect(onClick).toHaveBeenCalled();
  });
});


describe('CommitAvatar', () => {
  it("links to the committer's commits, and loads avatars through the backend", () => {
    const commit = { committer_name: 'Alice', committer_avatar_url: 'https://gitlab.example.com/avatar.png?width=90&s=1' };
    render(<MemoryRouter><CommitAvatar commit={commit} project="group/repo" /></MemoryRouter>);
    expect(screen.getByRole('link', { name: 'Alice' })).toHaveAttribute('href', '/group/repo/committer/Alice');
    expect(screen.getByRole('img', { name: 'Alice' })).toHaveAttribute('src', '/api/v1/git/proxy?url=https%3A%2F%2Fgitlab.example.com%2Favatar.png%3Fwidth%3D90%26s%3D1');
  });

  it('has no link while the commit loads', () => {
    const { container } = render(<CommitAvatar commit={undefined} project="group/repo" />);
    expect(screen.queryByRole('link')).toBeNull();
    expect(container.querySelector('img')).toHaveAttribute('src', initialsImage(''));
  });
});


describe('ProjectAvatar', () => {
  const git = { path_with_namespace: 'group/repo', avatar_url: 'https://gitlab.example.com/repo.png' };

  it("uses the repository's avatar, tinted for subprojects", () => {
    const { rerender } = render(<ProjectAvatar project="group/repo" data={{ git }} />);
    expect(screen.getByRole('img', { name: 'group/repo' })).toHaveAttribute('src', '/api/v1/git/proxy?url=https%3A%2F%2Fgitlab.example.com%2Frepo.png');
    expect(screen.getByRole('img').style.filter).toBe('');
    rerender(<ProjectAvatar project="group/repo/sub" data={{ git }} />);
    expect(screen.getByRole('img', { name: 'group/repo/sub' }).style.filter).toContain('hue-rotate');
  });

  it('prefers the avatar from qaboard.yaml', () => {
    render(<ProjectAvatar project="group/repo/sub" data={{ git, qatools_config: { project: { avatar_url: 'https://cdn.example.com/sub.png' } } }} />);
    const img = screen.getByRole('img', { name: 'group/repo/sub' });
    expect(img).toHaveAttribute('src', '/api/v1/git/proxy?url=https%3A%2F%2Fcdn.example.com%2Fsub.png');
    expect(img.style.filter).toBe('');
  });

  it('shows initials without git data', () => {
    render(<ProjectAvatar project="group/repo" data={undefined} />);
    expect(svg(screen.getByRole('img', { name: 'group/repo' }))).toContain('>R</text>');
  });
});
