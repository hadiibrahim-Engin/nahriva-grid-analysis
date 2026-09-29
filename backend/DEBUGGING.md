# Backend debugging

Use this when you want to debug the Python/API side without opening the
dashboard.

## 1. Install Python dependencies

macOS/Linux:

```bash
cd backend
python3 -m venv venv
source venv/bin/activate
python -m pip install -r requirements.txt
```

Windows:

```bat
cd backend
python -m venv venv
venv\Scripts\activate
python -m pip install -r requirements.txt
```

## 2. Configure Oracle

Copy `.env.example` to `.env` and fill in your Oracle values:

```bash
cp .env.example .env
```

The backend needs:

- `DB_HOST`, `DB_PORT`, `DB_NAME` for login checks.
- Either `DATABASE_URL`, or `DB_USER` plus `DB_PASSWORD`, for dashboard queries.

## 3. Run focused checks

```bash
python scripts/debug_backend.py config
python scripts/debug_backend.py import-app --traceback
python scripts/debug_backend.py db-ping --traceback
python scripts/debug_backend.py facilities --limit 5 --traceback
python scripts/debug_backend.py auth --username YOUR_USER --password YOUR_PASSWORD
```

Check one component:

```bash
python scripts/debug_backend.py component \
  --component-id ANLAGENNUMMER_FELDNUMMER \
  --measurement-type P \
  --start 2024-01-01T00:00:00 \
  --end 2024-01-31T23:59:59 \
  --traceback
```

Run the API after the checks pass:

```bash
python -m uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

Then open:

- API health: `http://localhost:8000/api/health`
- API docs: `http://localhost:8000/docs`

## Dashboard flow without frontend

This runs the same kind of data flow as the dashboard, but directly in Python:

```bash
python scripts/dashboard_probe.py --no-auth --traceback
```

Test Oracle login plus the query flow:

```bash
python scripts/dashboard_probe.py \
  --username YOUR_ORACLE_USER \
  --measurement-type P \
  --limit 5 \
  --traceback
```

If you do not pass `--password`, the script asks for it without printing it.

Test a specific component and time window:

```bash
python scripts/dashboard_probe.py \
  --component-id ANLAGENNUMMER_FELDNUMMER \
  --measurement-type P \
  --start 2024-01-01T00:00:00 \
  --end 2024-01-31T23:59:59 \
  --traceback
```

Important:

- Login is tested with the username/password you pass to the script.
- Data queries use `DATABASE_URL`, or `DB_USER`/`DB_PASSWORD`, from `backend/.env`.
