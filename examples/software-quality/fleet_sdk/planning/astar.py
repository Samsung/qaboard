"""A* on the warehouse grid, 4- or 8-connected"""
import heapq
import math

from .grid import Grid


class NoPath(Exception):
    pass


def _heuristic(a, b, diagonal):
    dr, dc = abs(a[0] - b[0]), abs(a[1] - b[1])
    if diagonal:
        return (dr + dc) + (math.sqrt(2) - 2) * min(dr, dc)
    return dr + dc


def shortest_path(grid: Grid, start, goal, diagonal=False) -> list:
    """The cells from start to goal, both included. Raises NoPath."""
    for name, cell in (('start', start), ('goal', goal)):
        if not grid.free(cell):
            raise NoPath(f"{name} {cell} is not a free cell")
    if start == goal:
        return [start]
    counter = 0   # ties: first in, first out, so paths don't depend on how cells compare
    frontier = [(_heuristic(start, goal, diagonal), counter, start)]
    came_from = {start: None}
    cost = {start: 0.0}
    while frontier:
        _, _, cell = heapq.heappop(frontier)
        if cell == goal:
            path = [cell]
            while came_from[path[-1]] is not None:
                path.append(came_from[path[-1]])
            return path[::-1]
        for neighbor, step in grid.neighbors(cell, diagonal):
            new_cost = cost[cell] + step
            if new_cost < cost.get(neighbor, math.inf) - 1e-12:
                cost[neighbor] = new_cost
                came_from[neighbor] = cell
                counter += 1
                heapq.heappush(frontier, (new_cost + _heuristic(neighbor, goal, diagonal), counter, neighbor))
    raise NoPath(f"no path from {start} to {goal}")


def path_length(path) -> float:
    return sum(math.dist(a, b) for a, b in zip(path, path[1:]))
