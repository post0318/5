// stub server-only for standalone test
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const Module = require("module");
const orig = Module._load;
Module._load = function (req, ...rest) {
  if (req === "server-only") return {};
  return orig.call(this, req, ...rest);
};
const { fetchClassAFacts } = await import("../src/lib/markets/us/edgar-classfacts.ts");
const cf = await fetchClassAFacts("0001403161", 4);
for (const [fy, y] of [...cf].sort((a,b)=>a[0]-b[0]))
  console.log(fy, "dEPS", y.epsDiluted, "bEPS", y.epsBasic, "dSh", y.dilShares, "bSh", y.basicShares, y.sourceAccn);
