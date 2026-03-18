# ROBOCOP — AI Robot Caller

AI-powered outbound calling system that dials leads via SIP and conducts conversations using Deepgram's Voice Agent API (STT + LLM + TTS in one).

## Architecture

```
leads.csv ──► Node.js App ──drachtio──► SIP Provider ──► Lead's Phone
                  │                          │
                  │                     RTP Audio
                  │                          │
                  ├── AudioBridge (UDP) ◄─────┘
                  │        │
                  │        ▼
                  │   Deepgram Voice Agent API (WebSocket)
                  │   - STT: Nova-3 (lead's speech → text)
                  │   - LLM: GPT-4o-mini (AI responses)
                  │   - TTS: Aura-2 (AI voice → audio)
                  │        │
                  │        ▼
                  │   AI audio ──► RTP ──► Lead hears AI
                  │
                  ├── Barge-in: stops AI audio when lead speaks
                  └── Transfer: SIP REFER to human agent
```

## Prerequisites

1. **Docker Desktop for Windows** — [Download here](https://www.docker.com/products/docker-desktop/)
2. **Deepgram API Key** — [Sign up](https://console.deepgram.com/signup) (free $200 credits)
3. **SIP Account** — Your SIP username, password, and server

## Quick Start

### 1. Install Docker Desktop

Download and install Docker Desktop for Windows. Make sure it's running (whale icon in system tray).

### 2. Configure Environment

Edit the `.env` file in the project root with your credentials:

```env
# Your Deepgram API key
DEEPGRAM_API_KEY=your_deepgram_api_key_here

# Your SIP provider credentials
SIP_USERNAME=your_sip_username
SIP_PASSWORD=your_sip_password
SIP_SERVER=your_sip_server.com

# Transfer destination (human agent)
TRANSFER_SIP_URI=sip:human@your_sip_server.com

# Caller ID shown to leads
CALLER_ID=+15551234567
```

### 3. Add Your Leads

Edit `leads.csv`:

```csv
phone,name,company
+15551234567,John Smith,Acme Corp
+15559876543,Jane Doe,Widget Inc
```

### 4. Customize the AI Script

Edit `config/agent-prompt.js` to change:
- **`think.instructions`** — The AI's personality, script, and rules
- **`greeting`** — What the AI says when the lead answers
- **`speak.model`** — The AI voice (see [Deepgram voices](https://developers.deepgram.com/docs/tts-models))

### 5. Launch

Open a terminal in the project folder and run:

```powershell
docker compose up -d --build
```

This starts three containers:
- **drachtio** — SIP signaling server
- **rtpengine** — RTP media proxy
- **app** — Your Node.js robot caller

### 6. Watch the Logs

```powershell
docker compose logs -f app
```

You'll see:
```
Connected to drachtio-server
Registered with SIP provider
Loaded 3 leads from leads.csv
Starting to call 3 leads...
[abc12345] Starting call to John Smith (+15551234567)
[abc12345] Dialing +15551234567...
[abc12345] Call answered
[abc12345] [agent]: Hi there! This is Sarah calling from Acme Solutions...
[abc12345] [user]: Hello?
...
```

### 7. Stop

```powershell
docker compose down
```

## Project Structure

```
ROBOCOP/
├── .env                        # API keys and SIP credentials
├── docker-compose.yml          # drachtio + rtpengine + app
├── Dockerfile                  # Node.js app container
├── package.json                # Dependencies
├── leads.csv                   # Lead phone numbers
├── config/
│   ├── agent-prompt.js         # AI personality, script, functions
│   └── sip.js                  # SIP config loader
├── src/
│   ├── index.js                # Entry point
│   ├── deepgram/
│   │   └── agent.js            # Deepgram Voice Agent API client
│   ├── sip/
│   │   └── dialer.js           # SIP registration + outbound calls
│   ├── audio/
│   │   └── bridge.js           # RTP <-> Deepgram audio relay
│   ├── call/
│   │   └── manager.js          # Per-call orchestrator
│   ├── leads/
│   │   └── loader.js           # CSV loader + call queue
│   └── utils/
│       └── logger.js           # Winston logger
└── logs/                       # Log files (created at runtime)
```

## How It Works

### Call Flow

1. **Load leads** from CSV
2. **Originate SIP call** via drachtio → your SIP provider → lead's phone
3. **Lead answers** → RTP audio stream established
4. **Audio bridge** captures lead's RTP audio, strips headers, sends raw PCM to Deepgram
5. **Deepgram Voice Agent API** handles everything:
   - **STT** (Nova-3): Transcribes lead's speech in real-time
   - **LLM** (GPT-4o-mini): Generates AI responses following your script
   - **TTS** (Aura-2): Converts AI text to natural speech
6. **AI audio** sent back through audio bridge → RTP → lead hears the AI
7. **Barge-in**: When lead speaks mid-AI-response, audio playback stops immediately
8. **Transfer**: When AI determines lead is interested, it calls `transfer_call` → SIP REFER to human agent
9. **End call**: AI calls `end_call` with disposition → hangup

### Key Events from Deepgram

| Event | What happens |
|-------|-------------|
| `UserStartedSpeaking` | Mute AI audio (barge-in) |
| `ConversationText` | Log transcript |
| `FunctionCallRequest: transfer_call` | SIP REFER to human agent |
| `FunctionCallRequest: end_call` | Hang up with disposition |
| `AgentStartedSpeaking` | AI audio streaming begins |

## Configuration

### Call Settings (.env)

| Variable | Description | Default |
|----------|-------------|---------|
| `MAX_CONCURRENT_CALLS` | How many calls at once | `1` |
| `CALL_DELAY_MS` | Delay between calls (ms) | `5000` |
| `LOG_LEVEL` | Logging verbosity | `info` |

### AI Voice Options

Change `speak.model` in `config/agent-prompt.js`:
- `aura-2-thalia-en` — Female, professional
- `aura-2-andromeda-en` — Female, warm
- `aura-2-arcas-en` — Male, professional
- `aura-2-orion-en` — Male, authoritative

See full list: https://developers.deepgram.com/docs/tts-models

## Troubleshooting

### "Failed to connect to drachtio"
Make sure Docker Desktop is running and containers are up:
```powershell
docker compose ps
```

### "SIP registration failed"
Check your SIP credentials in `.env`. Try connecting with a SIP softphone (like Zoiper) first to verify they work.

### No audio / static
- Ensure `rtpengine` container is running: `docker compose logs rtpengine`
- Check that your firewall allows UDP ports 5060 and 20000-20100

### Deepgram errors
- Verify your `DEEPGRAM_API_KEY` is valid
- Check you have credits: https://console.deepgram.com/

## License

MIT
