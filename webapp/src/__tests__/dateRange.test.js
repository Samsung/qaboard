import { day_range, restore_date_ranges } from '../dateRange'


describe('day_range', () => {
  it('spans whole days without mutating its input', () => {
    const from = new Date(2026, 9, 1, 15, 30)
    const to = new Date(2026, 9, 3, 8, 0)
    const [start, end] = day_range([from, to])
    expect(start).toEqual(new Date(2026, 9, 1, 0, 0, 0, 0))
    expect(end).toEqual(new Date(2026, 9, 3, 23, 59, 59, 999))
    expect(from).toEqual(new Date(2026, 9, 1, 15, 30))
  })

  it('accepts the ISO strings redux-persist rehydrates', () => {
    const range = JSON.parse(JSON.stringify([new Date(2026, 9, 1, 15), new Date(2026, 9, 3, 8)]))
    const [start, end] = day_range(range)
    expect(start).toEqual(new Date(2026, 9, 1, 0, 0, 0, 0))
    expect(end).toEqual(new Date(2026, 9, 3, 23, 59, 59, 999))
  })
})


describe('restore_date_ranges', () => {
  it('turns persisted date ranges back into Dates', () => {
    const from = new Date(2026, 9, 1)
    const to = new Date(2026, 9, 3)
    const persisted = JSON.parse(JSON.stringify({
      data: { 'group/project': { commits: { develop: { ids: ['a'], date_range: [from, to] } } } },
    }))
    const restored = restore_date_ranges(persisted)
    const commits_data = restored.data['group/project'].commits.develop
    expect(commits_data.date_range).toEqual([from, to])
    expect(commits_data.date_range[0]).toBeInstanceOf(Date)
    expect(commits_data.ids).toEqual(['a'])
  })

  it('replaces incomplete ranges with the default range', () => {
    const persisted = { data: { p: { commits: { develop: { date_range: ['2026-10-01T00:00:00.000Z', null] } } } } }
    const [start, end] = restore_date_ranges(persisted).data.p.commits.develop.date_range
    expect(start).toBeInstanceOf(Date)
    expect(end).toBeInstanceOf(Date)
    expect(isNaN(start) || isNaN(end)).toBe(false)
  })

  it('leaves state without commit lists alone', () => {
    expect(restore_date_ranges(undefined)).toBe(undefined)
    const state = { data: { p: { data: {} } } }
    expect(restore_date_ranges(state)).toEqual(state)
  })
})
