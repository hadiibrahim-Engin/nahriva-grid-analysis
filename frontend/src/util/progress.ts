/**
 * What the dashboard says about the PowerFactory script while it works: the row `progress` of
 * GET /api/simulation/outage-management, written by the script at every step and scenario.
 */
export interface PfProgress {
  state: 'running' | 'finished' | 'failed' | 'stopped';
  step: string;
  detail: string;
  current: number | null;
  total: number | null;
  started_at: string;
  updated_at: string;
}

export type ProgressTone = 'running' | 'stale' | 'failed' | 'stopped';

export interface ProgressView {
  tone: ProgressTone;
  text: string;
  /** 0..1 over the scenarios, null while no scenario is being calculated. */
  fraction: number | null;
}

/** A run that has not reported for this long is probably gone (PowerFactory closed), not calculating. */
export const STALE_HOURS = 6;

const clock = (iso: string): string => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
};

/** The banner to show, or null when there is nothing to say (no run yet, or it finished: the results are there). */
export function progressView(progress: PfProgress | null | undefined, now: number = Date.now()): ProgressView | null {
  if (!progress || progress.state === 'finished') return null;
  const where = [progress.step, progress.detail].filter(Boolean).join(' · ');
  if (progress.state === 'failed') return { tone: 'failed', text: `PowerFactory stopped with an error · ${progress.detail || progress.step}`, fraction: null };
  if (progress.state === 'stopped') return { tone: 'stopped', text: `PowerFactory was stopped · ${progress.detail || progress.step}`, fraction: null };
  const age = now - new Date(progress.updated_at).getTime();
  if (Number.isFinite(age) && age > STALE_HOURS * 3600_000) {
    return { tone: 'stale', text: `PowerFactory has not reported since ${clock(progress.updated_at)} · last: ${where}. The run may have been stopped.`, fraction: null };
  }
  const fraction = progress.total && progress.current !== null ? Math.min(1, Math.max(0, progress.current / progress.total)) : null;
  const since = clock(progress.started_at);
  return { tone: 'running', text: `PowerFactory is working · ${where}${since ? ` · started ${since}` : ''}`, fraction };
}
