"""Immutable Parquet archive of one analysis: every stored result of one PowerFactory run, read from SQLite.

SQLite is the current working database; the archive is the hand-over and long-term copy:

    <out>/<analysis id>/
        manifest.json                     written last: an archive without it is incomplete
        <table>.parquet                   one file per table, rows of this analysis only
        analysis_values/<run>.parquet     the QDS values, one file per run, ordered by series and time

Every file is ZSTD-compressed and listed in the manifest with its row count, size and SHA-256. The archive is
written to a hidden directory beside the target and renamed into place once it is complete and verified, and its
files are made read-only; an existing archive is never overwritten. Values are copied as stored: a value
PowerFactory did not deliver stays NULL (state `invalid_or_missing`), n-1 cells keep their code and state.

Runs whose values the bridge stored in Parquet (app/simulation/values.py) are archived by copying that file.
"""

import hashlib
import json
import os
import re
import shutil
import sqlite3
import stat
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from app.simulation import values
from app.simulation.imports import ImportBusy, serialized
from app.simulation.gridlens_store import RESULT_SCHEMA_VERSION
from app.simulation.states import STATES_VERSION

FORMAT = "gridlens-analysis-archive"
FORMAT_VERSION = 2
COMPRESSION = "zstd"
COMPRESSION_LEVEL = 3
ROW_GROUP_ROWS = 1_000_000
# Layouts 13 onward have compatible archived tables. Raw QDS files remain Parquet on restore.
OLDEST_LAYOUT = 13
_BATCH_ROWS = 250_000

# (file, table, rows of this analysis). The temp tables _scenarios, _runs and _results hold the ids of the analysis.
TABLES = (
    ("analysis", "gl_assessments", "id = :analysis"),
    ("catalog", "pf_catalog", "1=1"),
    ("jobs", "pf_jobs", "id IN (SELECT id FROM _scenarios)"),
    ("cells", "pf_scenario_cells", "scenario_id IN (SELECT id FROM _scenarios)"),
    ("lodf", "pf_lodf", "outage_key IN (SELECT id FROM _outages)"),
    ("lodf_undefined", "pf_lodf_undefined", "outage_key IN (SELECT id FROM _outages)"),
    ("elements", "gl_elements", "assessment_id = :analysis"),
    ("cases", "gl_cases", "assessment_id = :analysis"),
    ("evaluations", "gl_evaluations", "assessment_id = :analysis"),
    ("scenarios", "pf_scenarios", "id IN (SELECT id FROM _scenarios)"),
    ("scenario_runs", "pf_scenario_runs", "scenario_id IN (SELECT id FROM _scenarios)"),
    ("scenario_provenance", "pf_scenario_provenance", "scenario_id IN (SELECT id FROM _scenarios)"),
    ("runs", "analysis_runs", "id IN (SELECT id FROM _runs)"),
    ("run_notes", "pf_run_notes", "run_id IN (SELECT id FROM _runs)"),
    ("run_times", "pf_run_times", "run_id IN (SELECT id FROM _runs)"),
    ("area_times", "pf_area_times", "run_id IN (SELECT id FROM _runs)"),
    ("area_flows", "pf_area_flows", "run_id IN (SELECT id FROM _runs)"),
    ("branch_ends", "gl_branch_ends", "assessment_id = :analysis"),
    ("run_metrics", "analysis_metrics", "run_id IN (SELECT id FROM _runs)"),
    ("run_elements", "analysis_elements", "run_id IN (SELECT id FROM _runs)"),
    ("element_limits", "pf_element_limits", "run_id IN (SELECT id FROM _runs)"),
    ("series", "analysis_series", "run_id IN (SELECT id FROM _runs)"),
    ("results", "gl_results", "assessment_id = :analysis"),
    ("unresolved_rows", "gl_unresolved_rows", "result_id IN (SELECT id FROM _results)"),
    ("n1_columns_native", "gl_columns", "result_id IN (SELECT id FROM _results)"),
    ("n1_contingencies", "gl_contingencies", "result_id IN (SELECT id FROM _results)"),
    ("n1_times", "gl_times", "result_id IN (SELECT id FROM _results)"),
    ("n1_time_columns", "gl_time_columns", "result_id IN (SELECT id FROM _results)"),
    ("n1_pairs", "gl_pairs", "result_id IN (SELECT id FROM _results)"),
    ("n1_values", "gl_values", "result_id IN (SELECT id FROM _results)"),
    ("n1_hourly", "gl_n1_hourly", "result_id IN (SELECT id FROM _results)"),
    ("n1_columns", "gl_n1_columns", "result_id IN (SELECT id FROM _results)"),
)
_VALUES_SQL = (
    "SELECT v.series_id, v.t, v.value FROM analysis_values v "
    "WHERE v.series_id IN (SELECT id FROM analysis_series WHERE run_id = ?) ORDER BY v.series_id, v.t"
)


class ArchiveError(Exception):
    """The analysis cannot be archived (unknown, still importing, or the target exists)."""


def _arrow():
    try:
        import pyarrow
        import pyarrow.parquet
    except ImportError:
        raise ArchiveError("The Parquet archive needs pyarrow (a dependency of backend/; run setup again).") from None
    return pyarrow, pyarrow.parquet


def _schema(pa, db, table):
    """Arrow schema from the declared SQLite types: INTEGER -> int64, REAL -> float64, everything else text."""
    types = {"INTEGER": pa.int64(), "REAL": pa.float64()}
    return pa.schema([
        pa.field(name, types.get((declared or "").upper(), pa.string()), nullable=not notnull)
        for _cid, name, declared, notnull, _default, _pk in db.execute(f"PRAGMA table_info({table})")
    ])


def _write(pa, pq, path, schema, cursor):
    """Stream a cursor into one ZSTD Parquet file; returns the row count."""
    rows = 0
    with pq.ParquetWriter(path, schema, compression=COMPRESSION, compression_level=COMPRESSION_LEVEL,
                          write_statistics=True) as writer:
        while batch := cursor.fetchmany(_BATCH_ROWS):
            columns = list(zip(*batch))
            writer.write_table(
                pa.table([pa.array(column, type=field.type) for column, field in zip(columns, schema)], schema=schema),
                row_group_size=ROW_GROUP_ROWS)
            rows += len(batch)
        if rows == 0:
            writer.write_table(schema.empty_table())
    return rows


def _sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        while chunk := handle.read(1 << 20):
            digest.update(chunk)
    return digest.hexdigest()


def _safe(name):
    return re.sub(r"[^A-Za-z0-9._-]", "_", name)


def _open(database):
    db = sqlite3.connect(Path(database).resolve().as_uri() + "?mode=ro", uri=True)
    db.execute("PRAGMA temp_store=MEMORY")
    return db


def export_analysis(database, analysis_id, out_dir, on_file=None, context=None):
    """Write the archive of one analysis below `out_dir` and return its directory.

    `on_file(name, rows)` is called after every written file (progress). Raises ArchiveError when the analysis is
    unknown or still importing, or when its archive already exists.
    """
    pa, pq = _arrow()
    db = _open(database)
    try:
        db.execute("BEGIN")  # one consistent snapshot, including concurrently arriving results
        found = db.execute("SELECT status FROM gl_assessments WHERE id = ?", (analysis_id,)).fetchone()
        if found is None:
            raise ArchiveError(f"Analysis {analysis_id} is not in {database}.")
        if found[0] != "complete":
            raise ArchiveError(f"Analysis {analysis_id} is still importing or incomplete; archive it when it is complete.")
        target = Path(out_dir) / _safe(analysis_id)
        if target.exists():
            raise ArchiveError(f"{target} exists. Archives are immutable; remove it by hand to write it again.")
        db.execute("CREATE TEMP TABLE _scenarios AS SELECT id FROM pf_scenarios WHERE analysis_id = ?", (analysis_id,))
        db.execute("CREATE TEMP TABLE _outages (id TEXT PRIMARY KEY)")
        db.executemany("INSERT OR IGNORE INTO _outages VALUES (?)", [
            (",".join(sorted(json.loads(row[0]))),)
            for row in db.execute("SELECT outages FROM pf_scenarios WHERE id IN (SELECT id FROM _scenarios)")
        ])
        db.execute("CREATE TEMP TABLE _runs AS SELECT run_id AS id FROM pf_scenario_runs "
                   "WHERE scenario_id IN (SELECT id FROM _scenarios) UNION "
                   "SELECT analysis_run_id FROM gl_results WHERE assessment_id=? AND analysis_run_id IS NOT NULL",
                   (analysis_id,))
        db.execute("CREATE TEMP TABLE _results AS SELECT id FROM gl_results WHERE assessment_id = ?", (analysis_id,))
        layout = db.execute("PRAGMA user_version").fetchone()[0]
        Path(out_dir).mkdir(parents=True, exist_ok=True)
        partial = Path(tempfile.mkdtemp(prefix=f".{_safe(analysis_id)}.partial-", dir=out_dir))
        (partial / "analysis_values").mkdir()
        files = []
        try:
            for name, table, where in TABLES:
                schema = _schema(pa, db, table)
                path = partial / f"{name}.parquet"
                rows = _write(pa, pq, path, schema, db.execute(f"SELECT * FROM {table} WHERE {where}",
                                                                {"analysis": analysis_id}))
                files.append({"path": path.name, "table": table, "rows": rows})
                if on_file:
                    on_file(name, rows)
            value_schema = pa.schema([pa.field("series_id", pa.int64(), nullable=False),
                                      pa.field("t", pa.int64(), nullable=False), pa.field("value", pa.float64())])
            for (run_id,) in db.execute("SELECT id FROM _runs ORDER BY id").fetchall():
                path = partial / "analysis_values" / f"{_safe(run_id)}-{hashlib.sha256(run_id.encode()).hexdigest()[:16]}.parquet"
                stored = values.file_of(db, database, run_id)
                if stored is not None:  # already a Parquet file of the same columns: copied as it is
                    shutil.copyfile(stored, path)
                    rows = pq.ParquetFile(path).metadata.num_rows
                else:
                    rows = _write(pa, pq, path, value_schema, db.execute(_VALUES_SQL, (run_id,)))
                files.append({"path": f"analysis_values/{path.name}", "table": "analysis_values", "run_id": run_id,
                              "rows": rows})
                if on_file:
                    on_file(f"values {run_id}", rows)
            for entry in files:
                path = partial / entry["path"]
                entry["bytes"] = path.stat().st_size
                entry["sha256"] = _sha256(path)
                entry["columns"] = [{"name": f.name, "type": str(f.type)} for f in pq.read_schema(path)]
            manifest = {
                "format": FORMAT,
                "format_version": FORMAT_VERSION,
                "analysis_id": analysis_id,
                "context": context or {},
                "created_at": datetime.now(timezone.utc).isoformat(),
                "source": {"file": Path(database).name, "layout_version": layout,
                           "result_schema_version": RESULT_SCHEMA_VERSION},
                "states_version": STATES_VERSION,
                "compression": {"codec": COMPRESSION, "level": COMPRESSION_LEVEL},
                "time": "epoch seconds, UTC",
                "files": files,
            }
            (partial / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
            problems = verify_archive(partial)
            if problems:
                raise ArchiveError("The written archive does not verify: " + "; ".join(problems))
            for path in partial.rglob("*"):
                if path.is_file():
                    path.chmod(stat.S_IRUSR | stat.S_IRGRP | stat.S_IROTH)
            partial.rename(target)
        except BaseException:
            _remove(partial)
            raise
        return target
    except (sqlite3.Error, OSError, pa.ArrowException) as exc:
        raise ArchiveError("Analysis could not be exported: " + str(exc)) from exc
    finally:
        db.close()


def _remove(path):
    """Delete a partial archive, also its read-only files."""
    if path.exists():
        for file in path.rglob("*"):
            if file.is_file():
                file.chmod(stat.S_IRUSR | stat.S_IWUSR)
        shutil.rmtree(path, ignore_errors=True)


def _manifest(path):
    try:
        manifest = json.loads((path / "manifest.json").read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise ArchiveError("manifest.json is missing (the archive is incomplete)") from None
    except (OSError, ValueError) as exc:
        raise ArchiveError("manifest.json is not readable JSON: " + str(exc)) from None
    if not isinstance(manifest, dict):
        raise ArchiveError("manifest.json must contain an object")
    if manifest.get("format") != FORMAT or manifest.get("format_version") not in (1, FORMAT_VERSION):
        raise ArchiveError("unknown archive format or version")
    if not isinstance(manifest.get("analysis_id"), str) or not manifest["analysis_id"]:
        raise ArchiveError("manifest analysis_id is missing")
    if not isinstance(manifest.get("files"), list) or not manifest["files"]:
        raise ArchiveError("manifest files must be a non-empty list")
    return manifest


def verify_archive(path):
    """Validate structure and paths before reading any payload; then verify every checksum and schema."""
    pa, pq = _arrow()
    path = Path(path).resolve()
    try:
        manifest = _manifest(path)
        allowed = {table for _, table, _ in TABLES} | {"analysis_values"}
        listed = set()
        tables = set()
        problems = []
        for entry in manifest["files"]:
            if not isinstance(entry, dict):
                raise ArchiveError("invalid manifest file entry")
            name = entry.get("path")
            if not isinstance(name, str) or not name.endswith(".parquet") or "\\" in name:
                raise ArchiveError("invalid Parquet file path")
            file = (path / name).resolve()
            if Path(name).is_absolute() or not file.is_relative_to(path) or file in listed:
                raise ArchiveError("unsafe or duplicate archive path: " + name)
            if entry.get("table") not in allowed:
                raise ArchiveError("unknown archive table")
            if entry["table"] != "analysis_values" and entry["table"] in tables:
                raise ArchiveError("duplicate archive table")
            if entry["table"] == 'analysis_values' and (not isinstance(entry.get('run_id'), str) or not entry['run_id']):
                raise ArchiveError('invalid value-file run id')
            tables.add(entry["table"])
            listed.add(file)
            if not isinstance(entry.get("rows"), int) or entry["rows"] < 0:
                raise ArchiveError("invalid row count")
            if not isinstance(entry.get("bytes"), int) or not isinstance(entry.get("sha256"), str):
                raise ArchiveError("missing size or checksum")
            if not file.is_file():
                problems.append(f"{name} is missing")
                continue
            if file.stat().st_size != entry["bytes"]:
                problems.append(f"{name} has another size than recorded")
            elif _sha256(file) != entry["sha256"]:
                problems.append(f"{name} was changed (checksum)")
            else:
                with pq.ParquetFile(file) as parquet:
                    if parquet.metadata.num_rows != entry["rows"]:
                        problems.append(f"{name} has another row count than recorded")
                    columns = [{"name": f.name, "type": str(f.type)} for f in parquet.schema_arrow]
                    if columns != entry.get("columns"):
                        problems.append(f"{name} schema differs from manifest")
        optional_v1 = {"pf_catalog", "pf_jobs", "pf_scenario_cells", "pf_lodf", "pf_lodf_undefined"}
        required = {table for _, table, _ in TABLES} - {"gl_evaluations", "gl_unresolved_rows"}
        if manifest["format_version"] == 1:
            required -= optional_v1
        if required - tables:
            problems.append("missing tables: " + ", ".join(sorted(required - tables)))
        problems.extend(f"{p.relative_to(path)} is not listed in the manifest"
                        for p in path.rglob("*.parquet") if p.resolve() not in listed)
        return problems
    except (ArchiveError, OSError, ValueError, KeyError, TypeError, pa.ArrowException) as exc:
        return [str(exc)]


def import_analysis(archive, database, on_file=None):
    """Restore into a NEW SQLite database in bounded batches, without rerunning analysis.

    Publish only after schema, relationships and integrity checks pass. Never overwrite an existing file.
    Version 1 archives can be reopened; their omitted evaluation caches are rebuilt on demand.
    """
    pa, pq = _arrow()
    from app.simulation.store import ScenarioStore, LAYOUT_VERSION

    archive = Path(archive).expanduser().resolve()
    target = Path(database).expanduser()
    if not target.is_absolute():
        raise ArchiveError("Use an absolute path for the restored database.")
    if target.exists() or values.folder(target).exists():
        raise ArchiveError("The restore destination or its values folder exists; choose a new database path.")
    problems = verify_archive(archive)
    if problems:
        raise ArchiveError("Invalid archive: " + "; ".join(problems))
    manifest = _manifest(archive)
    source = manifest.get("source", {})
    if not isinstance(source, dict):
        raise ArchiveError("Invalid archive source metadata.")
    if (not isinstance(source.get("layout_version"), int)
            or not OLDEST_LAYOUT <= source["layout_version"] <= LAYOUT_VERSION
            or source.get("result_schema_version") not in (2, 3, RESULT_SCHEMA_VERSION)
            or manifest.get("states_version") not in (1, STATES_VERSION)):
        raise ArchiveError("Incompatible archive schema or states version. Use a matching dashboard version.")
    target.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=".restore-", suffix=".sqlite3", dir=target.parent)
    os.close(descriptor)
    db = None
    published_values = False
    published_database = False
    try:
        store = ScenarioStore(temporary)
        db = store.db
        db.execute("PRAGMA journal_mode=DELETE")
        db.execute("BEGIN")
        db.execute("PRAGMA defer_foreign_keys=ON")
        for entry in manifest["files"]:
            table = entry["table"]  # allowlisted by verification; columns checked against the local schema
            expected = _schema(pa, db, table)
            with pq.ParquetFile(archive / entry["path"]) as parquet:
                if not parquet.schema_arrow.equals(expected, check_metadata=False):
                    raise ArchiveError(f"Incompatible columns or types in {entry['path']}.")
                if table == 'analysis_values':
                    # Keep the already verified immutable file. Do not expand millions of values into SQLite.
                    run = entry['run_id']
                    name = hashlib.sha256(run.encode()).hexdigest() + '.parquet'
                    base = values.folder(temporary)
                    base.mkdir(exist_ok=True)
                    dest = base / name
                    shutil.copyfile(archive / entry['path'], dest)
                    if _sha256(dest) != entry['sha256']:
                        raise ArchiveError('Value file changed during restoration: ' + entry['path'])
                    dest.chmod(stat.S_IRUSR | stat.S_IRGRP | stat.S_IROTH)
                    db.execute('INSERT INTO pf_run_values VALUES(?,?,?,?,?,?)',
                               (run, 'parquet', name, entry['rows'], entry['bytes'], entry['sha256']))
                    if on_file:
                        on_file(entry['path'], entry['rows'])
                    continue
                columns = ",".join('"' + f.name + '"' for f in expected)
                placeholders = ",".join("?" for _ in expected)
                sql = f'INSERT INTO "{table}" ({columns}) VALUES ({placeholders})'
                for batch in parquet.iter_batches(batch_size=16_384):
                    db.executemany(sql, zip(*(column.to_pylist() for column in batch.columns)))
            if on_file:
                on_file(entry["path"], entry["rows"])
        if manifest["format_version"] == 1:
            db.execute("INSERT INTO pf_jobs(id,kind,payload,status,created_at) "
                       "SELECT id,'restored','{}','completed',created_at FROM pf_scenarios")
        owners = db.execute("SELECT id FROM gl_assessments").fetchall()
        if [row[0] for row in owners] != [manifest["analysis_id"]]:
            raise ArchiveError("Archive must contain exactly its declared analysis.")
        if db.execute("SELECT 1 FROM pf_scenarios WHERE analysis_id IS NOT ? LIMIT 1",
                      (manifest["analysis_id"],)).fetchone():
            raise ArchiveError("Archive contains scenarios from another analysis.")
        if db.execute("SELECT 1 FROM gl_results WHERE analysis_run_id IS NOT NULL "
                      "AND analysis_run_id NOT IN (SELECT id FROM analysis_runs) LIMIT 1").fetchone():
            raise ArchiveError("Archive has a native result with a missing analysis run.")
        runs = {row[0] for row in db.execute("SELECT id FROM analysis_runs")}
        value_runs = [e.get("run_id") for e in manifest["files"] if e["table"] == "analysis_values"]
        if set(value_runs) != runs or len(value_runs) != len(runs):
            raise ArchiveError("Missing or duplicate run value files.")
        for run in runs:
            invalid = values.query(db, run,
                'SELECT 1 FROM analysis_values v LEFT JOIN analysis_series s ON s.id=v.series_id '
                'WHERE s.id IS NULL OR s.run_id<>? OR v.t IS NULL LIMIT 1', (run,))
            duplicate = values.query(db, run,
                'SELECT 1 FROM analysis_values GROUP BY series_id,t HAVING COUNT(*)>1 LIMIT 1')
            if invalid or duplicate:
                raise ArchiveError('Invalid, foreign or duplicate values in run ' + run)
        if db.execute("PRAGMA foreign_key_check").fetchone():
            raise ArchiveError("Archive has missing or incompatible record references.")
        db.commit()
        if db.execute("PRAGMA quick_check").fetchone()[0] != "ok":
            raise ArchiveError("Restored database failed its integrity check.")
        db.close()
        db = None
        # The destination lock coordinates a concurrent restore/import. Publish files first, SQLite last;
        # no visible database ever references an incomplete folder.
        with serialized(target):
            if target.exists() or values.folder(target).exists():
                raise ArchiveError('The restore destination exists; choose a new database path.')
            if values.folder(temporary).exists():
                values.folder(temporary).rename(values.folder(target))
                published_values = True
            os.link(temporary, target)  # exclusive publication
            published_database = True
        return {"path": str(target.resolve()), "analysis_id": manifest["analysis_id"],
                "context": manifest.get("context", {})}
    except (sqlite3.Error, OSError, ValueError, ImportBusy, pa.ArrowException) as exc:
        raise ArchiveError("Archive could not be restored: " + str(exc)) from exc
    finally:
        if db is not None:
            db.close()
        if values.folder(temporary).exists():
            _remove(values.folder(temporary))
        if published_values and not published_database:
            _remove(values.folder(target))
        for suffix in ("", "-wal", "-shm", "-journal"):
            Path(temporary + suffix).unlink(missing_ok=True)
