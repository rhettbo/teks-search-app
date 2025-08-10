const fs = require("fs");
const path = require("path");

const filepath = path.join(__dirname, "teks_embeddings.json");
const raw = fs.readFileSync(filepath, "utf8");
const data = JSON.parse(raw);

// Get all unique grade + subject combinations
const uniqueCombos = new Set();

data.forEach(entry => {
  const grade = entry.grade?.trim() || "(missing)";
  const subject = entry.subject?.trim() || "(missing)";
  uniqueCombos.add(`${grade} — ${subject}`);
});

console.log("\n📋 Unique Grade + Subject combinations found:\n");
[...uniqueCombos].sort().forEach(combo => console.log("•", combo));
console.log(`\n✅ Total unique combinations: ${uniqueCombos.size}`);
console.log(`📦 Total embedded entries: ${data.length}`);
