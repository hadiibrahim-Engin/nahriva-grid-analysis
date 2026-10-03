export interface ResultProvenance {
  project?: string;
  project_path?: string;
  study_case?: string;
  study_case_path?: string;
  data_source?: string;
  powerfactory_version?: string | null;
  dummy_qds_version?: number;
  period?: [number | null, number | null];
  sample_interval_seconds?: number;
  operational_scenario?: { name: string; path: string } | null;
  networks?: { name: string; path: string }[] | null;
  grid_name_filter?: string;
  qds_command?: { name: string; path: string };
}

export interface ResultScenario {
  id: string;
  name: string;
  project?: string;
  study_case?: string;
  created_at?: string;
  provenance?: ResultProvenance | null;
  runs: { run_id: string; kind: string; source?: string }[];
}

export function isSynthetic(provenance: ResultProvenance) {
  return Boolean(provenance.dummy_qds_version) || /synthetic|synthetisch|dummy/i.test(provenance.data_source ?? '');
}

export function resultContexts(scenarios: ResultScenario[], catalog: ResultProvenance | null) {
  const records = scenarios.length ? scenarios.map(scenario => ({
    // The live catalog cannot establish which version/model was used for older results.
    provenance: scenario.provenance ?? {
      project: scenario.project,
      study_case: scenario.study_case,
      data_source: [...new Set(scenario.runs.map(run => run.source).filter(Boolean))].join(', '),
    },
    count: 1,
    lastResult: scenario.created_at,
  })) : catalog ? [{ provenance: catalog, count: 0, lastResult: undefined }] : [];
  const groups = new Map<string, typeof records[number]>();
  for (const record of records) {
    const p = record.provenance;
    const key = JSON.stringify([
      p.project, p.project_path, p.study_case, p.study_case_path, p.data_source,
      p.powerfactory_version, p.dummy_qds_version, p.period, p.sample_interval_seconds,
      p.operational_scenario, p.networks, p.grid_name_filter, p.qds_command,
    ]);
    const previous = groups.get(key);
    if (!previous) groups.set(key, { ...record });
    else {
      previous.count += record.count;
      if (record.lastResult && (!previous.lastResult || record.lastResult > previous.lastResult)) previous.lastResult = record.lastResult;
    }
  }
  return [...groups.values()];
}

export function provenancePeriod(period?: ResultProvenance['period']) {
  if (!period || period.some(value => value === null || !Number.isFinite(value))) return 'Nicht erfasst';
  const formatter = new Intl.DateTimeFormat('de-DE', { dateStyle: 'short', timeStyle: 'short', timeZone: 'UTC' });
  return `${formatter.format(new Date(period[0]! * 1000))} – ${formatter.format(new Date(period[1]! * 1000))} UTC`;
}
