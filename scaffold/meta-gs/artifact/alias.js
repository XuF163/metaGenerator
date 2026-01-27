/**
 * Artifact set alias/abbr table.
 *
 * This directory is treated as "scaffold" (runtime skeleton), so keep it minimal to avoid
 * frequent maintenance when the game updates. Missing aliases do NOT block meta usage:
 * users can still search by the full set name, and runtime also adds a numeric id-prefix
 * alias derived from `artifact/data.json` (see index.js `setIds` logic).
 *
 * If you want richer nicknames (e.g. 社区简称), extend here or generate it in meta-gen.
 */
export const setAbbr = {
  炽烈的炎之魔女: "魔女",
  昔日宗室之仪: "宗室",
  翠绿之影: "风套",
  绝缘之旗印: "绝缘",
  黄金剧团: "剧团"
}

export const setAlias = {
  炽烈的炎之魔女: "魔女",
  昔日宗室之仪: "宗室",
  翠绿之影: "风套,翠绿",
  绝缘之旗印: "绝缘",
  黄金剧团: "黄金,剧团"
}
