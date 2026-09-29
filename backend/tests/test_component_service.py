"""ComponentService dedupes NULL ids that previously collapsed React keys."""

from __future__ import annotations

from typing import Iterable

import pytest

from app.core.errors import ResourceNotFoundError
from app.services.component_service import ComponentService


class FakeRepo:
    def __init__(
        self,
        *,
        facilities: Iterable[tuple] = (),
        components_by_facility: Iterable[tuple] = (),
        all_components: Iterable[tuple] = (),
    ) -> None:
        self._facilities = list(facilities)
        self._components_by_facility = list(components_by_facility)
        self._all_components = list(all_components)

    def list_facilities(self):
        return self._facilities

    def list_components_by_facility(self, _facility_id: str):
        return self._components_by_facility

    def list_all_components(self):
        return self._all_components


def test_facilities_drop_null_id_and_dedupe():
    repo = FakeRepo(facilities=[
        ("A1", "Werk Nord"),
        (None, "Was-auch-immer"),
        ("A1", "Werk Nord (dup)"),
        ("A2", None),  # NULL name should fall back to id
    ])
    result = ComponentService(repo).list_facilities()
    ids = [f.id for f in result]
    assert ids == ["A1", "A2"]
    assert result[1].name == "A2"  # fallback when name is NULL


def test_components_drop_null_fnr_and_dedupe():
    repo = FakeRepo(components_by_facility=[
        ("F1", "Trafo 1", "MS"),
        (None, "Geist", None),       # NULL FELDNUMMER -> dropped
        ("F1", "Trafo 1 dup", "MS"), # duplicate id -> dropped
        ("F2", None, "NS"),          # NULL name -> falls back to id
    ])
    result = ComponentService(repo).list_components_by_facility("A1")
    ids = [c.id for c in result]
    assert ids == ["A1_F1", "A1_F2"]
    assert len(set(ids)) == len(ids)  # all keys unique
    assert result[1].name == "A1_F2"


def test_components_empty_repo_raises_not_found():
    with pytest.raises(ResourceNotFoundError):
        ComponentService(FakeRepo()).list_components_by_facility("A1")


def test_all_components_skips_null_anr_or_fnr():
    repo = FakeRepo(all_components=[
        ("A1", "F1", "Trafo", "Werk", "MS"),
        (None, "F2", "Trafo", "Werk", "MS"),  # NULL anr -> dropped
        ("A2", None, "Trafo", "Werk", "MS"),  # NULL fnr -> dropped
        ("A1", "F1", "dup", "Werk", "MS"),    # duplicate -> dropped
    ])
    result = ComponentService(repo).list_all_components()
    assert [c.id for c in result] == ["A1_F1"]
