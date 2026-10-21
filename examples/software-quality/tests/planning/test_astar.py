import pytest

from fleet_sdk.planning import Grid, NoPath, path_length, shortest_path

AISLES = Grid.parse("""
D.........
.##.##.##.
.##.##.##.
.##.##.##.
..........
""")


def is_valid(grid, path, diagonal=False):
    return all(grid.free(c) for c in path) and all(
        b in [n for n, _ in grid.neighbors(a, diagonal)] for a, b in zip(path, path[1:]))


@pytest.mark.parametrize('goal,length', [((0, 0), 0), ((0, 9), 9), ((4, 9), 13), ((4, 0), 4), ((2, 3), 5), ((3, 9), 12)])
def test_lengths_4(goal, length):
    path = shortest_path(AISLES, (0, 0), goal)
    assert is_valid(AISLES, path)
    assert path_length(path) == pytest.approx(length)


@pytest.mark.parametrize('goal', [(4, 9), (2, 6), (3, 3)])
def test_diagonal_is_not_longer(goal):
    straight = path_length(shortest_path(AISLES, (0, 0), goal))
    diagonal = shortest_path(AISLES, (0, 0), goal, diagonal=True)
    assert is_valid(AISLES, diagonal, diagonal=True)
    assert path_length(diagonal) <= straight + 1e-9


def test_blocked_goal():
    with pytest.raises(NoPath, match='not a free cell'):
        shortest_path(AISLES, (0, 0), (1, 1))


def test_unreachable():
    walled = AISLES.with_blocked([(0, 1), (1, 0)])
    with pytest.raises(NoPath, match='no path'):
        shortest_path(walled, (0, 0), (4, 9))


def test_detour_around_a_pallet():
    blocked = AISLES.with_blocked([(4, 4)])
    path = shortest_path(blocked, (4, 0), (4, 9))
    assert (4, 4) not in path
    assert path_length(path) == 17   # up the aisle at column 3, back down at column 6


def test_big_warehouse():
    """200 x 200 cells, a shelf every third row: the slowest planning test"""
    rows = ['.' * 200 if r % 3 else '.' + '#' * 198 + '.' for r in range(200)]
    grid = Grid(rows)
    path = shortest_path(grid, (0, 0), (199, 199), diagonal=True)
    assert is_valid(grid, path, diagonal=True)
    assert path_length(path) >= 199


def test_random_maps_match_bfs(rng):
    for _ in range(20):
        rows = [''.join('#' if rng.random() < 0.25 else '.' for _ in range(12)) for _ in range(8)]
        rows[0] = '.' + rows[0][1:]
        rows[-1] = rows[-1][:-1] + '.'
        grid = Grid(rows)
        try:
            path = shortest_path(grid, (0, 0), (7, 11))
        except NoPath:
            path = None
        assert (path is None) == (bfs(grid, (0, 0), (7, 11)) is None)
        if path:
            assert len(path) - 1 == bfs(grid, (0, 0), (7, 11))


def bfs(grid, start, goal):
    seen, frontier, steps = {start}, [start], 0
    while frontier:
        if goal in frontier:
            return steps
        frontier = [n for c in frontier for n, _ in grid.neighbors(c) if not (n in seen or seen.add(n))]
        steps += 1
    return None
