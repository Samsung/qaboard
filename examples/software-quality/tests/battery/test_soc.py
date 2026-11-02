import pytest

from fleet_sdk.battery import BatteryState, soc_from_voltage, update_soc
from fleet_sdk.battery.soc import CELLS, OCV_TABLE


@pytest.mark.parametrize('cell_v,soc', OCV_TABLE)
def test_table_points(cell_v, soc):
    assert soc_from_voltage(cell_v * CELLS) == pytest.approx(soc)


@pytest.mark.parametrize('pack_v,soc', [(10.0, 0.0), (12.0, 0.0), (16.8, 1.0), (18.0, 1.0)])
def test_clamped(pack_v, soc):
    assert soc_from_voltage(pack_v) == soc


def test_monotonic():
    values = [soc_from_voltage(12.0 + i * 0.01) for i in range(481)]
    assert values == sorted(values)


@pytest.mark.parametrize('current_a,seconds,expected', [(20, 3600, 0.0), (10, 3600, 0.5), (0, 3600, 1.0), (2, 1800, 0.95)])
def test_discharge(current_a, seconds, expected):
    assert update_soc(BatteryState(1.0), current_a, seconds).soc == pytest.approx(expected)


def test_charge_is_clamped():
    assert update_soc(BatteryState(0.9), -20, 3600).soc == 1.0


def test_time_goes_forward():
    with pytest.raises(ValueError):
        update_soc(BatteryState(0.5), 1, -1)
