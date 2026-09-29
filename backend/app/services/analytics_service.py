"""Analytics use cases for FDWH measurements."""

from __future__ import annotations

import math
from collections import defaultdict
from datetime import datetime

from app.core.constants import (
    BOXPLOT_GROUP_BY_OPTIONS,
    CORRELATION_SAMPLE_POINTS,
    DEFAULT_EXCEEDANCE_THRESHOLD,
    DEFAULT_EXPECTED_POINTS_PER_DAY,
    DEFAULT_POWER_FACTOR_DOWNSAMPLE_MINUTES,
    DURATION_CURVE_MAX_POINTS,
    EXCEEDANCE_INTERVAL_MINUTES,
    POWER_FACTOR_EPSILON,
    POWER_FACTOR_HISTOGRAM_BINS,
    QUALITY_MEASUREMENT_TYPES,
    SEASON_MEASUREMENT_TYPES,
    SEASON_MONTH_LABELS,
    TOP_EXCEEDANCE_DAYS,
    VOLTAGE_BAND_REFERENCE_DATE,
    WEEKDAY_LABELS,
)
from app.core.cache import cached as _cached
from app.core.errors import InvalidRequestError, ResourceNotFoundError
from app.models.models import fdwh_unit
from app.models.schemas import (
    BandPoint,
    BoxPlotItem,
    BoxPlotResponse,
    CorrelationMatrixResponse,
    CorrelationPoint,
    CorrelationScatterResponse,
    DSTEvent,
    DSTResponse,
    DailyProfilePoint,
    DailyProfileResponse,
    DurationCurvePoint,
    DurationCurveResponse,
    ExceedanceDay,
    ExceedanceResponse,
    HeatmapCell,
    HeatmapResponse,
    PowerFactorPoint,
    PowerFactorResponse,
    QualityDayCount,
    QualityGapCell,
    QualityResponse,
    SeasonRadarResponse,
    SeasonRadarSeries,
    VoltageBandResponse,
)
from app.repositories.fdwh_repository import FDWHRepository
from app.services.common import (
    component_window_params,
    normalize_measurement_type,
    split_component_id,
)


def _finite_or_none(value: object) -> float | None:
    """Coerce a raw measurement to a finite float, else None.

    A measurement is only usable if it is present AND finite. `None`, `NaN`
    and `±Infinity` all collapse to `None` so that downstream math can SKIP
    the value instead of silently treating it as `0.0` (which would fabricate
    a wrong result) or letting a non-finite value leak into the response.
    """
    if value is None:
        return None
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def _interpret_correlation(r: float, type_x: str, type_y: str, lag_minutes: int) -> str:
    """Return a short German hint for the Korrelation panel.

    Driven off |r| + sign, plus a P/Q-specific note when both inputs are
    active/reactive power (the most common case operators care about).
    """
    abs_r = abs(r)
    if abs_r >= 0.8:
        strength = "Starke Kopplung — die Größen folgen gemeinsamer Dynamik"
    elif abs_r >= 0.5:
        strength = "Mäßige Kopplung — gemeinsamer Trend, aber andere Einflüsse"
    elif abs_r >= 0.3:
        strength = "Schwache Kopplung"
    else:
        strength = "Keine nennenswerte Kopplung — wahrscheinlich unabhängig"

    sign_hint = " (gegenläufig)" if r < -0.3 else ""

    types = {type_x, type_y}
    domain_hint = ""
    if types == {"P", "Q"} and abs_r >= 0.5:
        if r > 0:
            domain_hint = " · Blindleistung folgt der Wirklast — induktive Last dominiert"
        else:
            domain_hint = " · Blindleistung gegenläufig zur Wirklast — Kompensation aktiv"
    elif types == {"P", "U"} and abs_r >= 0.5 and r < 0:
        domain_hint = " · Spannung fällt mit Lastanstieg — Spannungseinbruch unter Last"

    lag_hint = ""
    if lag_minutes:
        direction = "voraus" if lag_minutes > 0 else "nach"
        lag_hint = f" · Verschiebung {abs(lag_minutes)} min {direction}"

    return f"{strength}{sign_hint}{domain_hint}{lag_hint}"


class AnalyticsService:
    def __init__(self, repository: FDWHRepository) -> None:
        self._repository = repository

    @_cached
    def get_heatmap(
        self,
        component_id: str,
        measurement_type: str,
        start: datetime | None,
        end: datetime | None,
    ) -> HeatmapResponse:
        normalized_type = normalize_measurement_type(measurement_type)
        rows = self._repository.heatmap(
            normalized_type,
            component_window_params(component_id, start, end),
        )
        data = [
            HeatmapCell(day_of_week=int(row[0]), hour=int(row[1]), value=round(float(row[2]), 3))
            for row in rows
        ]
        return HeatmapResponse(
            component_name=self._component_name(component_id),
            measurement_type=normalized_type,
            unit=fdwh_unit(normalized_type),
            data=data,
        )

    @_cached
    def get_voltage_band(
        self,
        component_id: str,
        start: datetime | None,
        end: datetime | None,
    ) -> VoltageBandResponse:
        params = component_window_params(component_id, start, end)
        rows = self._repository.voltage_band_combined(params)
        weekday: list[BandPoint] = []
        weekend: list[BandPoint] = []
        for is_weekend, time_slot, min_val, avg_val, max_val in rows:
            point = BandPoint(
                timestamp=f"{VOLTAGE_BAND_REFERENCE_DATE}T{time_slot}:00",
                min=round(min_val, 4),
                mean=round(avg_val, 4),
                max=round(max_val, 4),
            )
            (weekend if int(is_weekend) == 1 else weekday).append(point)
        return VoltageBandResponse(
            component_name=self._component_name(component_id),
            unit=fdwh_unit("U"),
            weekday=weekday,
            weekend=weekend,
        )

    @_cached
    def get_duration_curve(
        self,
        component_id: str,
        measurement_type: str,
        start: datetime | None,
        end: datetime | None,
    ) -> DurationCurveResponse:
        normalized_type = normalize_measurement_type(measurement_type)
        rows = self._repository.duration_curve(
            normalized_type,
            component_window_params(component_id, start, end),
        )
        total = len(rows)
        step = max(1, total // DURATION_CURVE_MAX_POINTS) if total else 1
        data = [
            DurationCurvePoint(percent=round(index / total * 100, 2), value=round(rows[index][0], 3))
            for index in range(0, total, step)
        ] if total else []

        return DurationCurveResponse(
            component_name=self._component_name(component_id),
            measurement_type=normalized_type,
            unit=fdwh_unit(normalized_type),
            data=data,
        )

    @_cached
    def get_daily_profile(
        self,
        component_id: str,
        measurement_type: str,
        start: datetime | None,
        end: datetime | None,
    ) -> DailyProfileResponse:
        normalized_type = normalize_measurement_type(measurement_type)
        params = component_window_params(component_id, start, end)
        rows = self._repository.daily_profile_combined(normalized_type, params)
        weekday: list[DailyProfilePoint] = []
        weekend: list[DailyProfilePoint] = []
        for is_weekend, hour_fraction, average, count, average_square in rows:
            std_dev = None
            if count and count > 1 and average_square is not None:
                avg = float(average)
                variance = float(average_square) - avg * avg
                std_dev = round(max(0.0, variance) ** 0.5, 3)
            point = DailyProfilePoint(
                hour=round(hour_fraction, 2),
                value=round(average, 3),
                std_dev=std_dev,
            )
            (weekend if int(is_weekend) == 1 else weekday).append(point)
        return DailyProfileResponse(
            component_name=self._component_name(component_id),
            measurement_type=normalized_type,
            unit=fdwh_unit(normalized_type),
            weekday_avg=weekday,
            weekend_avg=weekend,
        )

    @_cached
    def get_correlation(
        self,
        component_id: str,
        type_x: str,
        type_y: str,
        start: datetime | None,
        end: datetime | None,
        lag_minutes: int = 0,
    ) -> CorrelationScatterResponse:
        normalized_x = normalize_measurement_type(type_x)
        normalized_y = normalize_measurement_type(type_y)
        rows = self._repository.correlation_scatter(
            normalized_x,
            normalized_y,
            component_window_params(component_id, start, end),
        )
        if not rows:
            raise ResourceNotFoundError("Keine Daten für diese Kombination")

        x_values = [float(row[0]) for row in rows]
        y_values = [float(row[1]) for row in rows]

        # Sample cadence is 15 min; translate the requested minute-offset
        # into an integer sample shift. Positive lag → Y leads X (compare
        # x[t] with y[t+lag]). Negative lag → Y lags X.
        shift = lag_minutes // 15 if lag_minutes else 0
        if shift > 0:
            x_aligned = x_values[:-shift] if shift < len(x_values) else []
            y_aligned = y_values[shift:]
        elif shift < 0:
            k = -shift
            x_aligned = x_values[k:]
            y_aligned = y_values[:-k] if k < len(y_values) else []
        else:
            x_aligned = x_values
            y_aligned = y_values

        if not x_aligned or not y_aligned:
            raise ResourceNotFoundError("Verschiebung übersteigt den Datenbereich")

        correlation = self._pearson(x_aligned, y_aligned)
        step = max(1, len(rows) // CORRELATION_SAMPLE_POINTS)
        data = [
            CorrelationPoint(x=round(rows[index][0], 3), y=round(rows[index][1], 3))
            for index in range(0, len(rows), step)
        ]
        interpretation = _interpret_correlation(correlation, normalized_x, normalized_y, lag_minutes)
        return CorrelationScatterResponse(
            component_name=self._component_name(component_id),
            type_x=normalized_x,
            unit_x=fdwh_unit(normalized_x),
            type_y=normalized_y,
            unit_y=fdwh_unit(normalized_y),
            correlation=round(correlation, 4),
            lag_minutes=lag_minutes,
            interpretation=interpretation,
            data=data,
        )

    # Fixed column order of the correlation_matrix_corr() result row.
    _CORR_PAIR_ORDER = (
        ("P", "Q"), ("P", "S"), ("P", "U"), ("P", "I"),
        ("Q", "S"), ("Q", "U"), ("Q", "I"),
        ("S", "U"), ("S", "I"),
        ("U", "I"),
    )

    @_cached
    def get_correlation_matrix(
        self,
        component_id: str,
        types: str,
        start: datetime | None,
        end: datetime | None,
    ) -> CorrelationMatrixResponse:
        requested = [normalize_measurement_type(item.strip()) for item in types.split(",") if item.strip()]
        valid = {"P", "Q", "S", "U", "I"}
        available = [t for t in requested if t in valid]
        if len(available) < 2:
            raise ResourceNotFoundError("Weniger als 2 Messgrößen verfügbar")

        row = self._repository.correlation_matrix_corr(
            component_window_params(component_id, start, end),
        )
        if not row or all(value is None for value in row):
            raise ResourceNotFoundError("Keine Daten vorhanden")

        pair_values: dict[tuple[str, str], float] = {}
        for (a, b), value in zip(self._CORR_PAIR_ORDER, row):
            if value is None:
                continue
            v = round(float(value), 4)
            pair_values[(a, b)] = v
            pair_values[(b, a)] = v

        # A missing pair stays None (no data) rather than 0.0 — a fabricated
        # "zero correlation" is indistinguishable from a real one in the plot.
        matrix = [
            [1.0 if a == b else pair_values.get((a, b)) for b in available]
            for a in available
        ]
        return CorrelationMatrixResponse(
            component_name=self._component_name(component_id),
            types=available,
            units=[fdwh_unit(measurement_type) for measurement_type in available],
            matrix=matrix,
        )

    @_cached
    def get_boxplot(
        self,
        component_id: str,
        measurement_type: str,
        start: datetime | None,
        end: datetime | None,
        group_by: str = "hour",
    ) -> BoxPlotResponse:
        if group_by not in BOXPLOT_GROUP_BY_OPTIONS:
            raise InvalidRequestError(
                f"group_by must be one of {BOXPLOT_GROUP_BY_OPTIONS}, got {group_by!r}"
            )
        normalized_type = normalize_measurement_type(measurement_type)
        params = component_window_params(component_id, start, end)

        if group_by == "hour":
            # Only 'hour' has a DuckDB fast-path twin — keep it on its own
            # repository method so that routing is unaffected.
            rows = self._repository.boxplot_hourly(normalized_type, params)
        else:
            rows = self._repository.boxplot_grouped(normalized_type, group_by, params)

        buckets: dict[int, list[float]] = defaultdict(list)
        for bucket, value in rows:
            buckets[int(bucket)].append(value)

        items = []
        for bucket in sorted(buckets.keys()):
            values = sorted(buckets[bucket])
            if not values:
                continue
            items.append(self._boxplot_item(self._boxplot_label(group_by, bucket), values))

        return BoxPlotResponse(
            component_name=self._component_name(component_id),
            measurement_type=normalized_type,
            unit=fdwh_unit(normalized_type),
            group_by=group_by,
            items=items,
        )

    @staticmethod
    def _boxplot_label(group_by: str, bucket: int) -> str:
        if group_by == "hour":
            return f"{bucket:02d}:00"
        if group_by == "weekday":
            return WEEKDAY_LABELS[bucket]
        if group_by == "month":
            return SEASON_MONTH_LABELS[bucket - 1]
        if group_by == "weekday_weekend":
            return "Wochenende" if bucket == 1 else "Werktag"
        raise InvalidRequestError(f"Unknown group_by {group_by!r}")

    @_cached
    def get_power_factor(
        self,
        component_id: str,
        start: datetime | None,
        end: datetime | None,
        downsample_minutes: int | None = DEFAULT_POWER_FACTOR_DOWNSAMPLE_MINUTES,
    ) -> PowerFactorResponse:
        params = component_window_params(component_id, start, end)
        if downsample_minutes and downsample_minutes > 0:
            params["bucket"] = downsample_minutes * 60
            rows = self._repository.power_factor_downsampled(params)
        else:
            rows = self._repository.power_factor_timeseries(params)

        data: list[PowerFactorPoint] = []
        cos_phi_values: list[float] = []
        for timestamp, p_value, q_value, s_value in rows:
            # Sanitize first: None/NaN/Inf -> None. A missing input is never
            # treated as 0 (would fabricate a wrong power factor) and never
            # leaks a non-finite value into the response.
            p_f = _finite_or_none(p_value)
            q_f = _finite_or_none(q_value)
            s_f = _finite_or_none(s_value)

            # cos φ = P / S requires both P and S finite and S ≠ 0.
            # Sign is preserved (negative cos φ = reverse power flow); the
            # clamp only ever sees a finite quotient.
            cos_phi = None
            if p_f is not None and s_f is not None and abs(s_f) > POWER_FACTOR_EPSILON:
                cos_phi = max(-1.0, min(1.0, round(p_f / s_f, 4)))
                cos_phi_values.append(cos_phi)

            # tan φ = Q / P requires both Q and P finite and P ≠ 0.
            tan_phi = None
            if q_f is not None and p_f is not None and abs(p_f) > POWER_FACTOR_EPSILON:
                tan_phi = round(q_f / p_f, 4)

            data.append(
                PowerFactorPoint(
                    timestamp=timestamp,
                    cos_phi=cos_phi,
                    tan_phi=tan_phi,
                    p=round(p_f, 3) if p_f is not None else None,
                    q=round(q_f, 3) if q_f is not None else None,
                    s=round(s_f, 3) if s_f is not None else None,
                )
            )

        if not data:
            raise ResourceNotFoundError(
                "Keine gültigen P/Q/S-Werte für den Leistungsfaktor im Zeitraum. "
                "Leistungsfaktor benötigt Wirkleistung (P), Blindleistung (Q) und "
                "Scheinleistung (S) für dasselbe Betriebsmittel."
            )

        return PowerFactorResponse(
            component_name=self._component_name(component_id),
            data=data,
            histogram_bins=self._power_factor_histogram_bins(),
            histogram_counts=self._power_factor_histogram_counts(cos_phi_values),
        )

    @_cached
    def get_quality(
        self,
        component_id: str,
        start: datetime | None,
        end: datetime | None,
        expected_per_day: int = DEFAULT_EXPECTED_POINTS_PER_DAY,
    ) -> QualityResponse:
        if expected_per_day <= 0:
            raise InvalidRequestError("expected_per_day must be greater than zero")

        params = component_window_params(component_id, start, end)
        # Single GROUPING SETS query returns both the daily rollups (hour IS
        # NULL) and the per-hour gap rows in one Oracle scan.
        daily_counts: list[QualityDayCount] = []
        gap_heatmap: list[QualityGapCell] = []
        for day, hour, count in self._repository.quality_combined(params):
            if hour is None:
                missing_pct = round(max(0, (1 - count / expected_per_day)) * 100, 1)
                daily_counts.append(
                    QualityDayCount(
                        day=str(day),
                        measurement_type="ALL",
                        count=count,
                        expected=expected_per_day,
                        missing_pct=missing_pct,
                    )
                )
            else:
                gap_heatmap.append(
                    QualityGapCell(
                        day=str(day),
                        hour=int(hour),
                        measurement_type="ALL",
                        count=count,
                    )
                )
        return QualityResponse(
            component_name=self._component_name(component_id),
            daily_counts=daily_counts,
            gap_heatmap=gap_heatmap,
            measurement_types=QUALITY_MEASUREMENT_TYPES,
        )

    @_cached
    def get_dst_events(
        self,
        component_id: str,
        start: datetime | None,
        end: datetime | None,
    ) -> DSTResponse:
        rows = self._repository.dst_hourly_counts(component_window_params(component_id, start, end))
        day_hours: dict[str, dict[int, int]] = defaultdict(dict)
        for day, hour, count in rows:
            day_hours[str(day)][int(hour)] = int(count)

        events = []
        for day, hours_map in sorted(day_hours.items()):
            counts = list(hours_map.values())
            if not counts:
                continue
            typical = sorted(counts)[len(counts) // 2]
            if 1 in hours_map and 3 in hours_map and 2 not in hours_map:
                events.append(DSTEvent(date=day, type="spring_forward", affected_hour=2, measurement_count=0))
            if 2 in hours_map and typical > 0 and hours_map[2] > typical * 1.5:
                events.append(
                    DSTEvent(
                        date=day,
                        type="fall_back",
                        affected_hour=2,
                        measurement_count=hours_map[2],
                    )
                )

        return DSTResponse(component_name=self._component_name(component_id), events=events)

    @_cached
    def get_season_radar(
        self,
        component_id: str,
        start: datetime | None,
        end: datetime | None,
        types: str | None = None,
    ) -> SeasonRadarResponse:
        # Only compute what was actually requested. `types` is a comma list
        # (e.g. "P,Q"); when omitted, fall back to all supported measurements.
        if types:
            requested = [
                normalize_measurement_type(t.strip())
                for t in types.split(",")
                if t.strip()
            ]
            requested = [t for t in requested if t in SEASON_MEASUREMENT_TYPES]
            if not requested:
                raise InvalidRequestError(
                    f"Saison-Radar unterstützt nur {', '.join(SEASON_MEASUREMENT_TYPES)}."
                )
        else:
            requested = list(SEASON_MEASUREMENT_TYPES)

        rows = self._repository.season_monthly_values(component_window_params(component_id, start, end))
        month_values: dict[str, dict[int, list[float]]] = defaultdict(lambda: defaultdict(list))
        for month, p_value, q_value, s_value in rows:
            month_index = int(month)
            values = {"P": p_value, "Q": q_value, "S": s_value}
            for mtype in requested:
                value = values[mtype]
                if value is not None:
                    month_values[mtype][month_index].append(value)

        series = []
        for measurement_type in requested:
            if measurement_type not in month_values:
                continue
            series.append(
                SeasonRadarSeries(
                    measurement_type=measurement_type,
                    unit=fdwh_unit(measurement_type),
                    monthly_medians=[
                        self._median_or_zero(month_values[measurement_type].get(month, []))
                        for month in range(1, 13)
                    ],
                )
            )

        return SeasonRadarResponse(
            component_name=self._component_name(component_id),
            months=SEASON_MONTH_LABELS,
            series=series,
        )

    @_cached
    def get_exceedance(
        self,
        component_id: str,
        measurement_type: str,
        threshold: float = DEFAULT_EXCEEDANCE_THRESHOLD,
        start: datetime | None = None,
        end: datetime | None = None,
    ) -> ExceedanceResponse:
        normalized_type = normalize_measurement_type(measurement_type)
        rows = self._repository.exceedance_timeline(
            normalized_type,
            component_window_params(component_id, start, end),
        )
        day_stats: dict[str, dict[str, float]] = defaultdict(lambda: {"count": 0, "max": 0.0, "sum": 0.0})
        total_above = 0
        total_points = len(rows)

        for day, _timestamp, value in rows:
            value_f = float(value)
            if value_f >= threshold:
                day_key = str(day)
                total_above += 1
                day_stats[day_key]["count"] += 1
                day_stats[day_key]["max"] = max(day_stats[day_key]["max"], value_f)
                day_stats[day_key]["sum"] += value_f

        top_days = sorted(
            [
                ExceedanceDay(
                    day=day,
                    minutes_above=stats["count"] * EXCEEDANCE_INTERVAL_MINUTES,
                    max_value=round(stats["max"], 3),
                    mean_value=round(stats["sum"] / stats["count"], 3) if stats["count"] > 0 else 0,
                )
                for day, stats in day_stats.items()
            ],
            key=lambda item: item.minutes_above,
            reverse=True,
        )[:TOP_EXCEEDANCE_DAYS]

        return ExceedanceResponse(
            component_name=self._component_name(component_id),
            measurement_type=normalized_type,
            unit=fdwh_unit(normalized_type),
            threshold=threshold,
            total_minutes_above=total_above * EXCEEDANCE_INTERVAL_MINUTES,
            total_pct=round(total_above / total_points * 100, 2) if total_points > 0 else 0,
            top_days=top_days,
        )

    def _component_name(self, component_id: str) -> str:
        anr, fnr = split_component_id(component_id)
        return self._repository.component_name(anr, fnr)

    @staticmethod
    def _pearson(values_a: list[float], values_b: list[float]) -> float:
        """Used by get_correlation (scatter plot). The matrix path moved to
        Oracle's CORR() aggregate."""
        count = len(values_a)
        sum_a = sum(values_a)
        sum_b = sum(values_b)
        sum_ab = sum(a * b for a, b in zip(values_a, values_b))
        sum_a2 = sum(a * a for a in values_a)
        sum_b2 = sum(b * b for b in values_b)
        denominator = ((count * sum_a2 - sum_a**2) * (count * sum_b2 - sum_b**2)) ** 0.5
        return (count * sum_ab - sum_a * sum_b) / denominator if denominator > 0 else 0

    @staticmethod
    def _boxplot_item(label: str, values: list[float]) -> BoxPlotItem:
        count = len(values)
        return BoxPlotItem(
            label=label,
            min=round(values[0], 3),
            q1=round(values[count // 4], 3),
            median=round(values[count // 2], 3),
            q3=round(values[(3 * count) // 4], 3),
            max=round(values[-1], 3),
        )

    @staticmethod
    def _power_factor_histogram_bins() -> list[float]:
        bin_width = 1.0 / POWER_FACTOR_HISTOGRAM_BINS
        return [round(index * bin_width, 3) for index in range(POWER_FACTOR_HISTOGRAM_BINS + 1)]

    @staticmethod
    def _power_factor_histogram_counts(values: list[float]) -> list[int]:
        bin_width = 1.0 / POWER_FACTOR_HISTOGRAM_BINS
        counts = [0] * POWER_FACTOR_HISTOGRAM_BINS
        for value in values:
            index = min(int(abs(value) / bin_width), POWER_FACTOR_HISTOGRAM_BINS - 1)
            counts[index] += 1
        return counts

    @staticmethod
    def _median_or_zero(values: list[float]) -> float:
        if not values:
            return 0.0
        sorted_values = sorted(values)
        return round(sorted_values[len(sorted_values) // 2], 3)