# pi-provider-umans

[Umans.ai](https://umans.ai) provider for [pi](https://shittycodingagent.ai) — drop-in Anthropic Messages-compatible endpoint with **dynamic model discovery**.

## Install

```bash
# From npm (once published)
pi install npm:pi-provider-umans

# From git
pi install git:github.com/user/pi-provider-umans

# From local path (for development)
pi install ./pi-provider-umans

# Or try without installing
pi -e ./pi-provider-umans
```

## Setup

### Option 1: `/login` (recommended — persists in auth.json)

In pi, run:

```
/login umans
```

Paste your API key when prompted. It's stored securely in `~/.pi/agent/auth.json` — no env vars needed.

### Option 2: Environment variable

```bash
export UMANS_API_KEY="sk-your-key-here"
```

## Dynamic Model Discovery

This extension fetches the live model list from `https://api.code.umans.ai/v1/models/info` at load time. You always see the latest models available — no hardcoded list. If the API is unreachable, it falls back to a built-in snapshot.

Current models include:

| ID | Name | Input | Reasoning |
|---|---|---|---|
| `umans-coder` | Umans Coder | text + image | ✅ |
| `umans-kimi-k2.5` | Umans Kimi K2.5 | text + image | ✅ |
| `umans-kimi-k2.6` | Umans Kimi K2.6 | text + image | ✅ |
| `umans-glm-5.1` | Umans GLM 5.1 | text | ✅ |
| `umans-minimax-m2.5` | Umans MiniMax M2.5 | text | ✅ |

New models added by Umans appear automatically — no extension update needed.

## Getting an API Key

1. Log in to [app.umans.ai/billing](https://app.umans.ai/billing)
2. Go to Dashboard → API Keys
3. Generate a new key (shown only once — copy it immediately)
