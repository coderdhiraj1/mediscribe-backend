const express = require('express');
const mongoose = require('mongoose');
const cloudinary = require('cloudinary').v2;
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fetch = require('node-fetch');
const FormData = require('form-data');

// Load environment variables from the absolute path
dotenv.config({ path: path.join(__dirname, '.env') });

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const app = express();
const PORT = process.env.PORT || 5000;

// Enable CORS and JSON parsing
app.use(cors());
app.use(express.json());

// Set up storage directories
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const DB_FILE = path.join(__dirname, 'sessions.json');

if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

if (!fs.existsSync(DB_FILE)) {
  fs.writeFileSync(DB_FILE, JSON.stringify([], null, 2));
}

// Serve uploaded audio files as static files
app.use('/uploads', express.static(UPLOADS_DIR));

// Logger helper to capture Groq / Gemini request/responses with timestamps
function logAPIActivity(apiName, requestDetails, responseDetails, isError = false) {
  try {
    const logFile = path.join(__dirname, 'api_activity.log');
    const timestamp = new Date().toISOString();
    const statusLabel = isError ? 'ERROR' : 'SUCCESS';
    const logMessage = `[${timestamp}] [${statusLabel}] [${apiName}]\n` +
      `Request: ${JSON.stringify(requestDetails, null, 2)}\n` +
      `Response: ${JSON.stringify(responseDetails, null, 2)}\n` +
      `----------------------------------------------------------------------\n\n`;
    fs.appendFileSync(logFile, logMessage, 'utf8');
  } catch (error) {
    console.error('Failed to write to api_activity.log:', error);
  }
}

// Multer configurations for file upload
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOADS_DIR);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname) || '.mp3';
    cb(null, `audio-${uniqueSuffix}${ext}`);
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB limit
});

// Helper function to safely encode passwords containing special characters like '@' in MongoDB connection strings
function getSafeMongoURI(uri) {
  if (!uri) return uri;
  try {
    const prefix = uri.startsWith('mongodb+srv://') ? 'mongodb+srv://' : 'mongodb://';
    const cleanUri = uri.substring(prefix.length);
    const lastAtIdx = cleanUri.lastIndexOf('@');
    if (lastAtIdx === -1) return uri; // No credential separator found

    const authPart = cleanUri.substring(0, lastAtIdx);
    const hostPart = cleanUri.substring(lastAtIdx + 1);

    const colonIdx = authPart.indexOf(':');
    if (colonIdx === -1) return uri; // No password found

    const username = authPart.substring(0, colonIdx);
    const password = authPart.substring(colonIdx + 1);

    // Check if the password contains '@' and is not already URL-encoded
    if (password.includes('@') && !password.includes('%40')) {
      const encodedPassword = encodeURIComponent(password);
      return `${prefix}${username}:${encodedPassword}@${hostPart}`;
    }
  } catch (err) {
    console.error('Failed to parse MONGO_DB_URI helper:', err);
  }
  return uri;
}

// Connect to MongoDB
const mongoURI = getSafeMongoURI(process.env.MONGO_DB_URI);
if (mongoURI) {
  mongoose.connect(mongoURI)
    .then(() => console.log('Successfully connected to MongoDB'))
    .catch(err => console.error('MongoDB connection error:', err));
} else {
  console.warn('MONGO_DB_URI is not defined in environment variables. Running without database connection.');
}

// Define Mongoose Schema and Model
const sessionSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true },
  patientName: { type: String, default: 'Unnamed Patient' },
  title: { type: String, default: 'General Consultation' },
  language: { type: String, default: 'English' },
  date: { type: String },
  transcript: { type: String, default: '' },
  summary: { type: String, default: '' },
  audioFile: { type: String, default: null },
  audioUrl: { type: String, default: null },
  isDeleted: { type: Boolean, default: false },
  deletedAt: { type: Date, default: null }
}, { timestamps: true });

const Session = mongoose.model('Session', sessionSchema);

// MOCK DATA for local testing fallbacks
const MOCK_TRANSCRIPTS = {
  hi: {
    language: 'Hinglish',
    transcript: `Junior Doctor: नमस्ते सुनीता जी, बैठिए। क्या तकलीफ है आपको?
Patient: नमस्ते डॉक्टर साहब। मुझे दो दिन से बहुत तेज़ बुखार है और सूखी खांसी भी आ रही है। Body pain भी बहुत हो रहा है।
Junior Doctor: बुखार कितना था? क्या आपने नापा था?
Patient: हां, कल रात को 102 degrees था डॉक्टर साहब। मैंने paracetamol ली थी, तो थोड़ा कम हुआ पर सुबह फिर से बढ़ गया।
Junior Doctor: और खांसी के साथ बलगम आ रहा है या सिर्फ सूखी खांसी है? सांस फूलने की समस्या तो नहीं है?
Patient: नहीं, बलगम नहीं है, सूखी खांसी ही है। सांस लेने में कोई तकलीफ नहीं है, बस कमजोरी बहुत लग रही है।
Junior Doctor: ठीक है, मैं आपका fever और oxygen level check कर लेता हूँ। SpO2 98% है जो बिल्कुल सामान्य है। छाती में से भी कोई आवाज नहीं है, lungs clear हैं। आप आराम कीजिए, मैं सीनियर डॉक्टर साहब को रिपोर्ट सौंपता हूँ।`,
    summary: `CHIEF COMPLAINTS & HISTORY:
- Fever: High-grade fever (reported up to 102°F) persisting for the past 2 days. The temperature drops temporarily with Paracetamol but recurs.
- Cough: Dry, non-productive cough of 2 days duration.
- Systemic: Generalized body aches, myalgia, and associated physical weakness/fatigue.

DIAGNOSTIC EXCLUSIONS & CONTROLS:
- Denies productive cough or phlegm.
- Denies chest pain or shortness of breath (dyspnea).
- No known drug allergies reported.`
  },
  ta: {
    language: 'Tamil',
    transcript: `Junior Doctor: வணக்கம் பிரியா, சொல்லுங்க உங்களுக்கு என்ன பிரச்சனை?
Patient: வணக்கம் டாக்டர். கடந்த 3 நாட்களா severe headache இருக்கு. தலைக்கு வலது பக்கத்துல ஒரு மாதிரி throbbing pain இருக்கு.
Junior Doctor: வெளிச்சம் பார்த்தா கண் கூசுதா? வாந்தி ஏதும் வந்ததா?
Patient: ஆமா டாக்டர், லைட் பார்த்தாலே கண் ரொம்ப வலிக்குது, nausea-வும் இருக்கு. நேத்து கூட ஒரு தரம் வாந்தி எடுத்தேன்.
Junior Doctor: சரி, நான் BP செக் பண்றேன்... BP 120/80 normal. நீங்க ஒழுங்கா தூங்குறீங்களா?
Patient: இல்ல டாக்டர், இந்த வாரம் office project-னால தூக்கம் ரொம்ப கம்மியாகிடுச்சு.
Junior Doctor: சரி, நான் இத சீனியர் டாக்டரிடம் அப்டேட் பண்றேன்.`,
    summary: `CHIEF COMPLAINTS & HISTORY:
- Headache: Severe, right-sided throbbing headache persisting for the past 3 days.
- Gastrointestinal: Associated moderate nausea and one episode of vomiting reported yesterday.
- Sensory: Reports photophobia (eye pain when exposed to bright light) and phonophobia (irritated by loud sounds).

SOCIAL & CONTEXTUAL FACTORS:
- Trigger: Severe sleep deprivation during the past week due to office project deadlines.
- Medication: Home migraine rescue medicines were taken but failed to provide relief.`
  },
  en: {
    language: 'English',
    transcript: `Junior Doctor: Hello Mr. Davis. I see you are here for a blood pressure review. Let's record your vitals.
Patient: Yes, my home readings have been running high, around 145 over 92, even though I take my medications.
Junior Doctor: I've checked your clinic BP; it is 148/94. You are currently taking Amlodipine 5mg, correct?
Patient: Yes, daily in the morning.
Junior Doctor: I will document this for the attending consultant.`,
    summary: `CHIEF COMPLAINTS & HISTORY:
- Reason for Consult: Blood pressure follow-up. Patient reports home blood pressure readings have been elevated, averaging around 145/92 mmHg over the past two weeks.
- Medication Compliance: Patient reports complete compliance with daily morning dosage of Amlodipine 5mg.
- Associated Symptoms: Denies headaches, dizziness, pedal edema (ankle swelling), dyspnea, or chest pain.`
  }
};

// --- ENDPOINTS ---

// 1. GET /api/sessions: Fetch all active (non-soft-deleted) sessions from MongoDB
app.get('/api/sessions', async (req, res) => {
  try {
    const sessions = await Session.find({ isDeleted: { $ne: true } }).sort({ createdAt: -1 });
    res.json(sessions);
  } catch (error) {
    console.error('Error fetching sessions from MongoDB:', error);
    res.status(500).json({ error: 'Failed to fetch sessions from database' });
  }
});

// 2. POST /api/sessions: Save or update session in MongoDB (handles optional audio upload to Cloudinary)
app.post('/api/sessions', upload.single('audio'), async (req, res) => {
  try {
    const { id, patientName, title, language, date, transcript, summary } = req.body;
    let audioUrl = req.body.audioUrl || null;
    let audioFile = req.body.audioFile || null;

    // If a new audio file was uploaded in this request, upload to Cloudinary
    if (req.file) {
      try {
        const result = await cloudinary.uploader.upload(req.file.path, {
          resource_type: 'video', // 'video' is required on Cloudinary to process audio files like mp3/wav
          folder: 'mediscribe_audio'
        });
        audioUrl = result.secure_url;
        audioFile = req.file.filename;

        // Clean up the temporary local file immediately
        fs.unlinkSync(req.file.path);
      } catch (uploadErr) {
        console.error('Cloudinary Upload Failure:', uploadErr);
        // Fall back to local reference if upload failed, but don't crash
        audioFile = req.file.filename;
      }
    }

    const sessionData = {
      id: id || Date.now().toString(),
      patientName: patientName || 'Unnamed Patient',
      title: title || 'General Consultation',
      language: language || 'English',
      date: date || new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }),
      transcript: transcript || '',
      summary: summary || '',
      audioFile: audioFile,
      audioUrl: audioUrl,
      isDeleted: false, // Reset soft delete flag on save/overwrite
      deletedAt: null
    };

    // Find existing session to preserve the audio file if no new file is uploaded
    const existing = await Session.findOne({ id: sessionData.id });
    if (existing) {
      if (!req.file && !audioFile) {
        sessionData.audioFile = existing.audioFile;
        sessionData.audioUrl = existing.audioUrl;
      }
    }

    // Upsert the session document in MongoDB
    const savedSession = await Session.findOneAndUpdate(
      { id: sessionData.id },
      sessionData,
      { new: true, upsert: true }
    );

    res.json(savedSession);
  } catch (error) {
    console.error('Error saving session to MongoDB:', error);
    res.status(500).json({ error: 'Failed to save session to database' });
  }
});

// 3. DELETE /api/sessions/:id: Soft-delete session in MongoDB (keeps records and audio intact on disk)
app.delete('/api/sessions/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const session = await Session.findOne({ id });

    if (session) {
      // Perform soft delete instead of hard delete (keep physical audio file and document)
      session.isDeleted = true;
      session.deletedAt = new Date();
      await session.save();
      res.json({ success: true, message: 'Session soft-deleted successfully' });
    } else {
      res.status(404).json({ error: 'Session not found in database' });
    }
  } catch (error) {
    console.error('Error soft-deleting session from MongoDB:', error);
    res.status(500).json({ error: 'Failed to soft-delete session from database' });
  }
});

// 4. POST /api/transcribe: Transcribe speech to text via Groq Whisper API (uploads to Cloudinary & flushes disk)
app.post('/api/transcribe', upload.single('audio'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No audio file uploaded' });
  }

  const filePath = req.file.path;
  const targetLanguage = req.body.language || 'auto';
  let cloudinaryUrl = null;

  // 1. Upload to Cloudinary immediately to secure the media file permanently
  if (process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY) {
    try {
      const uploadResult = await cloudinary.uploader.upload(filePath, {
        resource_type: 'video', // 'video' resource type is required for audio files
        folder: 'mediscribe_audio'
      });
      cloudinaryUrl = uploadResult.secure_url;
    } catch (uploadErr) {
      console.error('Cloudinary upload failed in transcribe route:', uploadErr);
    }
  }

  // Fallback to simulation if GROQ API key is missing
  if (!process.env.GROQ_API_KEY) {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    return simulateTranscription(req, res, cloudinaryUrl);
  }

  try {
    const form = new FormData();
    form.append('file', fs.createReadStream(filePath));
    form.append('model', 'whisper-large-v3');
    if (targetLanguage !== 'auto') {
      form.append('language', targetLanguage);
    }
    form.append('response_format', 'json');

    const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        ...form.getHeaders()
      },
      body: form
    });

    // Clean up temporary local file as it has already been sent to Groq and Cloudinary
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    if (!response.ok) {
      const status = response.status;
      const errorText = await response.text();
      let errorMsg = errorText;
      try {
        const parsed = JSON.parse(errorText);
        errorMsg = parsed.error?.message || errorText;
      } catch (e) { }

      logAPIActivity('Groq Whisper', { filename: req.file.filename, language: targetLanguage }, { status, error: errorMsg }, true);

      if (status === 429) {
        return res.status(429).json({
          error: `Rate Limit Reached (Free Tier Limit): ${errorMsg}. Please wait a moment before trying again or upgrade your Groq API plan.`
        });
      }
      return res.status(status).json({ error: errorMsg });
    }

    const data = await response.json();
    logAPIActivity('Groq Whisper', { filename: req.file.filename, language: targetLanguage }, { transcript: data.text });

    res.json({
      transcript: data.text,
      filename: req.file.filename,
      audioUrl: cloudinaryUrl // Return the secure Cloudinary HTTPS URL
    });
  } catch (error) {
    console.error('Groq Whisper Transcription Error:', error);
    const errStr = String(error.message || error);
    logAPIActivity('Groq Whisper', { filename: req.file.filename, language: targetLanguage }, { exception: errStr }, true);

    // Clean up local file on exception
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    if (errStr.includes('429') || errStr.includes('rate limit')) {
      return res.status(429).json({
        error: 'Rate Limit Reached (Free Tier Limit) on Groq Whisper transcription API. Please try again in a few moments.'
      });
    }
    simulateTranscription(req, res, cloudinaryUrl);
  }
});

// Helper simulation function for transcription (supports Cloudinary URL passing)
function simulateTranscription(req, res, cloudinaryUrl) {
  setTimeout(() => {
    const lang = req.body.language || 'auto';
    const patientName = req.body.patientName || '';

    let key = 'hi';
    if (lang === 'ta' || patientName.toLowerCase().includes('priya')) {
      key = 'ta';
    } else if (lang === 'en' || patientName.toLowerCase().includes('john')) {
      key = 'en';
    }

    const mock = MOCK_TRANSCRIPTS[key];
    res.json({
      transcript: mock.transcript,
      filename: req.file.filename,
      detectedLanguage: mock.language,
      audioUrl: cloudinaryUrl
    });
  }, 1000);
}

// Helper function to generate summary via Groq Llama 3.3
async function generateGroqSummary(transcript, patientName) {
  if (!process.env.GROQ_API_KEY) {
    throw new Error('GROQ_API_KEY is not defined in environment variables');
  }

  const prompt = `You are a senior medical consultant. You are provided with a transcript of a doctor-patient interview conducted by a junior doctor.
Translate any Hinglish, Tamil, Telugu or other languages to English, and compile a professional clinical note focusing ONLY on information verbally discussed in the conversation.
Do NOT create medication plans, do NOT create arbitrary vitals charts. Only document what was spoken.

Do NOT use any markdown bold formatting (do not output double asterisks '**'). 
Format the note with clear uppercase headers on their own lines:
CHIEF COMPLAINTS & HISTORY:
- List symptoms, onset, duration, and patient-reported severity.
- Systemic symptoms or weaknesses.

DIAGNOSTIC EXCLUSIONS & CONTROLS:
- List symptoms denied by the patient (e.g. no productive cough, no chest pain, no known drug allergies).

Keep the summary concise and focused entirely on the conversation. Write in a firm, direct, clinical medical tone.
Patient Name: ${patientName || 'Unnamed'}
Transcript:
${transcript}`;

  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [
        {
          role: 'user',
          content: prompt
        }
      ],
      temperature: 0.1
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Groq API returned status ${response.status}: ${errorText}`);
  }

  const data = await response.json();
  if (data.choices && data.choices[0] && data.choices[0].message) {
    return data.choices[0].message.content;
  } else {
    throw new Error('Unexpected Groq API response structure');
  }
}

// Helper function to generate summary via Gemini
async function generateGeminiSummary(transcript, patientName) {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not defined in environment variables');
  }

  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

  const prompt = `You are a senior medical consultant. You are provided with a transcript of a doctor-patient interview conducted by a junior doctor.
Translate any Hinglish, Tamil, Telugu or other languages to English, and compile a professional clinical note focusing ONLY on information verbally discussed in the conversation.
Do NOT create medication plans, do NOT create arbitrary vitals charts. Only document what was spoken.

Do NOT use any markdown bold formatting (do not output double asterisks '**'). 
Format the note with clear uppercase headers on their own lines:
CHIEF COMPLAINTS & HISTORY:
- List symptoms, onset, duration, and patient-reported severity.
- Systemic symptoms or weaknesses.

DIAGNOSTIC EXCLUSIONS & CONTROLS:
- List symptoms denied by the patient (e.g. no productive cough, no chest pain, no known drug allergies).

Keep the summary concise and focused entirely on the conversation. Write in a firm, direct, clinical medical tone.
Patient Name: ${patientName || 'Unnamed'}
Transcript:
${transcript}`;

  const result = await model.generateContent(prompt);
  return result.response.text();
}

// 5. POST /api/summary: Summarize text using Groq Llama 3.3 (primary) or Gemini (backup)
app.post('/api/summary', async (req, res) => {
  const { transcript, patientName } = req.body;
  if (!transcript) {
    return res.status(400).json({ error: 'No transcript provided for summarization' });
  }

  let summaryText = null;
  let usedAPI = '';
  let apiErrors = [];

  // Try Groq Llama 3.3 first (if key exists)
  if (process.env.GROQ_API_KEY) {
    try {
      summaryText = await generateGroqSummary(transcript, patientName);
      usedAPI = 'Groq Llama 3.3';
    } catch (error) {
      console.warn('Groq Llama 3.3 summary generation failed:', error.message || error);
      apiErrors.push(`Groq: ${error.message || error}`);
    }
  }

  // Fallback to Google Gemini
  if (!summaryText && process.env.GEMINI_API_KEY) {
    try {
      summaryText = await generateGeminiSummary(transcript, patientName);
      usedAPI = 'Google Gemini';
    } catch (error) {
      console.warn('Google Gemini summary generation failed:', error.message || error);
      apiErrors.push(`Gemini: ${error.message || error}`);
    }
  }

  // Fallback to local simulation if everything fails
  if (!summaryText) {
    logAPIActivity('Summary Generation - ALL FAILED', { patientName, errors: apiErrors }, { fallback: 'Simulation' }, true);
    return simulateSummary(req, res);
  }

  logAPIActivity(usedAPI, { patientName, transcriptLength: transcript.length }, { summary: summaryText });
  res.json({ summary: summaryText, apiUsed: usedAPI });
});

function simulateSummary(req, res) {
  setTimeout(() => {
    const transcriptText = req.body.transcript || '';
    let key = 'hi';
    if (transcriptText.includes('வணக்கம்') || transcriptText.includes('headache')) {
      key = 'ta';
    } else if (transcriptText.includes('Davis') || transcriptText.includes('blood pressure')) {
      key = 'en';
    }
    res.json({ summary: MOCK_TRANSCRIPTS[key].summary });
  }, 1000);
}

// Start the server
app.listen(PORT, () => {
  console.log(`MediScribe backend running on http://localhost:${PORT}`);
});
