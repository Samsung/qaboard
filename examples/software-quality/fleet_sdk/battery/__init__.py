"""State of charge from the cell voltage and the current drawn, and how far a robot can go"""
from .soc import BatteryState, estimate_range_m, soc_from_voltage, update_soc

__all__ = ['BatteryState', 'estimate_range_m', 'soc_from_voltage', 'update_soc']
