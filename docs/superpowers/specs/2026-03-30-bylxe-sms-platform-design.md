# bylxe.co SMS Drop Platform — Design Spec

## Overview

A standalone full-stack SMS subscription and broadcast platform for a streetwear brand (bylxe). Subscribers opt-in via keyword SMS (with double opt-in), admins manage lists and send AI-assisted blasts, and links are shortened via bylxe.co with per-subscriber click tracking.

**Standalone project** — not part of the existing sellerfolio-platform apps, but hosted on the same Windows VPS infrastructure.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 20+ |
| Framework | Express.js |
| Database | PostgreSQL (via Prisma ORM) |
| SMS Provider | Twilio (SMS + MMS) |
| Frontend | React 18 + Vite |
| Styling | Tailwind CSS |
| Charts | Recharts |
| AI | Multi-provider (OpenAI / Gemini / Claude) — admin-configurable |
| Scheduling | node-cron (in-process, no Redis) |
| Auth | JWT (jsonwebtoken) + bcrypt |
| Process Manager | PM2 |
| Reverse Proxy | Caddy (auto SSL) |
| Short Links | Custom — domain: bylxe.co |

---

## Domains

- **bylxe.co** — short link redirect service only. Serves `/:code` routes, returns 404 for everything else.
- **sms.luxesenseedit.com** — admin dashboard (React SPA) + API + Twilio webhooks.
- Both domains reverse-proxy to the same Express app on port 3001.

---

## Architecture

```
bylxe.co              sms.luxesenseedit.com
    │                         │
    └────────┐    ┌───────────┘
             ▼    ▼
         ┌──────────┐
         │  Caddy   │  (auto SSL, reverse proxy)
         └────┬─────┘
              ▼
     ┌────────────────┐
     │ Express (:3001)│
     │                │
     │  /:code    → redirect handler (bylxe.co only)
     │  /api/*    → admin API
     │  /webhook/* → Twilio inbound/status
     │  /*        → React SPA (sms.luxesenseedit.com only)
     └───────┬────────┘
             ▼
      ┌─────────────┐
      │ PostgreSQL   │
      └─────────────┘
```

- Single Express process managed by PM2
- node-cron runs in-process, checks for scheduled blasts every minute
- Caddy auto-provisions Let's Encrypt SSL for both domains

---

## Data Model (Prisma + PostgreSQL)

### User
Admin team members with standalone auth (JWT).
- id, name, email (unique), passwordHash, role (default "admin"), createdAt

### List
Subscriber lists mapped to keywords.
- id, name, keyword (unique), welcomeMessage, requireDoubleOptIn (default true), createdAt
- Seeded with: "Drops & Deals" (LUXE), "Wholesale" (WHOLESALE)

### Subscriber
People who text in to subscribe.
- id, phone (unique), status (pending | active | opted_out), optedOutAt, confirmedAt, createdAt

### SubscriberList
Many-to-many join between Subscriber and List.
- subscriberId, listId, joinedAt
- Composite PK on (subscriberId, listId)

### Keyword
Custom keywords beyond the seeded ones, mapped to lists.
- id, keyword (unique), listId, responseMessage, active (default true), createdAt

### Blast
Message broadcasts sent to a list.
- id, listId, body, mediaUrl, status (draft | scheduled | sending | sent | failed), scheduledAt, sentAt, createdBy, recipientCount, deliveredCount, createdAt

### MessageLog
Per-subscriber delivery tracking for each blast.
- id, blastId, subscriberId, twilioSid, status (queued | sent | delivered | failed), errorMessage, sentAt

### ShortLink
URL shortener entries for bylxe.co.
- id, code (unique, nanoid 6-char), destinationUrl, blastId (optional), createdBy, createdAt

### LinkClick
Per-click tracking with optional subscriber attribution.
- id, linkId, subscriberId (optional), blastId (optional), userAgent, clickedAt

### InboundMessage
Log of all incoming SMS messages.
- id, fromPhone, body, action (subscribe_luxe | subscribe_wholesale | opt_out | unknown), receivedAt

### Setting
Admin-configurable key-value settings (AI provider config).
- id, key (unique), value (encrypted for sensitive data), updatedBy, updatedAt

---

## API Routes

### Auth (`/api/auth`)
- `POST /register` — first-run only, creates initial admin
- `POST /login` — returns JWT (7-day expiry)

### Subscribers (`/api/subscribers`)
- `GET /` — list subscribers, filterable by list/status
- `GET /:id` — subscriber detail with list memberships
- `DELETE /:id` — remove subscriber
- `GET /export` — CSV export

### Messages (`/api/messages`)
- `GET /` — blast history (paginated)
- `POST /draft` — save draft blast
- `POST /:id/send` — send blast immediately
- `GET /:id/logs` — per-blast delivery log
- `POST /ai-rephrase` — AI rewrite using configured provider

### Links (`/api/links`)
- `POST /` — create short link
- `GET /` — list all links with click counts
- `GET /:id/clicks` — click detail for a link

### Keywords (`/api/keywords`)
- `GET /` — list keywords
- `POST /` — create keyword mapped to a list
- `PUT /:id` — update keyword
- `DELETE /:id` — remove keyword

### Analytics (`/api/analytics`)
- `GET /overview` — dashboard stats (total subs, per-list, blasts, clicks, opt-outs, 30-day growth)
- `GET /blast/:id` — per-blast stats with delivery breakdown and time-to-click

### Settings (`/api/settings`)
- `GET /` — get all settings
- `PUT /` — update settings (AI provider, API key, model)

### Webhooks (`/webhook`)
- `POST /sms` — Twilio inbound handler
- `POST /status` — Twilio delivery status callback

### Redirect (bylxe.co only)
- `GET /:code` — short link redirect with click tracking via `?s=subscriberId` attribution

---

## Double Opt-In Flow

1. User texts keyword (e.g., "LUXE") to Twilio number
2. Subscriber created with status `pending`
3. System replies: "Reply YES to confirm your subscription to bylxe drops"
4. User texts "YES" → status updated to `active`, welcome message sent
5. If list has `requireDoubleOptIn = false`, skip steps 2-4 and activate immediately

---

## AI Rephrase Service

Multi-provider architecture with admin-configurable settings:

**Settings stored in DB:**
- `ai_provider` — `openai` | `gemini` | `claude`
- `ai_api_key` — encrypted API key for the selected provider
- `ai_model` — model ID (e.g., `gpt-4o`, `gemini-2.0-flash`, `claude-sonnet-4-20250514`)

**Service structure:**
```
services/ai/
  index.js      — reads settings from DB, routes to correct adapter
  openai.js     — OpenAI chat completions API
  gemini.js     — Google Generative AI API
  claude.js     — Anthropic messages API
```

Each adapter implements: `rephrase(text, tone) -> { tone, variations: string[] }`

**Tones:** hype, clean, urgency — shared prompt across all providers.

---

## Per-Subscriber Click Attribution

When sending blasts, any bylxe.co links in the message body are tagged with `?s=subscriberId`:
- `bylxe.co/x9k2p3` becomes `bylxe.co/x9k2p3?s=42`
- Redirect handler reads `?s=` param and logs the click with subscriber attribution
- Enables per-subscriber engagement tracking in analytics

---

## Frontend Pages

| Page | Purpose |
|---|---|
| Login | Email/password auth, JWT in localStorage |
| Dashboard | Stats cards, 30-day growth chart (Recharts), recent blasts table |
| Compose | List selector, textarea with char counter, AI rephrase panel (tone picker + 3 variations), link shortener (paste URL -> bylxe.co link -> insert at cursor), MMS image upload, schedule toggle with datetime picker, send/draft/schedule buttons, phone preview |
| Subscribers | Table with phone, list tags, status, join date. Filter by list/status. CSV export. |
| Message Logs | Blast history with sent/delivered/click counts and rates. Drill into per-subscriber delivery. |
| Links | Short link table with destination, blast, click count. Drill into click detail + time-to-click chart. |
| Keywords | CRUD — keyword, mapped list, auto-reply, active toggle. |
| Settings | AI provider dropdown, API key input, model selector. |

**Layout:** Sidebar navigation. Dark/neutral theme. Tailwind CSS.

---

## Deployment

### Caddy Configuration
```
bylxe.co {
    @shortlink path_regexp ^/[a-zA-Z0-9]{4,8}$
    handle @shortlink {
        reverse_proxy localhost:3001
    }
    # Favicon and robots.txt pass through
    handle /favicon.ico {
        respond "" 204
    }
    handle {
        respond "Not found" 404
    }
}

sms.luxesenseedit.com {
    reverse_proxy localhost:3001
}
```

### PM2
Single process, auto-restart, log rotation.

### DNS
- `bylxe.co` A record → VPS IP
- `sms.luxesenseedit.com` A/CNAME → VPS IP

### Security
- Twilio webhook signature validation
- Rate limiting on auth endpoints
- API key encryption at rest (server-side encryption key in .env)
- CORS restricted to sms.luxesenseedit.com
- Helmet.js for security headers

### Compliance
- STOP/UNSTOP handled by Twilio natively + tracked in DB
- Double opt-in by default on all lists
- Opted-out subscribers excluded from all blast queries
- Welcome messages include opt-out instructions
- All inbound messages logged with timestamps

### Backup
- pg_dump on a scheduled Windows task for DB backups

---

## Repository Structure

```
bylxe/
├── server/
│   ├── index.js
│   ├── routes/
│   │   ├── auth.js
│   │   ├── twilio.js
│   │   ├── subscribers.js
│   │   ├── messages.js
│   │   ├── links.js
│   │   ├── keywords.js
│   │   ├── analytics.js
│   │   └── settings.js
│   ├── services/
│   │   ├── twilio.js
│   │   ├── ai/
│   │   │   ├── index.js
│   │   │   ├── openai.js
│   │   │   ├── gemini.js
│   │   │   └── claude.js
│   │   ├── scheduler.js
│   │   └── shortener.js
│   └── middleware/
│       ├── auth.js
│       └── twilioValidation.js
├── client/
│   ├── src/
│   │   ├── main.jsx
│   │   ├── App.jsx
│   │   ├── pages/
│   │   │   ├── Login.jsx
│   │   │   ├── Dashboard.jsx
│   │   │   ├── Compose.jsx
│   │   │   ├── Subscribers.jsx
│   │   │   ├── MessageLogs.jsx
│   │   │   ├── Links.jsx
│   │   │   ├── Keywords.jsx
│   │   │   └── Settings.jsx
│   │   ├── components/
│   │   │   ├── Layout.jsx
│   │   │   ├── Sidebar.jsx
│   │   │   ├── AIComposer.jsx
│   │   │   ├── LinkInserter.jsx
│   │   │   └── SchedulePicker.jsx
│   │   └── lib/
│   │       ├── api.js
│   │       └── auth.js
│   └── vite.config.js
├── prisma/
│   ├── schema.prisma
│   └── seed.js
├── .env.example
├── package.json
├── ecosystem.config.js
└── Caddyfile
```

---

## .env.example

```env
# Server
PORT=3001
JWT_SECRET=replace_with_random_64_char_string
ENCRYPTION_KEY=replace_with_random_32_char_hex
NODE_ENV=production

# Database
DATABASE_URL=postgresql://user:password@localhost:5432/bylxe

# Twilio
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_PHONE_NUMBER=+1XXXXXXXXXX

# Short Link Domain
SHORT_DOMAIN=https://bylxe.co

# Base URL (for Twilio status callbacks)
BASE_URL=https://sms.luxesenseedit.com
```

AI provider settings are stored in the database Settings table, not in .env.
