/**
 * Scaffold-only artifact buff table (samples).
 *
 * Important:
 * - This directory is metaGenerator scaffold (runtime skeleton). Keep it minimal to avoid
 *   frequent maintenance when the game updates.
 * - The real `meta-gs/artifact/calc.js` should be generated from upstream APIs during
 *   `meta-gen gen` and will overwrite the output file.
 */
const buffs = {
  行者之心: {
    2: { title: '攻击力提高18%。', isStatic: true, data: { atkPct: 18 } },
    4: { title: '重击的暴击率提升30%。', data: { a2Cpct: 30 } }
  }
}

export default buffs

