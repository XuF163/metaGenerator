// SR tree value compatibility modes (baseline-aligned)
//
// Baseline meta mixes two conventions for `tree.*.value`:
// - legacy fixed-point artifacts (e.g. 3.1999999890103936)
// - clean decimals (e.g. 3.2)
//
// This file encodes the per-character mode and the known fixed-point mappings.

export type SrTreeValueMode = 'fixed' | 'cpct7' | 'simple'

export const srTreeValueMode: Record<string, SrTreeValueMode> = {
  // cpct7: mostly clean, but CPCT=2.6999999 for 0.027
  '1220': 'cpct7',
  '1221': 'cpct7',
  '1312': 'cpct7',

  // simple: clean decimals (integers / 1 decimal)
  '1222': 'simple',
  '1223': 'simple',
  '1225': 'simple',
  '1301': 'simple',
  '1304': 'simple',
  '1306': 'simple',
  '1307': 'simple',
  '1308': 'simple',
  '1309': 'simple',
  '1310': 'simple',
  '1313': 'simple',
  '1314': 'simple',
  '1315': 'simple',
  '1317': 'simple',
  '1321': 'simple',
  '1401': 'simple',
  '1402': 'simple',
  '1403': 'simple',
  '1404': 'simple',
  '1405': 'simple',
  '1406': 'simple',
  '1407': 'simple',
  '1409': 'simple',
  '1415': 'simple',
  '8007': 'simple',
  '8008': 'simple'
}

export const srTreeFixedPercentByRatio: Record<string, number> = {
  '0.027': 2.699999953620136,
  '0.032': 3.1999999890103936,
  '0.04': 4.00000000372529,
  '0.048': 4.799999948590994,
  '0.05': 5.000000004656613,
  '0.053': 5.299999983981252,
  '0.06': 6.0000000055879354,
  '0.064': 6.399999978020787,
  '0.075': 7.499999972060323,
  '0.08': 8.00000000745058,
  '0.1': 10.000000009313226,
  '0.107': 10.699999961070716
} as const

export const srTreeCpct7PercentByRatio: Record<string, number> = {
  '0.027': 2.6999999
} as const

export const srTreeDataValueMode: Record<string, SrTreeValueMode> = {
  // fixed: use legacy fixed-point mapping for `treeData.*.data.*`
  '1005': 'fixed',
  '1006': 'fixed',
  '1014': 'fixed',
  '1015': 'fixed',
  '1205': 'fixed',
  '1212': 'fixed',
  '1408': 'fixed',
  '1410': 'fixed',
  '1412': 'fixed',
  '1413': 'fixed',
  '1414': 'fixed',
  '8001': 'fixed',
  '8002': 'fixed',
  '8003': 'fixed',
  '8004': 'fixed',
  '8005': 'fixed',
  '8006': 'fixed',

  // cpct7: mostly clean, but CPCT=2.6999999 for 0.027
  '1009': 'cpct7',
  '1013': 'cpct7',
  '1103': 'cpct7',
  '1112': 'cpct7',
  '1204': 'cpct7',
  '1208': 'cpct7',
  '1213': 'cpct7',
  '1220': 'cpct7',
  '1221': 'cpct7',
  '1305': 'cpct7',
  '1312': 'cpct7',
  '1402': 'cpct7',
  '1403': 'cpct7',
  '1405': 'cpct7',
  '1407': 'cpct7'
}
