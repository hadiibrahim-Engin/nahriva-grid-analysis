"""The illustrative demo must not invent unbalanced dispatch or costs outside maintenance."""

import importlib.util
from decimal import Decimal
from pathlib import Path
from xml.etree import ElementTree as ET

spec = importlib.util.spec_from_file_location('prepare_network_demo', Path(__file__).resolve().parents[2] / 'scripts/prepare_network_demo.py')
demo = importlib.util.module_from_spec(spec)
spec.loader.exec_module(demo)


def test_demo_dispatch_balances_each_hour_and_has_plausible_prices_and_continuous_profiles():
    for scenario in range(6):
        totals = []
        for hour in range(72):
            rows = demo.hourly_dispatch(scenario, 1744351200 + hour * 3600, 160, True)
            assert sum(e for e, _p in rows) == 0
            assert len([e for e, _p in rows if e > 0]) == 3
            assert len([e for e, _p in rows if e < 0]) == 3
            assert all(abs(e) < 150 and 25 < p < 220 for e, p in rows)
            assert sum(e * p for e, p in rows) > 0
            totals.append(sum(e for e, _p in rows if e > 0))
        assert max(totals) - min(totals) > 20
        assert max(abs(a - b) for a, b in zip(totals, totals[1:])) < 25
        # No measure outside maintenance; no unnecessary Redispatch below the congestion threshold.
        assert all(e == Decimal('0.00') and not e.is_signed() for e, _p in demo.hourly_dispatch(scenario, 1744351200, 160, False))
        assert all(e == 0 for e, _p in demo.hourly_dispatch(scenario, 1744351200, 80, True))


def test_demo_voltage_colours_distinguish_transformer_sides_and_are_documented_in_svg():
    svg = ET.fromstring(demo.demo_map_svg())
    nodes = {node.get('id'): node for node in svg.iter()}
    assert nodes['Line_02_-_03'].get('stroke') == '#bd3544'
    transformer = nodes['Trf_02_-_30']
    assert transformer[0].get('stroke') == '#bd3544'
    assert transformer[1].get('stroke') == '#7851a9'
    assert nodes['Bus_30'].get('fill') == '#7851a9'
    assert {node.text for node in nodes['Voltage_legend'] if node.text} == {'345 kV', '230 kV', '138 kV', '16.5 kV'}
