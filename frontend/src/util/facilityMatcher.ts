/**
 * Fuzzy name-based matcher between map MockStations and FDWH Facilities.
 *
 * Facilities have no stable ID that corresponds to map station UUIDs,
 * so matching is purely textual. This module provides:
 *
 *   matchStation(station, facilities) → MatchResult | null
 *
 * The algorithm:
 *   1. Normalise both sides (lowercase, German char folding, abbreviation
 *      expansion, punctuation stripping).
 *   2. Jaccard token similarity  (word-set overlap, order-independent).
 *   3. Jaro-Winkler string similarity  (handles small typos / suffixes).
 *   4. Prefix bonus  (one string is a prefix of the other → +0.15).
 *   5. Combined score → high / medium / low confidence tier.
 *
 * Confidence tiers:
 *   ≥ 0.80  high   → auto-select in caller
 *   ≥ 0.55  medium → show confirmation UI, require user click
 *   < 0.55  low    → zoom to station only, do not touch facility dropdown
 *
 * No runtime dependencies — pure TS functions keep the bundle clean.
 */
import type { Facility } from '../api/client';

/**
 * Minimal station shape required by the matcher.
 * Satisfied by both MockStation (legacy) and GridStationCompat (v2 MapLibre).
 */
export interface MatchableStation {
  uuid:           string;
  langname:       string;
  identifierKurz: string;
}

// -- Confidence ------------------------------------------------------------

export type ConfidenceLevel = 'high' | 'medium' | 'low';

export interface MatchResult {
  facility: Facility;
  /** Combined similarity score, 0–1. */
  score: number;
  confidence: ConfidenceLevel;
  /** Tokens that appeared in both normalised strings — for debug/UI. */
  matchedTokens: string[];
}

const HIGH_THRESHOLD   = 0.80;
const MEDIUM_THRESHOLD = 0.55;
const FLOOR_SCORE      = 0.35; // below this we return null (no match)

// -- Normalisation ---------------------------------------------------------

const ABBREV: [RegExp, string][] = [
  // German station-type abbreviations → canonical long form
  [/\buw\b/g,                  'umspannwerk'],
  [/\bumspannanlage\b/g,       'umspannwerk'],
  [/\bukw\b/g,                 'umspannwerk'],
  [/\b(trafo|transformator)\b/g, 'transformer'],
  [/\bnetzkupplung\b/g,        'kupplung'],
  [/\b(e-werk|ewerk)\b/g,      'energiewerk'],
  [/\bps\b/g,                  'primaerunterstation'],
  [/\bsub\b/g,                 'unterstation'],
  // Common German place suffixes that sometimes get dropped
  [/\b-?str\.\b/g,             'strasse'],
  [/\b-?str\b/g,               'strasse'],
];

function normalise(s: string): string {
  let t = s
    .toLowerCase()
    // German special chars → ASCII equivalent
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss');

  // Abbreviation expansion (applied after lowercasing)
  for (const [re, rep] of ABBREV) {
    t = t.replace(re, rep);
  }

  return t
    // Punctuation / separators → spaces
    .replace(/[-_./\\,;:()[\]'"]/g, ' ')
    // Collapse whitespace
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function tokenise(s: string): string[] {
  return normalise(s)
    .split(' ')
    .filter((w) => w.length > 1); // drop single-char noise tokens
}

// -- Jaccard token similarity -----------------------------------------------

function jaccard(tokA: string[], tokB: string[]): { score: number; common: string[] } {
  const setA = new Set(tokA);
  const setB = new Set(tokB);
  const common: string[] = [];
  for (const t of setA) {
    if (setB.has(t)) common.push(t);
  }
  const union = new Set([...setA, ...setB]).size;
  return { score: union === 0 ? 0 : common.length / union, common };
}

// -- Jaro-Winkler string similarity ----------------------------------------

function jaro(s: string, t: string): number {
  if (s === t) return 1;
  const sLen = s.length;
  const tLen = t.length;
  if (sLen === 0 || tLen === 0) return 0;

  const matchWindow = Math.max(Math.floor(Math.max(sLen, tLen) / 2) - 1, 0);
  const sMatches = new Uint8Array(sLen);
  const tMatches = new Uint8Array(tLen);
  let matches = 0;
  let transpositions = 0;

  for (let i = 0; i < sLen; i++) {
    const start = Math.max(0, i - matchWindow);
    const end = Math.min(i + matchWindow + 1, tLen);
    for (let j = start; j < end; j++) {
      if (tMatches[j] || s[i] !== t[j]) continue;
      sMatches[i] = 1;
      tMatches[j] = 1;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;

  let k = 0;
  for (let i = 0; i < sLen; i++) {
    if (!sMatches[i]) continue;
    while (!tMatches[k]) k++;
    if (s[i] !== t[k]) transpositions++;
    k++;
  }
  return (matches / sLen + matches / tLen + (matches - transpositions / 2) / matches) / 3;
}

function jaroWinkler(s: string, t: string, p = 0.1): number {
  const jScore = jaro(s, t);
  if (jScore < 0.7) return jScore;
  // Common prefix length, max 4
  let prefix = 0;
  for (let i = 0; i < Math.min(4, s.length, t.length); i++) {
    if (s[i] === t[i]) prefix++;
    else break;
  }
  return jScore + prefix * p * (1 - jScore);
}

// -- Prefix bonus ----------------------------------------------------------

function prefixBonus(normA: string, normB: string): number {
  const a = normA.replace(/\s/g, '');
  const b = normB.replace(/\s/g, '');
  const shorter = a.length < b.length ? a : b;
  const longer  = a.length < b.length ? b : a;
  return longer.startsWith(shorter) ? 0.15 : 0;
}

// -- Public API ------------------------------------------------------------

/**
 * Find the best-matching Facility for a given MockStation.
 *
 * Returns null when no facility meets the minimum floor score (0.35).
 */
export function matchStation(
  station: MatchableStation,
  facilities: Facility[],
): MatchResult | null {
  if (facilities.length === 0) return null;

  const stationToks = tokenise(station.langname);
  const normStation = normalise(station.langname);

  let best: MatchResult | null = null;

  for (const facility of facilities) {
    const facilityToks = tokenise(facility.name);
    const normFacility = normalise(facility.name);

    const { score: jaccScore, common } = jaccard(stationToks, facilityToks);
    const jwScore = jaroWinkler(normStation, normFacility);
    const pBonus  = prefixBonus(normStation, normFacility);

    const combined = 0.50 * jaccScore + 0.35 * jwScore + 0.15 * pBonus;

    if (combined < FLOOR_SCORE) continue;
    if (!best || combined > best.score) {
      const confidence: ConfidenceLevel =
        combined >= HIGH_THRESHOLD   ? 'high'   :
        combined >= MEDIUM_THRESHOLD ? 'medium' : 'low';
      best = { facility, score: combined, confidence, matchedTokens: common };
    }
  }

  return best;
}

/**
 * Batch-match all stations against the facility list.
 * Useful for building a pre-computed lookup table in debug mode.
 */
export function matchAll(
  stations: MatchableStation[],
  facilities: Facility[],
): Map<string, MatchResult | null> {
  const map = new Map<string, MatchResult | null>();
  for (const s of stations) {
    map.set(s.uuid, matchStation(s, facilities));
  }
  return map;
}

/** Format score as a percentage string for UI display: "87 %" */
export function formatScore(score: number): string {
  return `${Math.round(score * 100)} %`;
}
