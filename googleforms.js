const { google } = require("googleapis");

// Prefer env var; fall back to file only if env is missing (dev)
const credentials = process.env.GOOGLE_CREDENTIALS
  ? JSON.parse(process.env.GOOGLE_CREDENTIALS)
  : require("./credentials.json");

const auth = new google.auth.JWT({
  email: credentials.client_email,
  key: credentials.private_key,
  scopes: [
    "https://www.googleapis.com/auth/forms",
    "https://www.googleapis.com/auth/drive"
  ],
  subject: process.env.GOOGLE_SUBJECT_USER || undefined
});

const forms = google.forms({ version: "v1", auth });
const drive = google.drive({ version: "v3", auth });
const TARGET_FOLDER_ID = process.env.GOOGLE_TARGET_FOLDER_ID || "";

async function getFormDriveFileId(formId, title) {
  const res = await drive.files.list({
    q: `name = '${title}' and mimeType = 'application/vnd.google-apps.form'`,
    fields: 'files(id, name)',
    spaces: 'drive',
  });

  const file = res.data.files.find(f => f.name === title);
  return file?.id;
}

async function createGoogleFormQuiz({ title, questions }) {
  const finalTitle = title?.trim() || "Untitled Assessment";

  console.log(`📩 Creating Google Form titled "${finalTitle}" with ${questions.length} questions`);

  try {
    const formCreatePayload = {
      info: {
        title: finalTitle,
        documentTitle: finalTitle
      }
    };

    console.log("🛠️ Creating form with title:", finalTitle);

    const form = await forms.forms.create({
      requestBody: formCreatePayload
    });

    const formId = form?.data?.formId;
    console.log("✅ Created Form ID:", formId);

    await forms.forms.batchUpdate({
      formId,
      requestBody: {
        requests: [
          {
            updateSettings: {
              settings: {
                quizSettings: {
                  isQuiz: true
                }
              },
              updateMask: "quizSettings.isQuiz"
            }
          }
        ]
      }
    });
    console.log("✅ Quiz mode enabled.");

    // Make the form link-viewable so /copy works for anyone
await drive.permissions.create({
  fileId: formId,
  supportsAllDrives: true,
  requestBody: {
    type: "anyone",
    role: "reader",
    allowFileDiscovery: false
  }
});
console.log("🔓 Link sharing set: anyone with the link can view.");


    setTimeout(async () => {
  if (TARGET_FOLDER_ID) {
    try {
      // Move the file using its known ID (safer than searching by name)
      await drive.files.update({
        fileId: formId,
        addParents: TARGET_FOLDER_ID,
        removeParents: "root",
        fields: "id, parents",
        supportsAllDrives: true
      });
      console.log(`📁 Moved form to folder: ${TARGET_FOLDER_ID}`);

      // 🔁 Re-apply public "anyone:reader" AFTER the move (guards against inheritance quirks)
      try {
        await drive.permissions.create({
          fileId: formId,
          supportsAllDrives: true,
          requestBody: {
            type: "anyone",
            role: "reader",
            allowFileDiscovery: false
          }
        });
        console.log("🔓 Re-confirmed: anyone with the link can view.");
      } catch (permErr) {
        console.warn("⚠️ Re-share failed:", permErr?.message || permErr);
      }

      // 🧪 Debug: list permissions so we KNOW what's on the file
      try {
        const perms = await drive.permissions.list({
          fileId: formId,
          fields: "permissions(id,type,role,domain,emailAddress,allowFileDiscovery)",
          supportsAllDrives: true
        });
        console.log("🔎 Effective permissions:", JSON.stringify(perms.data.permissions, null, 2));
      } catch (listErr) {
        console.warn("⚠️ Could not list permissions:", listErr?.message || listErr);
      }

    } catch (moveErr) {
      console.warn("⚠️ Folder move failed (non-blocking):", moveErr.message);
    }
  }
}, 5000);


    const totalPoints = 100;
    const basePoints = Math.floor(totalPoints / questions.length);
    const remainder = totalPoints - basePoints * questions.length;

    const pointsArray = questions.map((_, i) =>
      i < remainder ? basePoints + 1 : basePoints
    );

   const requests = questions.map((q, i) => {
  const hasChoices = q.choices && q.choices.length > 0;
  const correctAnswer = q.choices?.[q.answerIndex];

  const item = {
    title: q.question, // ✅ This is where question text goes
    questionItem: {
      question: {
        required: true,
        grading: {
          pointValue: pointsArray[i],
          ...(correctAnswer && {
            correctAnswers: {
              answers: [{ value: correctAnswer.replace(/\s+/g, ' ').trim() }]
            }
          })
        },
        ...(hasChoices
          ? {
              choiceQuestion: {
                type: "RADIO",
                options: Array.from(new Set(
                  q.choices
                    .filter(Boolean)
                    .map(c => c.replace(/[\n\r]+/g, ' ').replace(/\s+/g, ' ').trim())
                )).map(value => ({ value })),
                shuffle: false
              }
            }
          : {
              textQuestion: {
                paragraph: q.type === "short" ? false : true
              }
            })
      }
    }
  };

  return {
    createItem: {
      item,
      location: { index: i }
    }
  };
});

    console.log("📤 Sending batchUpdate with:", JSON.stringify(requests, null, 2));

    await forms.forms.batchUpdate({
      formId,
      requestBody: { requests }
    });

    const copyLink = `https://docs.google.com/forms/d/${formId}/copy`;
    return copyLink;

  } catch (error) {
    console.error("❌ Google Form API error:");
    if (error.response?.data) {
      console.error("🧬 Detailed API error:", JSON.stringify(error.response.data, null, 2));
    } else {
      console.error(error);
    }
    throw error;
  }
}

// Optional: dummy generator used in test context
async function generateAssessment({ type, questionCount, formats, teks }) {
  const fallbackTitle = `Assessment: ${type[0].toUpperCase() + type.slice(1)}`;

  if (type === "essay") {
    return await createGoogleFormQuiz({
      title: fallbackTitle,
      questions: [
        {
          question: "Write an essay explaining your understanding of the selected TEKS.",
          choices: [],
          answerIndex: null
        }
      ]
    });
  }

  if (type === "quickwrite") {
    return await createGoogleFormQuiz({
      title: fallbackTitle,
      questions: [
        {
          question: "Write a short paragraph (3–5 minutes) responding to this prompt about the TEKS.",
          choices: [],
          answerIndex: null
        }
      ]
    });
  }

  const dummyQuestions = Array.from({ length: questionCount }, (_, i) => ({
    question: `Question ${i + 1}: Sample Multiple Choice?`,
    choices: ["Option A", "Option B", "Option C", "Option D"],
    answerIndex: 0
  }));

  return await createGoogleFormQuiz({
    title: fallbackTitle,
    questions: dummyQuestions
  });
}

module.exports = { createGoogleFormQuiz, generateAssessment };
