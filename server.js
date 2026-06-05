const express = require('express');
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
    console.log(`[LOG] Recorded ${apiName} activity to api_activity.log`);
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

// Helper functions for reading/writing DB
function readSessions() {
  try {
    const data = fs.readFileSync(DB_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Error reading sessions database file:', error);
    return [];
  }
}

function writeSessions(sessions) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(sessions, null, 2));
  } catch (error) {
    console.error('Error writing sessions database file:', error);
  }
}

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

// 1. GET /api/sessions: Fetch all sessions
app.get('/api/sessions', (req, res) => {
  const sessions = readSessions();
  res.json(sessions);
});

// 2. POST /api/sessions: Save or update session (handles optional audio upload)
app.post('/api/sessions', upload.single('audio'), (req, res) => {
  try {
    const { id, patientName, title, language, date, transcript, summary } = req.body;
    const sessions = readSessions();

    let audioFile = req.body.audioFile || null;

    // If a new audio file was uploaded in this request
    if (req.file) {
      audioFile = req.file.filename;
    }

    const sessionData = {
      id: id || Date.now().toString(),
      patientName: patientName || 'Unnamed Patient',
      title: title || 'General Consultation',
      language: language || 'English',
      date: date || new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }),
      transcript: transcript || '',
      summary: summary || '',
      audioFile: audioFile
    };

    const existingIndex = sessions.findIndex(s => s.id === sessionData.id);
    if (existingIndex > -1) {
      // If updating, preserve old audio file if no new file is uploaded
      if (!req.file && !audioFile) {
        sessionData.audioFile = sessions[existingIndex].audioFile;
      }
      sessions[existingIndex] = sessionData;
    } else {
      sessions.unshift(sessionData);
    }

    writeSessions(sessions);
    res.json(sessionData);
  } catch (error) {
    console.error('Error saving session:', error);
    res.status(500).json({ error: 'Failed to save session' });
  }
});

// 3. DELETE /api/sessions/:id: Delete session and its audio
app.delete('/api/sessions/:id', (req, res) => {
  try {
    const { id } = req.params;
    let sessions = readSessions();
    const session = sessions.find(s => s.id === id);

    if (session) {
      // Remove physical audio file if it exists
      if (session.audioFile) {
        const filePath = path.join(UPLOADS_DIR, session.audioFile);
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      }
      sessions = sessions.filter(s => s.id !== id);
      writeSessions(sessions);
      res.json({ success: true, message: 'Session deleted successfully' });
    } else {
      res.status(404).json({ error: 'Session not found' });
    }
  } catch (error) {
    console.error('Error deleting session:', error);
    res.status(500).json({ error: 'Failed to delete session' });
  }
});

// 4. POST /api/transcribe: Transcribe speech to text via Groq Whisper API
app.post('/api/transcribe', upload.single('audio'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No audio file uploaded' });
  }

  const filePath = req.file.path;
  const targetLanguage = req.body.language || 'auto';

  // Fallback to simulation if GROQ API key is missing
  if (!process.env.GROQ_API_KEY) {
    console.log('No GROQ_API_KEY found, fallback to simulated transcription.');
    return simulateTranscription(req, res);
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
      filename: req.file.filename
    });
  } catch (error) {
    console.error('Groq Whisper Transcription Error:', error);
    const errStr = String(error.message || error);
    logAPIActivity('Groq Whisper', { filename: req.file.filename, language: targetLanguage }, { exception: errStr }, true);

    // If rate limit error occurs, return it. Otherwise, call simulation fallback.
    if (errStr.includes('429') || errStr.includes('rate limit')) {
      return res.status(429).json({
        error: 'Rate Limit Reached (Free Tier Limit) on Groq Whisper transcription API. Please try again in a few moments.'
      });
    }
    simulateTranscription(req, res);
  }
});

// Helper simulation function for transcription
function simulateTranscription(req, res) {
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
      detectedLanguage: mock.language
    });
  }, 1000);
}

// 5. POST /api/summary: Summarize text using Gemini
app.post('/api/summary', async (req, res) => {
  const { transcript, patientName } = req.body;
  if (!transcript) {
    return res.status(400).json({ error: 'No transcript provided for summarization' });
  }

  if (!process.env.GEMINI_API_KEY) {
    console.log('No GEMINI_API_KEY found, fallback to simulated summary.');
    return simulateSummary(req, res);
  }

  try {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: 'gemini-flash-latest' });

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
    const text = result.response.text();

    logAPIActivity('Google Gemini', { patientName, transcriptLength: transcript.length }, { summary: text });

    res.json({ summary: text });
  } catch (error) {
    console.error('Gemini Summarization Error:', error);
    const errorStr = String(error.message || error);
    logAPIActivity('Google Gemini', { patientName, transcriptLength: transcript.length }, { exception: errorStr }, true);

    const isRateLimit = error.status === 429 || errorStr.includes('429') || errorStr.includes('RESOURCE_EXHAUSTED') || errorStr.includes('Quota exceeded') || errorStr.includes('limit');

    if (isRateLimit) {
      return res.status(429).json({
        error: 'Rate Limit Reached (Free Tier Limit): Gemini API rate limit or quota exceeded. Please wait a minute before retrying or upgrade your Google AI Studio plan.'
      });
    }

    return res.status(error.status || 500).json({
      error: `Gemini API Error: ${error.message || error}`
    });
  }
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
