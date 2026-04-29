# Call Recording Transcription

Call recording transcription runs asynchronously in the worker. Uploaded recordings are marked `pending` after upload confirmation, then the worker claims up to five recordings per run with `FOR UPDATE SKIP LOCKED`, sends audio under 25 MB to OpenAI Whisper, summarizes the transcript with Claude, and stores the transcript and summary on `call_recordings`.

Required worker environment variables:

```env
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
```

Optional guardrails:

```env
CALL_RECORDING_TRANSCRIPTION_INTERVAL_MS=60000
CALL_RECORDING_TRANSCRIPTION_DAILY_CAP_USD=50
CALL_RECORDING_WHISPER_COST_PER_MINUTE_USD=0.006
CALL_RECORDING_CLAUDE_INPUT_COST_PER_MILLION_USD=3
CALL_RECORDING_CLAUDE_OUTPUT_COST_PER_MILLION_USD=15
```

The worker logs estimated Whisper and Claude cost per recording. If the daily cap is reached, recordings remain queued and are retried on the next daily ledger window.
