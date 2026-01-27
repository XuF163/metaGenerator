import { Data, Meta } from "#miao"
import lodash from "lodash"
import { abbr, aliasCfg } from "./alias.js"

// Supported paths (must match directory names under `meta-sr/weapon/`).
const types = ["存护", "丰饶", "毁灭", "同谐", "虚无", "巡猎", "智识", "记忆"]

let data = Data.readJSON("resources/meta-sr/weapon/data.json", "miao")

const meta = Meta.create("sr", "weapon")
meta.addData(data)
meta.addAlias(aliasCfg)
meta.addAbbr(abbr)

const weaponBuffs = {}
for (let type of types) {
  let calc = await Data.importDefault(`resources/meta-sr/weapon/${type}/calc.js`, "miao")
  if (lodash.isFunction(calc)) {
    calc = calc(
      (idx, key) => ({ isStatic: true, idx, key }),
      (title, key, idx) => {
        if (lodash.isPlainObject(key)) {
          return (tables) => {
            let data = {}
            lodash.forEach(key, (idx, k) => {
              data[k] = tables[idx]
            })
            return { title, data }
          }
        }
        return { title, idx, key }
      },
    )
  }
  lodash.forEach(calc, (ds, key) => {
    let id = meta.getId(key)
    if (id) weaponBuffs[id] = ds
  })
}

meta.addMeta({ weaponBuffs })

