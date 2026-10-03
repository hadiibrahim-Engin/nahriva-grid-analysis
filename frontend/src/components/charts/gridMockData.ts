/**
 * Mock topology used by the first iteration of the Karte tab.
 *
 * The shapes mirror the real backend dumps (`stationen.json`,
 * `trafos.json`, `stromkreise.json`) so the eventual swap from this
 * hardcoded set to a `getGridTopology()` fetch is a one-line change
 * in the page that consumes it.
 *
 * Stations are placed at real city centres in the Ruhrgebiet / NRW —
 * roughly the geographic footprint a regional grid operator covers.
 * Voltages, ownership and line types are illustrative only.
 */

export interface MockStation {
  uuid: string;
  langname: string;
  identifierKurz: string;
  typ: string;
  spannungsebenen: string[];
  status: string;
  planung: boolean;
  lat: number;
  lon: number;
}

export interface MockTransformer {
  uuid: string;
  uuidStation: string;
  bezeichnung: string;
  umspannebenen: string;
  nennleistung: number;
  status: string;
  planung: boolean;
}

export interface MockCircuit {
  uuid: string;
  langname: string;
  identifierKurz: string;
  typ: string;
  spannungsebene: string;
  stationen: [string, string];
  laenge?: number;
  planung: boolean;
}

export interface MockTopology {
  stations: MockStation[];
  transformers: MockTransformer[];
  circuits: MockCircuit[];
  warnings?: string[];
}

const STATIONS: MockStation[] = [
  {
    uuid: 'st-essen',
    langname: 'UW Essen-Süd',
    identifierKurz: 'ESS',
    typ: 'Umspannanlage',
    spannungsebenen: ['380', '110'],
    status: 'in Betrieb',
    planung: false,
    lat: 51.4356,
    lon: 7.0116,
  },
  {
    uuid: 'st-dortmund',
    langname: 'UW Dortmund-West',
    identifierKurz: 'DOW',
    typ: 'Umspannanlage',
    spannungsebenen: ['220', '110'],
    status: 'in Betrieb',
    planung: false,
    lat: 51.5136,
    lon: 7.4153,
  },
  {
    uuid: 'st-duisburg',
    langname: 'UW Duisburg-Nord',
    identifierKurz: 'DUI',
    typ: 'Umspannanlage',
    spannungsebenen: ['380', '220', '110'],
    status: 'in Betrieb',
    planung: false,
    lat: 51.4844,
    lon: 6.7623,
  },
  {
    uuid: 'st-bochum',
    langname: 'UW Bochum-Mitte',
    identifierKurz: 'BOM',
    typ: 'Umspannanlage',
    spannungsebenen: ['110'],
    status: 'in Betrieb',
    planung: false,
    lat: 51.4818,
    lon: 7.2197,
  },
  {
    uuid: 'st-duesseldorf',
    langname: 'UW Düsseldorf-Hafen',
    identifierKurz: 'DUS',
    typ: 'Umspannanlage',
    spannungsebenen: ['220', '110'],
    status: 'in Betrieb',
    planung: false,
    lat: 51.2477,
    lon: 6.7335,
  },
  {
    uuid: 'st-wuppertal',
    langname: 'UW Wuppertal-Ost',
    identifierKurz: 'WUP',
    typ: 'Umspannanlage',
    spannungsebenen: ['110'],
    status: 'in Betrieb',
    planung: false,
    lat: 51.2562,
    lon: 7.2008,
  },
  {
    uuid: 'st-muelheim',
    langname: 'UW Mülheim-Ruhr',
    identifierKurz: 'MUE',
    typ: 'Umspannanlage',
    spannungsebenen: ['110'],
    status: 'in Betrieb',
    planung: false,
    lat: 51.4322,
    lon: 6.8853,
  },
  {
    uuid: 'st-koeln-nord',
    langname: 'UW Köln-Nord (geplant)',
    identifierKurz: 'KLN',
    typ: 'Umspannanlage',
    spannungsebenen: ['380', '110'],
    status: 'in Planung',
    planung: true,
    lat: 50.9975,
    lon: 6.9203,
  },
];

const TRANSFORMERS: MockTransformer[] = [
  {
    uuid: 'tr-essen-1',
    uuidStation: 'st-essen',
    bezeichnung: 'TR-1',
    umspannebenen: '380 / 110',
    nennleistung: 300,
    status: 'in Betrieb',
    planung: false,
  },
  {
    uuid: 'tr-essen-2',
    uuidStation: 'st-essen',
    bezeichnung: 'TR-2',
    umspannebenen: '380 / 110',
    nennleistung: 300,
    status: 'in Betrieb',
    planung: false,
  },
  {
    uuid: 'tr-duisburg-1',
    uuidStation: 'st-duisburg',
    bezeichnung: 'TR-1',
    umspannebenen: '380 / 220',
    nennleistung: 600,
    status: 'in Betrieb',
    planung: false,
  },
  {
    uuid: 'tr-duisburg-2',
    uuidStation: 'st-duisburg',
    bezeichnung: 'TR-2',
    umspannebenen: '220 / 110',
    nennleistung: 250,
    status: 'in Betrieb',
    planung: false,
  },
  {
    uuid: 'tr-dortmund-1',
    uuidStation: 'st-dortmund',
    bezeichnung: 'TR-1',
    umspannebenen: '220 / 110',
    nennleistung: 250,
    status: 'in Betrieb',
    planung: false,
  },
  {
    uuid: 'tr-duesseldorf-1',
    uuidStation: 'st-duesseldorf',
    bezeichnung: 'TR-1',
    umspannebenen: '220 / 110',
    nennleistung: 250,
    status: 'in Betrieb',
    planung: false,
  },
];

const CIRCUITS: MockCircuit[] = [
  {
    uuid: 'sk-1',
    langname: 'Essen ⟷ Duisburg',
    identifierKurz: 'L-380-01',
    typ: 'Freileitung',
    spannungsebene: '380',
    stationen: ['st-essen', 'st-duisburg'],
    laenge: 28,
    planung: false,
  },
  {
    uuid: 'sk-2',
    langname: 'Duisburg ⟷ Mülheim',
    identifierKurz: 'L-110-02',
    typ: 'Freileitung',
    spannungsebene: '110',
    stationen: ['st-duisburg', 'st-muelheim'],
    laenge: 12,
    planung: false,
  },
  {
    uuid: 'sk-3',
    langname: 'Mülheim ⟷ Essen',
    identifierKurz: 'K-110-03',
    typ: 'Kabel',
    spannungsebene: '110',
    stationen: ['st-muelheim', 'st-essen'],
    laenge: 8,
    planung: false,
  },
  {
    uuid: 'sk-4',
    langname: 'Essen ⟷ Bochum',
    identifierKurz: 'L-110-04',
    typ: 'Freileitung',
    spannungsebene: '110',
    stationen: ['st-essen', 'st-bochum'],
    laenge: 16,
    planung: false,
  },
  {
    uuid: 'sk-5',
    langname: 'Bochum ⟷ Dortmund',
    identifierKurz: 'L-220-05',
    typ: 'Freileitung',
    spannungsebene: '220',
    stationen: ['st-bochum', 'st-dortmund'],
    laenge: 14,
    planung: false,
  },
  {
    uuid: 'sk-6',
    langname: 'Dortmund ⟷ Duisburg',
    identifierKurz: 'L-220-06',
    typ: 'Freileitung',
    spannungsebene: '220',
    stationen: ['st-dortmund', 'st-duisburg'],
    laenge: 46,
    planung: false,
  },
  {
    uuid: 'sk-7',
    langname: 'Duisburg ⟷ Düsseldorf',
    identifierKurz: 'L-220-07',
    typ: 'Freileitung',
    spannungsebene: '220',
    stationen: ['st-duisburg', 'st-duesseldorf'],
    laenge: 22,
    planung: false,
  },
  {
    uuid: 'sk-8',
    langname: 'Düsseldorf ⟷ Wuppertal',
    identifierKurz: 'K-110-08',
    typ: 'Kabel+Freileitung',
    spannungsebene: '110',
    stationen: ['st-duesseldorf', 'st-wuppertal'],
    laenge: 26,
    planung: false,
  },
  {
    uuid: 'sk-9',
    langname: 'Wuppertal ⟷ Bochum',
    identifierKurz: 'L-110-09',
    typ: 'Freileitung',
    spannungsebene: '110',
    stationen: ['st-wuppertal', 'st-bochum'],
    laenge: 30,
    planung: false,
  },
  {
    uuid: 'sk-10',
    langname: 'Düsseldorf ⟷ Köln-Nord (geplant)',
    identifierKurz: 'L-380-10',
    typ: 'Freileitung',
    spannungsebene: '380',
    stationen: ['st-duesseldorf', 'st-koeln-nord'],
    laenge: 34,
    planung: true,
  },
  {
    uuid: 'sk-11',
    langname: 'Essen ⟷ Düsseldorf',
    identifierKurz: 'L-380-11',
    typ: 'Freileitung',
    spannungsebene: '380',
    stationen: ['st-essen', 'st-duesseldorf'],
    laenge: 32,
    planung: false,
  },
];

export const MOCK_GRID: MockTopology = {
  stations: STATIONS,
  transformers: TRANSFORMERS,
  circuits: CIRCUITS,
};
