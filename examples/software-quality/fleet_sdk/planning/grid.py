"""
A warehouse map: rows of text, `.` free, `#` shelf or wall, `D` a dock (free). Cells are (row, col), row 0 on top.
"""
from dataclasses import dataclass, field

FREE, BLOCKED, DOCK = '.', '#', 'D'


@dataclass
class Grid:
    rows: list
    blocked: set = field(init=False)
    docks: list = field(init=False)

    def __post_init__(self):
        widths = {len(r) for r in self.rows}
        if len(widths) > 1:
            raise ValueError(f"rows of different widths: {sorted(widths)}")
        if not self.rows or not self.rows[0]:
            raise ValueError("empty map")
        unknown = {c for r in self.rows for c in r} - {FREE, BLOCKED, DOCK}
        if unknown:
            raise ValueError(f"unknown cells: {''.join(sorted(unknown))}")
        self.blocked = {(r, c) for r, row in enumerate(self.rows) for c, cell in enumerate(row) if cell == BLOCKED}
        self.docks = [(r, c) for r, row in enumerate(self.rows) for c, cell in enumerate(row) if cell == DOCK]

    @classmethod
    def parse(cls, text: str) -> 'Grid':
        return cls([line.strip() for line in text.strip().splitlines() if line.strip()])

    @property
    def height(self) -> int:
        return len(self.rows)

    @property
    def width(self) -> int:
        return len(self.rows[0])

    def inside(self, cell) -> bool:
        return 0 <= cell[0] < self.height and 0 <= cell[1] < self.width

    def free(self, cell) -> bool:
        return self.inside(cell) and cell not in self.blocked

    def neighbors(self, cell, diagonal=False):
        r, c = cell
        steps = [(-1, 0), (1, 0), (0, -1), (0, 1)]
        if diagonal:
            steps += [(-1, -1), (-1, 1), (1, -1), (1, 1)]
        for dr, dc in steps:
            n = (r + dr, c + dc)
            if not self.free(n):
                continue
            # no corner cutting between two shelves
            if dr and dc and not (self.free((r + dr, c)) and self.free((r, c + dc))):
                continue
            yield n, (1.4142135623730951 if dr and dc else 1.0)

    def with_blocked(self, cells) -> 'Grid':
        rows = [list(r) for r in self.rows]
        for r, c in cells:
            rows[r][c] = BLOCKED
        return Grid([''.join(r) for r in rows])
