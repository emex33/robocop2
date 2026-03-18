/**
 * AI Agent Configuration
 * 
 * Customize the agent's behavior, voice, script, and transfer rules here.
 */

export const AGENT_CONFIG = {
  // LLM provider and model
  think: {
    provider: { type: "open_ai" },
    model: "gpt-4o-mini",
    instructions: `You are a professional and friendly sales agent calling leads on behalf of the company.

RULES:
- Introduce yourself briefly and state the reason for calling.
- Be conversational, not robotic. Use natural language.
- Listen carefully to the lead's responses before continuing.
- If the lead is interested, qualify them by asking relevant questions.
- If the lead wants to speak with a human, say "Let me connect you with a specialist right away" and then call the transfer_call function.
- If the lead is not interested, politely thank them and end the call.
- Keep responses SHORT (1-2 sentences max). This is a phone call, not an essay.
- Never reveal you are an AI unless directly asked.

SCRIPT FLOW:
1. Greeting: "Hi, this is [Agent Name] calling from [Company]. How are you doing today?"
2. Purpose: Briefly explain why you're calling.
3. Qualify: Ask 1-2 qualifying questions.
4. If interested -> transfer to human agent.
5. If not interested -> thank them and say goodbye.`,
    functions: [
      {
        name: "transfer_call",
        description: "Transfer the call to a human agent when the lead is interested or requests to speak with someone.",
        parameters: {
          type: "object",
          properties: {
            reason: {
              type: "string",
              description: "Brief reason for the transfer"
            }
          },
          required: ["reason"]
        },
        client_side: true
      },
      {
        name: "end_call",
        description: "End the call when the conversation is complete, lead is not interested, or asks to be removed.",
        parameters: {
          type: "object",
          properties: {
            outcome: {
              type: "string",
              enum: ["interested", "not_interested", "callback", "do_not_call", "no_answer", "voicemail"],
              description: "The outcome/disposition of the call"
            },
            notes: {
              type: "string",
              description: "Brief notes about the call"
            }
          },
          required: ["outcome"]
        },
        client_side: true
      }
    ]
  },

  // Speech-to-Text settings
  listen: {
    type: "deepgram",
    model: "nova-3"
  },

  // Text-to-Speech settings
  speak: {
    type: "deepgram",
    model: "aura-2-thalia-en"
  },

  // Greeting message (spoken immediately when lead answers)
  greeting: "Hi there! This is Sarah calling from Acme Solutions. How are you doing today?",

  // Audio settings
  audio: {
    input: {
      encoding: "linear16",
      sample_rate: 16000
    },
    output: {
      encoding: "linear16",
      sample_rate: 16000,
      container: "none"
    }
  }
};
