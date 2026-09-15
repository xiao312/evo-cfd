// Batch total: one batch is 8 base items, each carrying units_per_kit units.
// The intended total is printed as total=<n>.
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const config = JSON.parse(readFileSync(join(__dirname, "config.json"), "utf8"));
const baseItems = 8;
const total = baseItems * config.units_per_kit;

console.log(`total=${total}`);
