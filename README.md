# Mirror Mind - Thought Architect

## 🎯 What This Does

An AI thinking companion that:
- **Listens** to fuzzy half-formed ideas
- **Asks Socratic questions** before structuring
- **Builds live concept maps** of your thinking
- **Allows interrupts** to pivot instantly
- **Syncs to Notion** for persistent knowledge

**Why it's different:** This guides reasoning rather than just answering. It's like pair programming for your ideas.

---

## 🏗️ Architecture

```
Browser UI (SSE streaming)
    ↓
Express Backend (Node.js)
    ├→ Gemini Live API (real-time LLM)
    ├→ Firestore (session state & history)
    ├→ Notion API (knowledge persistence)
    └→ Concept Map Parser (JSON)
```

**Key flows:**
1. User shares idea → Backend creates session (Firestore)
2. Backend streams to Gemini Live + receives structured JSON
3. Frontend parses JSON → renders concept map live
4. On interrupt, backend resets context & replans
5. On completion, auto-syncs to Notion

---

## 🚀 Quick Start

### Prerequisites
- Node.js 18+
- Firebase project (already set up: mirror-mind-593c0)
- Firebase service account key (see [FIREBASE_SETUP.md](FIREBASE_SETUP.md))
- Google Gemini API key
- Notion API key (optional for MVP)

### Setup

```bash
# 1. Install dependencies
npm install

# 2. Get Firebase service account key
# - Go to Firebase Console → Project Settings → Service Accounts
# - Generate new private key and save as firebase-key.json in project root

# 3. Copy environment template
cp .env.example .env

# 4. Fill in your keys
GOOGLE_APPLICATION_CREDENTIALS=./firebase-key.json
GOOGLE_API_KEY=your_gemini_key
```

### Run Server
```bash
npm run dev
```

Server runs on `http://localhost:5000`

**See [FIREBASE_SETUP.md](FIREBASE_SETUP.md) for detailed Firebase configuration.**

---

## 📡 API Reference

### Create Session
```http
POST /api/agent/sessions
Response: { id, createdAt, messages: [] }
```

### Start Thinking (Streaming)
```http
POST /api/agent/sessions/{sessionId}/think
Body: { 
  userInput: "your idea",
  isInterrupt: false
}

Response: Server-Sent Events (streaming JSON)
  - { chunk: "..." } - Agent thinking chunks
  - { done: true, conceptMap, feasibilitySignal }
```

### Get Session State
```http
GET /api/agent/sessions/{sessionId}
Response: { id, messages, conceptMap, feasibilitySignal, isActive }
```

### Close Session
```http
POST /api/agent/sessions/{sessionId}/close
```

---

## 🎨 Frontend Features

- **Real-time streaming** of agent thinking
- **Live concept map** (canvas rendering)
- **Interrupt + Pivot** (instant replan on user input)
- **Feasibility scoring** with blockers & MVP steps
- **Session management** (create, track, resume)

---

## 🧠 The Gemini Prompt

The core system instruction guides the model to:
1. Ask Socratic questions first
2. Output structured JSON (concept map + feasibility)
3. Support instant interrupts with minimal re-context
4. Focus on reasoning over answering

You can test this immediately in [Gemini AI Studio](https://aistudio.google.com/app/studio) - see the prompt in `services/geminiService.js`.

---

## 📊 Concept Map Format

Parsed from Gemini response:
```json
{
  "nodes": [
    { "id": "idea_1", "label": "Core Concept", "color": "primary" },
    { "id": "idea_2", "label": "Related", "color": "secondary" }
  ],
  "edges": [
    { "from": "idea_1", "to": "idea_2", "label": "builds on" }
  ]
}
```

---

## 🔐 Production Considerations

- **Privacy:** Audio/text stored only in Redis (ephemeral by default)
- **Rate limiting:** Add to prevent API abuse
- **Auth:** Integrate Firebase Auth for multi-user
- **Encryption:** Cache conversation context encrypted if needed
- **On-device processing:** For ultra-sensitive thinking, run preprocessing locally before sending

---

## 🛠️ Development

### File Structure
```
.
├── server.js                    # Main entry
├── package.json
├── services/
│   ├── geminiService.js        # Gemini Live streaming
│   ├── sessionService.js       # Redis session management
│   └── notionService.js        # Notion API sync
├── routes/
│   └── agentRoutes.js          # all /api/agent endpoints
└── public/
    ├── index.html             # Frontend UI
    ├── app.js                 # Client-side logic
    └── style.css              # Styling
```

### Add Custom Prompting
Edit `SYSTEM_PROMPT` in `services/geminiService.js` to change agent behavior.

### Extend Concept Map
Modify `renderConceptMap()` in `public/app.js` to use D3.js or Excalidraw for richer visualization.

---

## 🏆 What Judges Will Love

1. ✅ **Gemini Live + interruptible** - Real-time streaming + interrupt handler
2. ✅ **Agentic reasoning** - Not just answering, but guiding thinking
3. ✅ **Live visualization** - Concept map updates in real time
4. ✅ **Practical artifact** - Notion integration = tangible output
5. ✅ **Novel UX** - Thinking companion > chatbot

---

## 🚨 Common Issues

| Issue | Fix |
|-------|-----|
| "Redis connection failed" | Ensure Redis is running (`docker run -d -p 6379:6379 redis:latest`) or set Redis URL to `redis://localhost:6379` |
| "GOOGLE_API_KEY not found" | Add to `.env` file |
| Concept map doesn't render | Check browser console for errors; ensure Gemini response includes valid JSON |
| Notion sync fails silently | Notion API is optional; check `.env` for `NOTION_API_KEY` and `NOTION_DATABASE_ID` |

---

## 📈 Next Steps (Post-MVP)

1. **Audio input** - Integrate Web Speech API for voice-to-intent
2. **Vision overlay** - Gesture-based concept map editing
3. **Multi-user** - Real-time collaboration via WebSocket
4. **Heavy inference** - Offload analysis to Vertex AI for feasibility >80%
5. **Mobile app** - React Native version

---

## 📝 Example Walkthrough

1. User says: *"I want to build a tool for managing team context when people leave"*
2. Agent asks: *"What's the core pain? Lost code context or institutional knowledge?"*
3. User: *"Both, mostly code decisions"*
4. Agent builds concept map linking: Problem → Root Cause → Solution Approach → Tech Stack
5. User: *"Wait, pivot to AI-generated context summaries instead"*
6. Agent instantly reframes around AI + shows new MVP steps in 10 seconds
7. Frontend auto-syncs to Notion with the refined plan

---

## 🤝 Contributing

To extend this:
- Add more graph layouts to `renderConceptMap()`
- Implement Vertex AI for heavy analysis
- Add WebSocket for real-time collab
- Build mobile UI

---

**Built for the Gemini Live Agent Challenge** 🚀
