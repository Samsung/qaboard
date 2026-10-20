import pytest

from fleet_sdk.planning import Grid

AISLES = """
D.........
.##.##.##.
.##.##.##.
.##.##.##.
..........
"""


def test_parse():
    grid = Grid.parse(AISLES)
    assert (grid.height, grid.width) == (5, 10)
    assert grid.docks == [(0, 0)]
    assert len(grid.blocked) == 18


@pytest.mark.parametrize('rows,error', [
    (['...', '..'], 'widths'),
    ([], 'empty'),
    (['..x'], 'unknown'),
])
def test_invalid(rows, error):
    with pytest.raises(ValueError, match=error):
        Grid(rows)


@pytest.mark.parametrize('cell,free', [((0, 0), True), ((1, 1), False), ((-1, 0), False), ((4, 9), True), ((5, 0), False)])
def test_free(cell, free):
    assert Grid.parse(AISLES).free(cell) is free


def test_neighbors_4():
    grid = Grid.parse(AISLES)
    assert sorted(n for n, _ in grid.neighbors((0, 1))) == [(0, 0), (0, 2)]


def test_neighbors_8_without_corner_cutting():
    grid = Grid.parse(AISLES)
    assert sorted(n for n, _ in grid.neighbors((4, 0), diagonal=True)) == [(3, 0), (4, 1)]


def test_with_blocked():
    grid = Grid.parse(AISLES).with_blocked([(0, 5)])
    assert not grid.free((0, 5))
    assert Grid.parse(AISLES).free((0, 5))
