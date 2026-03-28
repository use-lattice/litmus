# openai-agents (Long-Horizon OpenAI Agents Python SDK)

This example shows how to evaluate the official Python `openai-agents` SDK end to end in Promptfoo.

It demonstrates:

- a long-horizon task executed as multiple turns over a persistent `SQLiteSession`
- specialist handoffs between a triage agent, an FAQ agent, and a seat-booking agent
- tool-path assertions such as `trajectory:tool-used`, `trajectory:tool-args-match`, and `trajectory:tool-sequence`
- telemetry you can inspect in Promptfoo's Trace Timeline

The tracing path is important: the example installs a custom OpenAI Agents tracing processor that exports the SDK's spans to Promptfoo's built-in OTLP receiver. That is what makes tool-call assertions and trace visualization work inside Promptfoo.

## Files

- `agent_provider.py`: the Promptfoo Python provider and agent graph
- `promptfoo_tracing.py`: bridges OpenAI Agents SDK traces to Promptfoo OTLP
- `promptfooconfig.yaml`: eval config with tracing and trajectory assertions
- `requirements.txt`: Python dependencies for the example

## Requirements

- Python 3.10+
- Node.js 20+
- `OPENAI_API_KEY`

## Setup

```bash
npx promptfoo@latest init --example openai-agents
cd openai-agents

python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

export OPENAI_API_KEY=your_api_key_here
```

## Run

```bash
npx promptfoo@latest eval -c promptfooconfig.yaml --no-cache
npx promptfoo@latest view
```

Open any result and inspect the **Trace Timeline** tab. You should see agent, handoff, generation, and tool spans from the OpenAI Agents SDK alongside Promptfoo's provider span.

## What The Eval Asserts

- the agent used `lookup_reservation`, `update_seat`, and `faq_lookup`
- the seat update tool received the expected arguments
- the tools appeared in the expected order across a multi-step task
- no traced error spans were emitted
- the final trajectory achieved the stated goal

## Notes

- The example uses the Python SDK, not the built-in `openai:agents:*` provider. That built-in provider is for the JavaScript `@openai/agents` SDK.
- If you only want Promptfoo's automatic provider-level Python span, you can remove `promptfoo_tracing.py`. You will lose tool-path assertions because Promptfoo will no longer receive the SDK's internal agent spans.
- `trajectory:goal-success` adds an extra judge-model call. Remove it if you want a cheaper run.
