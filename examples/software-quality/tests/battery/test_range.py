import pytest

from fleet_sdk.battery import BatteryState, estimate_range_m
from fleet_sdk.battery.soc import capacity_factor


@pytest.mark.parametrize('soc', [0.0, 0.1, 0.15])
def test_no_range_under_the_reserve(soc):
    assert estimate_range_m(BatteryState(soc)) == 0


@pytest.mark.parametrize('soc', [0.2, 0.4, 0.6, 0.8, 1.0])
def test_range_grows_with_charge(soc):
    assert estimate_range_m(BatteryState(soc)) < estimate_range_m(BatteryState(soc + 0.05)) or soc == 1.0


def test_full_battery_empty_robot():
    # 0.85 x 20 Ah x 14.8 V / 0.035 Wh/m
    assert estimate_range_m(BatteryState(1.0)) == pytest.approx(7188.57, rel=1e-4)


@pytest.mark.parametrize('payload_kg', [0, 5, 10, 25, 50])
def test_payload_shortens_range(payload_kg):
    empty = estimate_range_m(BatteryState(0.8))
    assert estimate_range_m(BatteryState(0.8), payload_kg) <= empty


@pytest.mark.parametrize('temperature_c,factor', [(25, 1.0), (20, 1.0), (10, 0.9), (0, 0.8), (-10, 0.7), (-30, 0.6)])
def test_cold(temperature_c, factor):
    assert capacity_factor(temperature_c) == pytest.approx(factor)


def test_cold_warehouse_range():
    assert estimate_range_m(BatteryState(0.8, temperature_c=2)) == pytest.approx(0.82 * estimate_range_m(BatteryState(0.8)))


def test_negative_payload():
    with pytest.raises(ValueError):
        estimate_range_m(BatteryState(0.5), -1)
