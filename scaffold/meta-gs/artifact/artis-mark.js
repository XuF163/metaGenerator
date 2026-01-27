/**
 * 角色的默认圣遗物评分权重（少量样例）
 *
 * 说明：
 * - 本文件属于 metaGenerator scaffold（运行时骨架），建议保持精简，避免随版本频繁手动维护。
 * - 如 `character/<name>/artis.js` 下有角色自定义规则，运行时会优先使用自定义。
 * - 未配置的角色应回退到默认 `def()` 逻辑（由运行时决定具体策略）。
 */
export const usefulAttr = {
  芭芭拉: { hp: 100, atk: 50, cpct: 50, cdmg: 50, dmg: 80, recharge: 55, heal: 100 },
  甘雨: { atk: 75, cpct: 100, cdmg: 100, mastery: 75, dmg: 100 },
  雷电将军: { atk: 75, cpct: 100, cdmg: 100, mastery: 0, dmg: 75, recharge: 90 },
  胡桃: { hp: 80, atk: 50, def: 0, cpct: 100, cdmg: 100, mastery: 75, dmg: 100, phy: 0, recharge: 0, heal: 0 },
  那维莱特: { hp: 100, atk: 0, def: 0, cpct: 100, cdmg: 100, mastery: 0, dmg: 100, phy: 0, recharge: 55, heal: 0 }
}

