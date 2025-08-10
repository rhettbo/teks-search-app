const fs = require("fs");
const csv = require("csv-parser");
const { OpenAI } = require("openai");
const cliProgress = require("cli-progress");
require("dotenv").config();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const results = [];

fs.createReadStream("teks.csv")
  .pipe(csv())
  .on("data", (row) => results.push(row))
  .on("end", async () => {
    console.log("🧪 First row example:", results[0]);

    const output = [];

    // ✅ Use entire CSV instead of slicing
    const sample = results;

    // Setup progress bar
    const bar = new cliProgress.SingleBar({
      format: "Embedding TEKS | {bar} | {percentage}% | {value}/{total} | {tek}",
      barCompleteChar: "█",
      barIncompleteChar: "-",
      hideCursor: true
    }, cliProgress.Presets.shades_classic);

    bar.start(sample.length, 0);

    for (let i = 0; i < sample.length; i++) {
      const entry = sample[i];
      const text = `${entry["Grade Level"]} ${entry.Subject} ${entry.TEK}: ${entry.STANDARD}`;

      try {
        const response = await openai.embeddings.create({
          model: "text-embedding-3-small",
          input: text
        });

        const embedding = response.data[0].embedding;

        output.push({
          grade: entry["Grade Level"],
          subject: entry.Subject,
          tek: entry.TEK,
          standard: entry.STANDARD,
          embedding
        });

        bar.update(i + 1, { tek: entry.TEK });

      } catch (err) {
        console.error("❌ Error embedding:", entry.TEK, err);
      }
    }

    bar.stop();
    fs.writeFileSync("teks_embeddings.json", JSON.stringify(output, null, 2));
    console.log("✅ Done! Saved ALL entries to teks_embeddings.json");
  });
