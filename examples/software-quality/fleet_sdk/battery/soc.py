"""
The K3's pack: 4 Li-ion cells in series, 20 Ah. At rest, the open-circuit voltage gives the state of charge (SoC); while
driving, coulomb counting follows it from there.
"""
from dataclasses import dataclass

CAPACITY_AH = 20.0
CELLS = 4
# open-circuit voltage per cell (V) -> SoC, from the cells' datasheet curve
OCV_TABLE = [(3.00, 0.00), (3.45, 0.05), (3.60, 0.15), (3.68, 0.30), (3.75, 0.50), (3.85, 0.70), (3.98, 0.85),
             (4.08, 0.95), (4.20, 1.00)]
WH_PER_M = 0.035        # energy to drive one meter, empty, on a flat floor
PAYLOAD_WH_PER_M_KG = 0.0012
NOMINAL_V = 14.8


@dataclass
class BatteryState:
    soc: float              # 0..1
    temperature_c: float = 25.0


def soc_from_voltage(pack_voltage: float) -> float:
    """SoC at rest from the pack's voltage, interpolated in the OCV table, clamped to 0..1"""
    v = pack_voltage / CELLS
    if v <= OCV_TABLE[0][0]:
        return 0.0
    if v >= OCV_TABLE[-1][0]:
        return 1.0
    for (v0, s0), (v1, s1) in zip(OCV_TABLE, OCV_TABLE[1:]):
        if v0 <= v <= v1:
            return s0 + (s1 - s0) * (v - v0) / (v1 - v0)
    raise AssertionError("unreachable")


def capacity_factor(temperature_c: float) -> float:
    """Usable capacity vs 25 °C: Li-ion cells give less in the cold (-1%/°C under 20 °C, at most -40%)"""
    if temperature_c >= 20:
        return 1.0
    return max(0.6, 1.0 - 0.01 * (20 - temperature_c))


def update_soc(state: BatteryState, current_a: float, seconds: float) -> BatteryState:
    """Coulomb counting: current_a > 0 discharges, < 0 charges"""
    if seconds < 0:
        raise ValueError("time goes forward")
    capacity = CAPACITY_AH * capacity_factor(state.temperature_c)
    soc = state.soc - current_a * seconds / 3600 / capacity
    return BatteryState(min(1.0, max(0.0, soc)), state.temperature_c)


def estimate_range_m(state: BatteryState, payload_kg: float = 0.0, reserve: float = 0.15) -> float:
    """How far the robot can drive before reaching its reserve"""
    if payload_kg < 0:
        raise ValueError("negative payload")
    usable = max(0.0, state.soc - reserve) * CAPACITY_AH * capacity_factor(state.temperature_c) * NOMINAL_V
    return usable / (WH_PER_M + PAYLOAD_WH_PER_M_KG * payload_kg)
