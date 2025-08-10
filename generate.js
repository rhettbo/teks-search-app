console.log("🟢 generate.js is running from:", __filename);

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const rateLimit = require('express-rate-limit');
const stringSimilarity = require('string-similarity');
const lastPromptHashPerEndpoint = new Map();
const { OpenAI } = require('openai');
require('dotenv').config();
let fuzzy;
const crypto = require('crypto');
const axios = require("axios");
const puppeteer = require("puppeteer");

let browser;

(async () => {
  browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  console.log("🚀 Puppeteer browser launched");
})();


// 🧠 In-memory history map for retry deduplication per prompt
const outputHistoryMap = new Map();

// 🔑 Prompt tracking utilities
function getPromptHash(promptObj) {
  const str = JSON.stringify(promptObj);
  return crypto.createHash('md5').update(str).digest('hex');
}

function isDuplicate(promptHash, candidate) {
  const history = outputHistoryMap.get(promptHash) || [];
  return history.some(prev => stringSimilarity.compareTwoStrings(prev, candidate) > 0.9);
}

function saveOutput(promptHash, output) {
  const history = outputHistoryMap.get(promptHash) || [];
  if (!history.includes(output)) {
    history.push(output);
    outputHistoryMap.set(promptHash, history);
  }
}

function resetHistory(promptHash) {
  outputHistoryMap.delete(promptHash);
}

const app = express();

// ======= Static + CORS + Rate Limit =======
const PROD = process.env.NODE_ENV === 'production';
const APP_URL = process.env.APP_URL; // e.g., https://yourdomain.com

// Serve static front-end from /public
app.use(express.static(path.join(__dirname, 'public')));

// CORS: allow only your app origin in prod; looser in dev
const allowedOrigins = PROD ? [APP_URL].filter(Boolean) : [
  'http://localhost:5000',
  'http://localhost:5173'
];

app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true); // allow curl/postman
    cb(null, allowedOrigins.includes(origin));
  }
}));

// Basic rate limit for /api in prod
if (PROD) {
  app.use('/api', rateLimit({ windowMs: 60_000, max: 60 }));
}

// Body parsers
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
// ==========================================

// Optional: rate-limit API calls in production
if (PROD) {
  app.use('/api', rateLimit({ windowMs: 60_000, max: 60 }));
}
// ===========================================
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));


const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// 🔍 Load TEKS Embeddings
let teksEmbeddings = [];
const embeddingsPath = path.join(__dirname, "teks_embeddings.json");
try {
  const raw = fs.readFileSync(embeddingsPath, "utf8");
  teksEmbeddings = JSON.parse(raw);
  console.log(`📄 Loaded ${teksEmbeddings.length} TEKS embeddings`);

  // 🔤 Build fuzzy dictionary from TEKS standards
  const FuzzySet = require('fuzzyset.js');
  const corpusWords = teksEmbeddings
    .flatMap(e => e.standard.split(/\W+/))
    .map(w => w.toLowerCase())
    .filter(w => w.length > 3); // ignore short/noise words

  const dictionary = [...new Set(corpusWords)];
  fuzzy = FuzzySet(dictionary);
  console.log(`📚 Built fuzzy dictionary with ${dictionary.length} unique words`);
} catch (err) {
  console.error("❌ Failed to load teks_embeddings.json or build fuzzy dictionary:", err);
}


// 🔢 Cosine similarity function
function cosineSimilarity(vecA, vecB) {
  const dot = vecA.reduce((sum, val, i) => sum + val * vecB[i], 0);
  const magA = Math.sqrt(vecA.reduce((sum, val) => sum + val * val, 0));
  const magB = Math.sqrt(vecB.reduce((sum, val) => sum + val * val, 0));
  return dot / (magA * magB);
}

// 🔹 Request logging middleware
app.use((req, res, next) => {
  console.log(`\n🔹 [${new Date().toISOString()}] ${req.method} ${req.url}`);
  if (req.body) {
    console.log("📦 Request Body:", JSON.stringify(req.body, null, 2));
  }
  next();
});

// ✅ Test if server is alive
app.get("/test", (req, res) => {
  console.log("✅ /test hit");
  res.send("Server is up!");
});

// ✅ Debug OpenAI API connection
app.get("/debug", async (req, res) => {
  console.log("🐛 /debug hit — testing OpenAI API");
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "Say hello and tell me today's date." }
      ],
      temperature: 0.2,
      max_tokens: 100,
    });

    const reply = completion.choices?.[0]?.message?.content?.trim() || "❌ No response from OpenAI.";
    console.log("✅ GPT Response:\n", reply);
    res.send(reply);
  } catch (err) {
    console.error("❌ OpenAI debug error:", err.response?.data || err.message || err);
    res.status(500).send("❌ OpenAI API test failed.");
  }
});

// ✅ Real API for generating objectives
app.post('/api/generate', async (req, res) => {
  const { prompt, grade, subject } = req.body;

  if (!prompt || typeof prompt !== "string" || prompt.trim() === "") {
    return res.status(400).json({ error: "Invalid prompt provided." });
  }

  const safePrompt = prompt.trim();
  const promptHash = getPromptHash({ prompt: safePrompt, grade, subject });
  const routeKey = "/api/generate-assessment-preview";
const lastHash = lastPromptHashPerEndpoint.get(routeKey);

if (lastHash && lastHash !== promptHash) {
  console.log("🔄 New prompt detected — clearing old history.");
  resetHistory(promptHash);
}

lastPromptHashPerEndpoint.set(routeKey, promptHash);

  const history = outputHistoryMap.get(promptHash) || [];
  const historyBlock = (history.length > 0)
  ? `You have already generated the following objectives. Do not repeat ideas:\n\n${history.map((p, i) => `#${i + 1}:\n${p.trim()}\n`).join('\n')}`
  : '';

  const fullPrompt = `You are designing classroom-ready learning objectives for **Grade ${grade} ${subject}** based on the following standards. You are not working with TEK codes. Do not ask for TEKS or clarification. If the prompt appears short or incomplete, proceed using your best judgment to generate objectives anyway.

Based on the following standards, synthesize and combine them into exactly 3 student-friendly learning objective pairs in the "We will / I will" format.

Each pair should:
- Combine multiple ideas presented within the prompt cohesively. (not list them separately)
- Be meaningful, relevant, and clearly aligned to real-world or classroom-based student performance
- Use specific, measurable, observable action verbs from Bloom’s levels 3–6 (Apply, Analyze, Evaluate, Create)
- Include all 3 parts of a strong objective: action, condition, and standard (where possible)
- Avoid vague terms like "understand" or "learn"
- Focus on post-learning performance, not activities done during instruction
- Prioritize verbs tied to grade-level cognitive expectations

The goal is to create objectives that feel like a coherent, focused lesson — not a checklist.

Format:
1) We will...
   I will...

Only return the 3 objective pairs. Do not include explanations or extra text.

Example Prompt:
explain the roles of various world leaders, including Benito Mussolini, Adolf Hitler, Hideki Tojo, Joseph Stalin, Franklin D. Roosevelt, and Winston Churchill, prior to and during World War II; and explain the major causes and events of World War II, including the German invasions of Poland and the Soviet Union, the Holocaust, the attack on Pearl Harbor, the Normandy landings, and the dropping of the atomic bombs

Example Output:
1) We will analyze how leadership decisions by major World War II figures influenced global alliances and conflict outcomes.  
   I will evaluate decisions made by at least 4 of the 6 key leaders—Mussolini, Hitler, Tojo, Stalin, Roosevelt, and Churchill—using a primary-source excerpt or timeline, and explain how each decision contributed to a major turning point in the war.

or

1) We will examine how DNA’s structure allows it to carry genetic information and how that information influences traits.  
   I will identify the components of a DNA molecule, explain how the sequence of nucleotides encodes specific traits, and evaluate one scientific explanation for the origin of DNA.

Standards:

${safePrompt}
`;

  console.log("\n📤 Sending to OpenAI API:");
  console.log("📝 Full Prompt:\n", fullPrompt);
  console.log("--------------------------------");

  try {
  let retries = 3;
  let objectives = "";

  while (retries-- > 0) {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: "You are a curriculum expert creating concise, student-friendly learning objectives.",
        },
        ...(historyBlock ? [{ role: "user", content: historyBlock }] : []),
        {
         role: "user",
         content: fullPrompt,
        },
        ],
      temperature: 0.85,
      max_tokens: 300,
    });

    const candidate = completion.choices?.[0]?.message?.content?.trim();
    if (candidate && !isDuplicate(promptHash, candidate)) {
      objectives = candidate;
      saveOutput(promptHash, candidate);
      break;
    }
  }

  if (!objectives) {
    return res.status(500).json({ error: "Repeated duplicate outputs. Please try again." });
  }

  res.json({ objectives });


  } catch (err) {
    console.error("❌ OpenAI error:", err.response?.data || err.message || err);
    res.status(500).json({ error: "Failed to generate objectives." });
  }
});

// ✅ Smart Search via embedding similarity
app.post("/api/semantic-search", async (req, res) => {
  const { query, grade, subject } = req.body;

  if (!query || !grade || !subject) {
    return res.status(400).json({ error: "Missing query, grade, or subject" });
  }

  try {
  const embedded = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: query,
  });

  const userEmbedding = embedded.data[0].embedding;

  console.log("📩 Incoming query:", { grade, subject, query });

  const filtered = teksEmbeddings.filter(e =>
    e.grade === grade && e.subject === subject
  );

    console.log(`📊 Found ${filtered.length} TEKS for grade="${grade}" & subject="${subject}"`);

    const scored = filtered.map(e => ({
      ...e,
      similarity: cosineSimilarity(userEmbedding, e.embedding),
    }));

    scored
     .sort((a, b) => b.similarity - a.similarity)
    .slice(0, 5)
    .forEach((e, i) => {
      console.log(`🔍 Match #${i + 1}: ${e.tek} → ${e.similarity.toFixed(4)}`);
      console.log(`   ${e.standard}`);
    });

    const threshold = 0.25;
    const topResults = scored
      .filter(e => e.similarity >= threshold)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, 10)
      .map(({ embedding, ...rest }) => rest)

    res.json({ results: topResults });
  } catch (err) {
    console.error("❌ Semantic search error:", err.response?.data || err.message || err);
    res.status(500).json({ error: "Failed to perform semantic search" });
  }
});

// ✅ New API for generating lesson plans
app.post('/api/generate-lesson', async (req, res) => {
  const { prompt, grade, subject, duration } = req.body;
  const promptHash = getPromptHash({ prompt, grade, subject, duration });
const routeKey = "/api/generate-assessment-preview";
const lastHash = lastPromptHashPerEndpoint.get(routeKey);

if (lastHash && lastHash !== promptHash) {
  console.log("🔄 New prompt detected — clearing old history.");
  resetHistory(promptHash);
}

lastPromptHashPerEndpoint.set(routeKey, promptHash);

const history = outputHistoryMap.get(promptHash) || [];
const historyBlock = (history.length > 0)
  ? `You have already generated the following lesson plans. Do NOT repeat the same activities or learning objectives:\n\n${history.map((p, i) => `#${i + 1}:\n${p.trim()}\n`).join('\n')}`
  : '';

  if (!prompt || !grade || !subject || !duration) {
    return res.status(400).json({ error: "Missing prompt, grade, subject, or duration." });
  }

  // ── Build the lessonPrompt ──
const lessonPrompt = `
You are an expert curriculum designer. Create a lesson plan with a minimalist, clean aesthetic that is teacher-friendly.

Given the input under **Standards and Objectives**, generate **TWO distinct ${duration}-minute lesson plans** for **Grade ${grade} ${subject}**.

---

### Standards and Objectives:
${prompt}

---

### Your Task:
1. If the input already contains explicit "We will…" and "I will…" objectives, copy those exactly.
2. Otherwise, write a two-line Learning Objective:
   - First line starts with: "We will …"
   - Second line starts with: "I will …"

---

### Output Format (Markdown):
Repeat this full template twice (Option 1 and Option 2). Do not include any extra lines or headings before the Lesson Title.

**Lesson Plan Option X:**

**Lesson Title:** [Creative Title Here]

**Learning Objective:**
Leave a blank line under "learning objective" heading. List each objective. Bold only the first two words of each line "We will" and "I will. Leave a blank line between each one.

**We will** complete the objective…

**I will** complete the objective…

**Materials:**
Materials will appear in vertically stacked, bullet-point list. Leave a blank line under "Materials" heading.

• Item A
• Item B
• Item C

**ACTIVITIES (Total: ${duration} minutes)**  
List each activity with its title and time. Do not number them. Leave a blank line between each one.

**Activity Title** (X minutes)  
Description...

**Next Activity** (X minutes)  
Description...

**Next Activity** (X minutes)  
Description...

**Assessment:**
Leave one blank line under the header, and one blank line between the Formative assessment and Summative assessment. Bold the 'Formative:' and 'Summative:' at the start of the two lines.

**Formative:** How the teacher checks for understanding during the lesson  

**Summative:** What product or work will be collected for evaluation

---

### Requirements:  
- The two lesson plan options should be distinct and unique from one another.
- Use explicit instruction: model > guided practice > independent work
- Lessons should contain zero bias  
- Lessons should apply an appropriate level of rigor for the grade level and subject
- Include frequent checks for understanding and real-time feedback  
- Be sequenced for clarity and student engagement  
- Encourage and promote student synthesis
- Build in:
  - Metacognitive reflection  
  - Student discussion  
  - Differentiation (flexible grouping, scaffolds)  
- Align rigorously to standards and target higher-order thinking  
- Be practical, effective, low-prep and teacher-friendly
- Each option must be unique in theme, tone, and instructional flow.
- Avoid using the same sentence structure or examples between the two.
- Each lesson must be executable within the given time.
- **You must clearly specify the time for each activity. The total should add up to ${duration} minutes.**
- Ensure responses parse cleanly — keep titles and headings properly labeled and no HTML.

Return **only** the two lesson plans. Do not add any commentary or notes.
`;


  try {
    let retries = 3;
let content = "";

while (retries-- > 0) {
  const completion = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      { role: "system", content: "You are an expert curriculum designer." },
      ...(historyBlock ? [{ role: "user", content: historyBlock }] : []),
      { role: "user", content: lessonPrompt }
    ],
    temperature: 0.85,
    max_tokens: 1000
  });

  const candidate = completion.choices?.[0]?.message?.content?.trim();
  if (candidate && !isDuplicate(promptHash, candidate)) {
    content = candidate;
    saveOutput(promptHash, candidate);
    break;
  }
}

if (!content) {
  return res.status(500).json({ error: "Repeated duplicate outputs. Try again." });
}

    res.json({ lessonPlans: content });

  } catch (err) {
    console.error("❌ Lesson generation error:", err);
    res.status(500).json({ error: "Failed to generate lesson plans." });
  }
});

///------Google Forms Generator------///

const { createGoogleFormQuiz } = require("./googleforms");

app.post("/api/create-form", async (req, res) => {
  const { title = "My Test Google Form", questions = [] } = req.body || {};
  console.log("🔹 Incoming /api/create-form request...");
  console.log("📦 Request Title:", title);
  console.log("📦 Questions:", JSON.stringify(questions, null, 2));

  try {
    const formUrl = await createGoogleFormQuiz({ title, questions });
    console.log("✅ Form URL:", formUrl);
    res.json({ url: formUrl });
  } catch (error) {
    console.error("❌ Error creating form:");
    if (error.response?.data) {
      console.error("🧨 Google API Error:", JSON.stringify(error.response.data, null, 2));
    } else {
      console.error(error);
    }
    res.status(500).json({ error: "Internal server error", details: error.message });
  }
});

//-----Generate Assessment Preview-----//

app.post("/api/generate-assessment-preview", async (req, res) => {
  const {
    type,
    questionCount = 5,
    formats = [],
    source,
    grade,
    subject,
    essayStyle,
    elaMode
  } = req.body;

  // 🔁 Redirect to /api/generate-ela-assessment if in ELA mode
if (elaMode && type === "mixed") {
  console.log("🧠 [Redirecting] ELA Mode triggered — rerouting via axios");

  try {
let selectedTEKSList = req.body.selectedTEKS || [];

// Safely parse stringified TEKS, if needed
if (selectedTEKSList.length > 0 && typeof selectedTEKSList[0] === "string") {
  selectedTEKSList = selectedTEKSList.map(t => {
    try {
      return JSON.parse(t);
    } catch {
      return {}; // fallback to avoid crash
    }
  });
}

const teksString = selectedTEKSList.length
  ? `\n\nThese are the TEKS standards we want to practice with this assignment. They should be the foundation for the questions generated on the assessment:\n${selectedTEKSList.map(t => `- ${t.standard || ""}`).join("\n")}`
  : "";

console.log("📘 TEKS being sent to ELA mode:", teksString);

 const BASE_URL = process.env.APP_URL || `http://localhost:${process.env.PORT || 5000}`;
 const response = await axios.post(`${BASE_URL}/api/generate-ela-assessment`, {
   prompt: `${(source?.content || "").trim()}${teksString}`,
   grade,
   subject,
   questionCount,
   formats
 });

    return res.json(response.data);
  } catch (err) {
    console.error("❌ Failed to proxy ELA request:", err.response?.data || err.message);
    return res.status(500).json({ error: "Failed to proxy to ELA route" });
  }
}


  const promptHash = getPromptHash({ type, questionCount, formats, content: source?.content, grade, subject, essayStyle });
  const routeKey = "/api/generate-assessment-preview";
  const lastHash = lastPromptHashPerEndpoint.get(routeKey);

  if (lastHash && lastHash !== promptHash) {
    console.log("🔄 New prompt detected — clearing old history.");
    resetHistory(promptHash);
  }

  lastPromptHashPerEndpoint.set(routeKey, promptHash);

  const history = outputHistoryMap.get(promptHash) || [];
  const historyBlock = (history.length > 0)
    ? `You have already generated the following essay prompts. DO NOT reuse the same roles, formats, tones, or narrative structures. Be original, varied, and creative in your next attempt:\n\n${history.map((p, i) => `#${i + 1}:\n${p.trim()}\n`).join('\n')}`
    : '';

  console.log("🧠 Prior outputs included in retry:", history);
  console.log("🧠 Injected anti-repeat message:\n", historyBlock);
  console.log("📥 Received /api/generate-assessment-preview");
  console.log({ type, questionCount, formats, source, grade, subject });

  try {
    let content = source?.content?.trim();

    // Normalize TEKS for both paths
let selectedTEKSList = req.body.selectedTEKS || [];
if (selectedTEKSList.length > 0 && typeof selectedTEKSList[0] === "string") {
  selectedTEKSList = selectedTEKSList.map(s => {
    try { return JSON.parse(s); } catch { return {}; }
  });
}

// ✅ Inject TEKS if present and not already embedded
if (source?.type !== "teks" && selectedTEKSList.length > 0) {
  const standards = selectedTEKSList
    .map(t => t?.standard)
    .filter(Boolean)
    .join("\n- ");

  if (standards) {
    const standardsBlock = `
The following are the TEKS standards to be addressed in this assessment. Use them as the instructional foundation and lens for analyzing the provided source material. Only generate assessment items that align with these standards:

- ${standards}

`;
    content = `${standardsBlock}${content}`;
  }
}

  // 🔧 Dynamically construct instructions based on selected formats
  let formatBlock = "";
  if (type === "mixed" && formats.length) {
    const allowed = formats.map(f => f.toLowerCase()).join(", ");
    formatBlock = `

Only include the following formats in your questions: ${allowed}.
Do NOT include any question formats outside of this list.`;
  }

  if (!content || !grade || !subject) {
    return res.status(400).json({ error: "Missing required fields: content, grade, or subject." });
  }

// 🔎 Token length check
const approxTokenCount = Math.ceil(content.split(/\s+/).length * 1.3);
const MAX_TOKENS_ALLOWED = 20000;

if (approxTokenCount > MAX_TOKENS_ALLOWED) {
  return res.status(400).json({
    error: `⚠️ This document is too long (${approxTokenCount} tokens). Please shorten the content before generating an assessment.`
  });
}

const prompt = `
You are an expert teacher creating a ${type} assessment${type === "essay" && essayStyle ? ` in the style of a ${essayStyle} prompt` : ""} for Grade ${grade} ${subject}.

Use the following instructional content to generate STAAR-style assessment questions. All items must mirror the tone, structure, and rigor found in STAAR-released tests for the specified subject and grade level.

Each assessment will always begin with a title formatted like this:

Title: [Your creatively generated title for the entire form goes here]

Title rules:
- Do NOT use the word "Mixed"
- If the assessment is mixed-format, simply end the title with the word "Assessment"
- If the assessment is a 'Quick Write' or 'Essay', include those terms appropriately
- Keep it under 12 words
- Make the title grade- and subject-relevant
- Do not include explanations, markdown, or extra line breaks before or after the title

${formatBlock}

${type === "mixed" ? `Use a mix of these types: ${formats.join(", ")}` : ""}

${["mixed", "multiple"].includes(type) ? `

🧠 STAAR Question Quality Guidelines:

- All questions must follow the structure and rigor of STAAR-released items
- Use a mix of literal, inferential, and analytical questions
- Questions must be clearly based on the source content
- Include STAAR-style distractors that are plausible but clearly incorrect
- Use TEKS-aligned vocabulary-in-context when appropriate
- In Science and Social Studies, emphasize cause/effect, comparison, reasoning, and conceptual clarity
- In Math, favor problem-solving and multi-step reasoning over isolated computation
- For Short Answer, require synthesis or explanation, not just recall
- True/False items should reflect concept understanding and not be giveaways
- Avoid trick questions, vague prompts, or trivia

// 📌 FORMATTING INSTRUCTIONS — STRICT


Return the assessment in the following strict format for each question:

---

Type: [Multiple Choice | True/False | Short Answer]

Question: [The full question prompt]

A) [Option A]  
B) [Option B]  
C) [Option C]  
D) [Option D]  
Correct Answer: [Letter]   ← for Multiple Choice & True/False only

Expected Response: [Answer] ← for Short Answer only

---

RULES:
- Do NOT include question numbers or titles like "1." or "**Multiple Choice**"
- Type must be one of: "Multiple Choice", "True/False", or "Short Answer"
- Evenly disperse all selected question types throughout the assessment
- For Multiple Choice and True/False, include exactly 4 or 2 options respectively
- Each multiple-choice question must have exactly **one correct answer**, and it must match one of the provided options (A–D)
- Do NOT list more than one correct answer per question
- The "Correct Answer" field must always be included and must match the correct letter of the option
- For Short Answer, omit choices and only include "Expected Response" — concise and specific
- For Multiple Choice:
  - Use exactly 4 answer choices: A, B, C, and D
  - Each letter (A, B, C, D) must be the correct answer in **at least 1 out of every 6 questions**
  - If you generate 8+ questions, each letter should be used **at least twice** as the correct answer
  - Randomize correct answer placement intelligently — do NOT overuse A or B
  - Avoid placing the correct answer in the same position repeatedly
- Each question should be 1–2 sentences. Keep prompts concise and focused.
- Ensure the correct answer can be clearly and unambiguously validated by the source content. If not, skip the question.
- Do NOT omit the "Correct Answer" field on Multiple Choice or True/False questions
- Separate all questions using exactly three dashes \`---\` on their own line
- Use consistent spacing and indentation for all parts
- Avoid using markdown (no bold, italics, or bullets)

✅ STAAR CONTENT-INTEGRITY ENFORCEMENT:
- Questions must directly reflect the rigor, clarity, and cognitive demand of STAAR items
- Do not invent facts or include content not grounded in the instructional source
- Avoid generalizations — every item must be tied clearly to the provided instructional material
- Do not rely on external background knowledge unless directly inferable from the source
- Do not fabricate names, tribes, historical facts, or scientific conclusions

✅ QUALITY & ACCURACY RULES:
- Carefully verify that each question and answer is factually accurate and based on the instructional content below.
- Do not invent facts or include information that cannot be reasonably inferred from the source content.
- If the correct answer is unclear or uncertain, skip generating the question.
- Each distractor (incorrect option) should be plausible but clearly incorrect.
- Do not write trick questions or use ambiguous language.
- Only generate questions that are instructionally appropriate for the specified grade and subject.
- Keep vocabulary and syntax age-appropriate and clear.

📚 CONTENT-INTEGRITY ENFORCEMENT:
- You must only generate questions and answers that can be directly supported by the content provided below.
- Do not include people, events, or concepts not explicitly mentioned in the source material.
- Do not rely on external background knowledge. If something is not mentioned in the content, do not assume it.
- If multiple plausible answers exist, always select the one most clearly supported by the given instructional content.
- Never insert plausible-sounding but unsupported facts (e.g. "Cherokee") if they are not found in the provided source.
` : ""}

Content:
Below is the source content provided by the teacher. This content may be a list of standards, a lesson plan, or a reference document. Your job is to extract and use only the parts that are instructionally relevant, grade-appropriate, and aligned with STAAR expectations for the specified subject.

Only generate questions or prompts that reflect the rigor, clarity, and structure of STAAR assessments.

${source.content}

Task:
${
  type === "essay"
    ? `

// Essay Style Rules
${
  (() => {
    switch (essayStyle) {
      case "argumentative":
        return `Write a prompt that asks students to state a clear position on an issue and defend it using evidence, logic, and acknowledgment of opposing views.`;
      case "compare-contrast":
        return `Write a prompt that requires students to examine both similarities and differences between two subjects, concepts, or events in a balanced manner.`;
      case "DBQ":
        return `Write a Document-Based Question (DBQ) prompt that encourages students to evaluate evidence, synthesize historical documents, and form a supported argument or analysis.`;
      case "descriptive":
        return `Write a prompt that encourages rich sensory language and vivid description of a person, place, object, or event.`;
      case "expository":
        return `Write a prompt that guides students to explain a process, idea, or how-to in a clear, logical, and informative way.`;
      case "informative":
        return `Write a prompt that encourages students to research or explain a factual topic in a structured and neutral tone.`;
      case "literary":
        return `Write a prompt that guides students to analyze theme, character, or language in a literary work using textual evidence.`;
      case "narrative":
        return `Write a prompt that allows students to craft a creative story with characters, plot, and setting. It should involve reflection or conflict.`;
      case "persuasive":
        return `Write a prompt that requires students to convince the reader of an opinion or solution using emotional appeal, facts, and logic.`;
      case "RAFT":
        return `Write a RAFT (Role, Audience, Format, Topic) essay prompt. You must explicitly state each RAFT component in the prompt instructions (e.g., "As a [Role], write a [Format] to [Audience] about [Topic]"). Ensure the task encourages students to write creatively from that point of view of someone, whether real or fictional, from WITHIN the content, not as a historian, teacher, or journalist unless they are key figures in the content being taught.`;
      default:
        return `Write an age-appropriate, content-aligned essay prompt that clearly assesses student understanding of the core instructional material.`;
    }
  })()
}

// Prompt structure Instructions

Write a single ${essayStyle || ""} essay prompt that evaluates student understanding of the core subject material. The prompt must reflect STAAR Writing expectations for structure, clarity, and critical thinking. You may incorporate people, places, events, concepts, or themes that are not explicitly listed in the objective, as long as they are clearly aligned with the TEKS and grade-level appropriate. When objectives are broad or vague, choose specific, content-valid examples to target.

The prompt should be 30–50 words and must:
- Require students to make personal, analytical, or evidence-based connections to the content
- Be clear, grade-appropriate, and aligned with the academic language used in STAAR prompts
- Avoid giving examples, sample answers, or meta commentary

📌 FORMAT EXAMPLE:
Prompt: 30-50 words of copy here.`

    : type === "quickwrite"
    ? `Write a single quick write prompt that evaluates student understanding of the core subject material. The prompt should reflect STAAR-aligned thinking and encourage clear expression of ideas. You may include people, places, events, concepts, or themes that are not explicitly named in the objective if they are clearly connected to the standard and grade-appropriate. When objectives are broad, choose a focused example that supports TEKS alignment.

The prompt should be 15–30 words and must:
- Be answerable in 3–5 minutes with evidence-based or reasoning-based thinking
- Be open-ended enough to reveal student understanding, misconceptions, or insight
- Use STAAR-style clarity: concise language, no unnecessary background, and accessible phrasing for the grade level

📌 FORMAT EXAMPLE:
Prompt: 15-30 words of copy here.`

    : type === "mixed"
    ? `Create a mixed-format assessment with EXACTLY ${questionCount} total questions using the following formats: ${formats.join(", ")}. Mix up the various question format types evenly and randomly across the entire assessment. If 'multiple choice' is included, it should make up at least 60% of the questions. Avoid repeating questions and evenly distribute correct answer letter distribution. Each item must mirror STAAR-style assessments and align with TEKS objectives. Use a balance of cognitive levels—recall, application, and analysis. Questions should reflect the tone, complexity, and structure of released STAAR items. Provide correct answers for multiple choice and true/false. Provide expected responses for short answer only.`

: `Write ${questionCount} multiple-choice questions that reflect the structure, tone, and rigor of STAAR-released assessments. Each question must be clearly aligned with TEKS objectives and appropriate for the specified grade and subject. Include a mix of difficulty levels and reasoning types. Provide 4 answer choices and indicate the correct one.`

}
`;

  // 🧠 Retry-aware variation setup
const versionHint = `// version: retry`;

const nudges = [
  "Take a fresh angle.",
  "Frame the topic from a new perspective.",
  "Vary the tone or style from previous attempts.",
  "Avoid repeating prior phrasing or structure.",
  "Introduce a surprising viewpoint.",
  "Make this prompt feel distinct from others.",
  "Emphasize a different conceptual lens.",
  "Approach from a lesser-considered angle.",
  "Highlight an unconventional implication.",
  "Prompt a different kind of student thinking.",
];
const nudge = nudges[Math.floor(Math.random() * nudges.length)];

const fullPrompt = `${nudge}\n${versionHint}\n\n${prompt}`;

const estimateTokens = (text) => Math.ceil(text.split(/\s+/).length * 1.3);

const tokenEstimate =
  estimateTokens(
    [
      nudge,
      versionHint,
      prompt,
      historyBlock || "",
      source.content || ""
    ].join(" ")
  ) + 1000;


if (tokenEstimate > 28000) {
  return res.status(400).json({
    error: `Transcript too long — estimated ${tokenEstimate} tokens. Please trim your content to fit under 28,000 tokens.`,
  });
}

let retries = 3;
let text = "";

while (retries-- > 0) {

console.log("🧪 Prompt Preview:\n", prompt);


  const messages = [
    {
      role: "system",
      content:
        "You are a curriculum specialist who creates STAAR-aligned, classroom-ready assessments, engaging essay prompts, and high-quality check-for-understanding quick-write prompts. All questions must reflect the tone, rigor, structure, and clarity of released STAAR items. Mixed assessments should resemble what appears in STAAR-aligned textbook section or chapter reviews, with appropriate TEKS alignment throughout.",
    },
    ...(historyBlock ? [{ role: "user", content: historyBlock }] : []),
    {
      role: "user",
      content: fullPrompt,
    },
  ];

  console.log("📤 Final messages to GPT:", JSON.stringify(messages, null, 2));

  const completion = await openai.chat.completions.create({
    model: "gpt-4o",
    temperature: 0.85,
    max_tokens: 9000,
    messages,
  });

  const candidate = completion.choices?.[0]?.message?.content?.trim();
  if (candidate && !isDuplicate(promptHash, candidate)) {
    text = candidate;
    saveOutput(promptHash, candidate);
    break;
  }
}

if (!text) {
  return res.status(500).json({ error: "Repeated duplicate outputs. Please try again." });
}

if (type === "mixed" || type === "multiple") {
  const rebalanced = rebalanceMCAnswers(text, questionCount);
  if (rebalanced) {
    text = rebalanced;
  } else {
    console.warn("⚠️ Rebalancing failed or skipped — using original text");
  }
}

if (!text) return res.status(500).json({ error: "No content returned by GPT." });

// 🔁 Return clean and balanced preview text
res.json({ preview: text });


} catch (err) {
  console.error("❌ Error generating assessment:", err);

  const message = err?.response?.data?.error?.message || err?.message || "Internal server error";

  // Optional: Custom handling for known token overflow errors
  if (message.includes("tokens per min") || message.includes("TPM")) {
    return res.status(400).json({
      error: "⚠️ This request exceeds your token-per-minute limit (30,000 TPM). Try reducing input size or wait a moment before retrying.",
    });
  }

  res.status(500).json({ error: message });
}

}); // 👈 CLOSES /api/generate-assessment-preview route

// ✅ Auto-rebalance correct answers if it's multiple choice
function rebalanceMCAnswers(raw, questionCount) {
  try {
    console.log("Rebalancing multiple choice answers...");

    const blocks = raw.split(/\n?-{3,}\n?/g).map(b => b.trim()).filter(Boolean);
    const updatedBlocks = [...blocks]; // clone the array to modify

    const blockData = [];

    blocks.forEach((b, i) => {
      const correctMatch = b.match(/Correct Answer:\s*([A-D])/i);
      if (!correctMatch) return;

      const letter = correctMatch[1].toUpperCase();
      const choices = [...b.matchAll(/([A-D])\)\s*(.+)/g)].map(match => ({
        label: match[1],
        text: match[2].trim(),
      }));

      if (choices.length !== 4) return;

      const correctText = choices.find(c => c.label === letter)?.text;
      if (!correctText) return;

      blockData.push({ index: i, raw: b, letter, choices, correctText });
    });

    const total = blockData.length;
    console.log(`Detected ${total} multiple-choice questions`);

    const originalDist = blockData.reduce((acc, block) => {
      acc[block.letter] = (acc[block.letter] || 0) + 1;
      return acc;
    }, {});
    console.log("Original answer distribution:", originalDist);

    const base = Math.floor(total / 4);
    const remainder = total % 4;
    let answerPool = [
      ...Array(base).fill("A"),
      ...Array(base).fill("B"),
      ...Array(base).fill("C"),
      ...Array(base).fill("D"),
    ];
    for (let i = 0; i < remainder; i++) {
      answerPool.push("ABCD"[i]);
    }

    // Shuffle answer pool
    for (let i = answerPool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [answerPool[i], answerPool[j]] = [answerPool[j], answerPool[i]];
    }

    blockData.forEach((block, i) => {
      const { index, raw, correctText, choices } = block;

      const wrongChoices = choices.filter(c => c.text !== correctText);
      const shuffledWrong = [...wrongChoices].sort(() => 0.5 - Math.random());

      const assignedLetter = answerPool[i];
      const insertIndex = "ABCD".indexOf(assignedLetter);

      const finalChoices = [...shuffledWrong];
      finalChoices.splice(insertIndex, 0, { label: assignedLetter, text: correctText });

      const updatedChoices = finalChoices
        .map((choice, idx) => `${"ABCD"[idx]}) ${choice.text}`)
        .join("\n");

      const questionMatch = raw.match(/Question:\s*([\s\S]*?)(?=\n[A-D]\))/i);
      const questionText = questionMatch ? questionMatch[1].trim() : "Untitled Question";

      const rebuilt = `Type: Multiple Choice\n\nQuestion: ${questionText}\n${updatedChoices}\nCorrect Answer: ${assignedLetter}`;

      updatedBlocks[index] = rebuilt;
    });

    const finalDist = blockData.reduce((acc, block, i) => {
      const match = updatedBlocks[block.index].match(/Correct Answer:\s*([A-D])/i);
      const letter = match?.[1];
      acc[letter] = (acc[letter] || 0) + 1;
      return acc;
    }, {});

    console.log("✅ Rebalanced answer distribution:");
    console.table(finalDist);

    const finalOutput = updatedBlocks.join("\n\n---\n\n");

    console.log(`🕲 Final block count: ${updatedBlocks.length} vs expected: ${blocks.length}`);
    if (updatedBlocks.length !== blocks.length) {
      console.warn(`Mismatch: expected ${blocks.length} questions but got ${updatedBlocks.length}`);
      return null;
    }

    return finalOutput;
  } catch (err) {
    console.error("❌ Error generating assessment:", err);
    return null;
  }
}

// 📘 NEW ELA Assessment Endpoint
app.post("/api/generate-ela-assessment", async (req, res) => {
  const { prompt, grade, subject, questionCount = 5, formats = [] } = req.body;
  const promptHash = getPromptHash({ prompt, grade, subject, questionCount, formats });
  const routeKey = "/api/generate-ela-assessment";

  const lastHash = lastPromptHashPerEndpoint.get(routeKey);
  if (lastHash && lastHash !== promptHash) {
    console.log("🔄 New ELA prompt detected — clearing history.");
    resetHistory(promptHash);
  }
  lastPromptHashPerEndpoint.set(routeKey, promptHash);

  const history = outputHistoryMap.get(promptHash) || [];
  const historyBlock = history.length
    ? `You already created the following questions. DO NOT repeat tone, structure, or ideas:\n\n${history.map((p, i) => `#${i + 1}:\n${p.trim()}\n`).join("\n")}`
    : "";

  if (!prompt || !grade || !subject) {
    return res.status(400).json({ error: "Missing prompt, grade, or subject." });
  }

  // 🔧 Normalize formats coming from the UI
const normalized = (formats || []).map(f => f.toLowerCase());
const allowedTypeList = [];
if (normalized.includes("multiple"))  allowedTypeList.push("Multiple Choice");
if (normalized.includes("truefalse")) allowedTypeList.push("True/False");
if (normalized.includes("short"))     allowedTypeList.push("Short Answer");
// default if nothing selected
if (allowedTypeList.length === 0) allowedTypeList.push("Multiple Choice");

  // 🔤 Prompt Template — ELAR Specific
  const fullPrompt = `
You are a STAAR-aligned English Language Arts assessment creator.
Create EXACTLY ${questionCount} assessment questions for Grade ${grade} ${subject}.
Use only the instructional content provided below.

Focus on:
- Theme, tone, and author's purpose
- Figurative language, sensory detail, symbolism
- Inference at sentence and passage level
- Vocabulary in context (prefixes, suffixes, affixes)
- Literary structure and craft

Avoid factual recall. Use STAAR tone, structure, and distractors.

ALLOWED FORMATS (strict):
Use ONLY these formats: ${allowedTypeList.join(", ")}.
Do NOT include any format that is not in this list.

DISTRIBUTION RULES (strict):
- Total questions: EXACTLY ${questionCount}.
- Every selected format appears AT LEAST once.
- Mix up the various question format types evenly and randomly across the entire assessment.
- Aim for an even split across the selected formats (±1).
- If "Multiple Choice" is included along with others, it should be ~60% of the questions (round as needed) and the remaining questions split evenly among the other selected types.
- If only one format is selected, use that format for all questions.

FORMATTING (strict, match casing exactly):
For each question, use this exact structure:
---
Type: [Multiple Choice | True/False | Short Answer]
Question: [your prompt here]
A) Option A
B) Option B
C) Option C
D) Option D
Correct Answer: [A/B/C/D] (or for True/False use A/B; for Short Answer omit choices and include "Expected Response:")
---
//English, ELAR, Reading Question Examples

Grade 3 – Reading
What is the main message of the story?
A People do not always learn from their mistakes.
B Spending time outdoors can be rewarding.
C Rules are made for the safety of everyone.
D Making the right choice can be difficult.

The prefix un- helps the reader understand that unnoticed in paragraph 1
means —
A first seen
B not seen
C seen together
D seen from below

Based on the section “Beyond the Ocean,” what can the reader
infer about Mission Blue members?
F They are more interested in events for students than events for
scientists.
G They want more people to help with the team’s goals.
H They plan to start identifying hope spots on land.
J They are famous because of the organization’s successes.

What is the most likely reason the author includes the details in paragraph 1?
F To suggest that some sloths can move fast if they have to
G To show that sloths are a lot like other animals that live in trees
H To show that some sloths have become well known to scientists
J To suggest that sloths have a special quality that helps them survive

Grade 4 Reading

What is the best summary of the selection?
F Loud trumpeting sounds are just one of the sounds elephants make. They also
make rumbles, barks, snorts, and cries to communicate with members of the
herd.
G Elephants have many more ways of communicating than most people might
think. Elephants use touch, smell, noise, and movement to give one another
messages.
H An elephant’s trunk lets an elephant share messages such as “Let’s play” or
“Danger!” The trunk has a sensitive tip for touching other elephants and
picking up smells.
J People and elephants both have a larynx, a body part that lets them make
sounds. Elephants “talk” in low sounds, and elephants also use their sense of
touch and smell a lot.

Which sentence best states a message in the selection?
F Spending time outdoors is a good way to make new friends.
G The most difficult activities are usually the most interesting
ones.
H It is important for children to make their own goals.
J Learning about nature can be challenging and rewarding.

The author includes questions at the end of paragraph 6 most likely —
A to show the details scientists want to learn about elephants
B to show that an elephant’s most important sense is the sense of smell
C to show that elephants can identify members in their herd
D to show that elephants gather information from different smells

Graded 6 Reading

Because the story is told from the third-person limited point of view, the reader knows —
A why Marcos has not visited sooner
B why Aunt Laura revealed the secret to Mom
C how Elena feels about her actions
D what Mom thinks about the upcoming anniversary party

What does the word dwindling mean in line 18?
A Lessening
B Soaking
C Straying
D Troubling

What is the most likely reason the poet uses personification
throughout the poem?
F To compare March’s behavior to that of an impatient person
G To produce a personal reaction of sadness for March’s farewell
H To show how March’s changing of the seasons may affect each
person
J To use the actions of a person to describe March’s effect on the
weather

Which definition best matches the way the word bolts is used in line 15?
F Definition 1
G Definition 2
H Definition 3
J Definition 4

Grade 8 Reading

Based on paragraphs 4 and 5 of the selection “A Ghostly New Creature,” what can be
concluded about the study of newly discovered animals?
A Identifying a new species requires careful analysis of an animal.
B Scientists are searching constantly for unknown types of animals.
C Studying ocean animals is easier than studying land animals.
D Most animal research is conducted by government agencies.

Based on the end of the story “Biking for Boots,” the reader can
predict that Emily and Shelby will —
F plan additional fund-raisers to help other worthy causes in their
community
G assist in the rebuilding of the animal shelter
H complete the Circle Tour and donate their earnings to the animal
shelter
J encourage their friends to participate in the Circle Tour

What is the meaning of refuted as it is used in line 33?
A Proven false
B Agreed on
C Judged unfairly
D Thought predictable

For what reason does the author include the photograph after paragraph 3 of the selection
“Tiptoeing Scientists”?
A To prove that this species is the smallest of all frogs ever discovered
B To highlight the effectiveness of the frog’s natural camouflage
C To emphasize how small the frog is by comparing it to a familiar object
D To demonstrate that the frog has a unique call

Read this sentence from paragraph 23.
In a nanosecond I had to decide whether to tell the
truth and risk losing a potential friend, or lie and
live with the consequences.
Which characteristic of realistic fiction is most evident in this
sentence?
F The setting is in a real or true-to-life location.
G The story occurs in a contemporary or near-present time period.
H The events raise questions that a reader could possibly face in
everyday life.
J The narrative structure is presented with a definite beginning,
middle, and end.

Grade 10 English II

In paragraph 8 of the excerpt from The Piano Shop on the Left Bank, Luc suggests that the
narrator —
F trust his ability to make decisions
G reflect on the commitment of buying a piano
H be willing to consider other pianos
J think about playing different instruments

Use “The Leper’s Squint” to answer the following question.
Which quotation foreshadows the end of the excerpt from “The
Leper’s Squint”?
F She will know exactly the moment he sets down his next word on
that top sheet of paper. (paragraph 1)
G “Maybe she’s a writer,” Desmond’s wife whispered to him. . . .
(paragraph 2)
H “And I can’t write with someone sitting waiting.” (paragraph 3)
J “Adjust,” his wife said, and flicked at his nose. (paragraph 4)


Which quotation best shows that the author of the excerpt from the article “Those Old Piano
Blues” is relieved someone wants his old piano?
F The song had gone from major to minor, but we pressed on. (paragraph 4)
G Then the song shifted to the saddest of blues. (paragraph 4)
H But like many a blues song, this piano riff ends with hope. (paragraph 6)
J And to be sure, many older pianos have reached their coda. (paragraph 7)

Which quotation from the play best reveals Anna Maria’s reason for
becoming angry with Leopold?
F ANNA MARIA: But we have done very well in London, Leopold.
Why is this one night keeping you in such a fuss? (line 5)
G ANNA MARIA: Honestly, Leopold. I should think you would be
more concerned over all the dreadful rumors about Wolferl’s
abilities. (line 8)
H ANNA MARIA: Mr. Barrington, how would such a test be given?
(line 35)
J ANNA MARIA: You have never let him be a child—always pushing
him to live up to your dreams. (line 54)

Read line 17.
ANNA MARIA: [Clicking into role.] It
is our pleasure to welcome all into our
home who desire to see our talented son.
What does the line suggest about Anna Maria?
A She is solely responsible for exploiting Wolfgang’s musical talent.
B She is untrusting of those who come to visit Wolfgang.
C She is cordial in order to promote Wolfgang’s success.
D She is hopeful Wolfgang will help the family win a place in society.

Source Content:
${prompt}
  `;

  try {
    let retries = 3;
    let content = "";

    while (retries-- > 0) {
      const completion = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          { role: "system", content: "You are a rigorous STAAR ELA assessment builder." },
          ...(historyBlock ? [{ role: "user", content: historyBlock }] : []),
          { role: "user", content: fullPrompt }
        ],
        temperature: 0.8,
        max_tokens: 1000,
      });

      const candidate = completion.choices?.[0]?.message?.content?.trim();
      if (candidate && !isDuplicate(promptHash, candidate)) {
        content = candidate;
        saveOutput(promptHash, candidate);
        break;
      }
    }

    if (!content) {
      return res.status(500).json({ error: "Repeated duplicate ELA outputs. Try again." });
    }

const rebalanced = rebalanceMCAnswers(content, questionCount);
if (rebalanced) {
  content = rebalanced;
}

    res.json({ assessment: content });
  } catch (err) {
    console.error("❌ ELA generation error:", err);
    res.status(500).json({ error: "Failed to generate ELA assessment." });
  }
});

// ✅ Add this AFTER the previous route — outside and separate
const multer = require("multer");
const pdfParse = require("pdf-parse");
const upload = multer(); // In-memory file storage

app.post("/api/upload-file-preview", upload.single("file"), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: "No file uploaded" });

    const mimetype = file.mimetype;
    let text = "";

    if (mimetype === "application/pdf") {
      try {
        const data = await pdfParse(file.buffer);
        text = data.text;
      } catch (pdfErr) {
        console.warn("⚠️ PDF parse failed, falling back to plain text:", pdfErr.message);
        text = file.buffer.toString("utf-8");
      }
    } else {
      // fallback: assume it's plain text (txt, md, etc)
      text = file.buffer.toString("utf-8");
    }

    // ✅ Normalize Unicode to ensure accented characters render properly
    text = text.normalize("NFC");

    // ✅ Strip Byte Order Mark (BOM) if present
    if (text.charCodeAt(0) === 0xFEFF) {
      text = text.slice(1);
    }

    console.log("🧪 First few chars of content:", text.slice(0, 100)); // optional

    res.json({ content: text.trim() });
  } catch (err) {
    console.error("❌ File processing error:", err);
    res.status(500).json({ error: "Error parsing uploaded file." });
  }
});


// ▶️ Cloud YouTube Transcription Section using Puppeteer

app.post("/api/transcribe-youtube", async (req, res) => {
  const { videoId } = req.body;
  console.log("📥 Body received:", req.body);
  if (!videoId) return res.status(400).json({ error: "Missing videoId" });

  const url = `https://www.youtube.com/watch?v=${videoId}`;

  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });

    // 1️⃣ Click "More" description button
    await page.evaluate(() => {
      const btn = document.querySelector('tp-yt-paper-button#expand');
      if (btn) btn.click();
    });
    await new Promise(resolve => setTimeout(resolve, 1000));

    // 2️⃣ Click "Show transcript" button
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll("button[aria-label='Show transcript']")).find(el =>
        el.innerText?.toLowerCase().includes("transcript")
      );
      if (btn) btn.click();
    });
    await new Promise(resolve => setTimeout(resolve, 1500));

    // 3️⃣ Wait for transcript panel to appear
    await page.waitForSelector("ytd-transcript-renderer", { timeout: 5000 });

    // 4️⃣ Scrape transcript text from visible panel
    const transcript = await page.evaluate(() => {
      return Array.from(document.querySelectorAll("yt-formatted-string.segment-text"))
        .map(el => el.innerText.trim())
        .filter(Boolean)
        .join(" ");
    });

    await page.close();

    // ✅ Normalize & sanitize transcript
    let cleanedTranscript = transcript.normalize("NFC");
    if (cleanedTranscript.charCodeAt(0) === 0xFEFF) {
      cleanedTranscript = cleanedTranscript.slice(1); // Strip BOM if present
    }

    const wordCount = cleanedTranscript.trim().split(/\s+/).length;
    console.log(`📜 Transcript extracted (${wordCount} words)`);
    if (wordCount < 10) {
      return res.status(400).json({ error: "Transcript is too short or empty." });
    }

    res.json({ transcript: cleanedTranscript });

  } catch (err) {
    console.error("❌ Puppeteer error:", err.message);
    res.status(500).json({ error: "Failed to extract transcript." });
  }
});



// ✅ Start the server
const PORT = process.env.PORT || 5000;

app.get("/health", (req, res) => {
  console.log("💓 Health check hit!");
  res.json({ status: "ok" });
});

app.listen(PORT, () => {
  const baseUrl = process.env.APP_URL || `http://localhost:${PORT}`;
  console.log(`🚀 Server running on ${baseUrl}`);
});

