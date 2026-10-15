/**
 * Light and dark themes: users pick system, light or dark, Blueprint's dark class goes on <html>.
 * Run with: cd webapp && npm test -- theme
 */
import { act, fireEvent, render, screen } from '@testing-library/react';

import { ThemeSync, resolveTheme } from '../theme';
import { ThemeButton } from '../components/ThemeButton';
import { applyTemplate, dark_template } from '../components/PlotlyPlot';
import { usePrefsStore } from '../stores/prefs';


describe('resolveTheme', () => {
  it('follows the system unless users chose', () => {
    expect(resolveTheme('system', true)).toBe('dark')
    expect(resolveTheme('system', false)).toBe('light')
    expect(resolveTheme(undefined, true)).toBe('dark')
    expect(resolveTheme('light', true)).toBe('light')
    expect(resolveTheme('dark', false)).toBe('dark')
  })
})


describe('ThemeButton', () => {
  afterEach(() => act(() => usePrefsStore.setState({ theme: 'system' })))

  it('cycles through system, light and dark, and puts the dark class on <html>', () => {
    render(<><ThemeSync/><ThemeButton/></>)
    const button = () => screen.getByRole('button')
    expect(button()).toHaveAccessibleName(/Theme: Same as your system. Switch to Light/)
    fireEvent.click(button())
    expect(usePrefsStore.getState().theme).toBe('light')
    expect(document.documentElement).not.toHaveClass('bp6-dark')
    fireEvent.click(button())
    expect(usePrefsStore.getState().theme).toBe('dark')
    expect(document.documentElement).toHaveClass('bp6-dark')
    fireEvent.click(button())
    expect(usePrefsStore.getState().theme).toBe('system')
  })
})


describe('applyTemplate', () => {
  it("gives dark defaults to figures without a template, and removes only ours", () => {
    const layout = {}
    applyTemplate(layout, true)
    expect(layout.template).toBe(dark_template)
    applyTemplate(layout, false)
    expect(layout.template).toBeUndefined()

    const custom = { template: 'plotly_white' }
    applyTemplate(custom, true)
    applyTemplate(custom, false)
    expect(custom.template).toBe('plotly_white')
  })
})
