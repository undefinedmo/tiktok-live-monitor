# bylxe.co SMS Drop Platform — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone SMS subscription and broadcast platform with Twilio integration, AI-assisted message composition, custom link shortener (bylxe.co), and admin dashboard.

**Architecture:** Single Express.js monolith serving both bylxe.co (short link redirects) and sms.luxesenseedit.com (admin API + React SPA). PostgreSQL via Prisma ORM. node-cron for scheduled blasts. Multi-provider AI rephrase service (OpenAI/Gemini/Claude).

**Tech Stack:** Node.js 20+, Express.js, Prisma + PostgreSQL, React 18 + Vite, Tailwind CSS, Recharts, Twilio, Vitest, nanoid, node-cron, jsonwebtoken, bcrypt

**Project Location:** `C:/Users/hammo/Documents/Code Playground/LuxeSense/bylxe/`

**Design Spec:** `../sellerfolio-platform/docs/superpowers/specs/2026-03-30-bylxe-sms-platform-design.md`

---

## File Map

```
bylxe/
├── server/
│   ├── index.js                    # Express entry point, route mounting, domain-aware middleware
│   ├── prisma.js                   # Prisma client singleton
│   ├── routes/
│   │   ├── auth.js                 # POST /register, POST /login
│   │   ├── twilio.js               # POST /webhook/sms, POST /webhook/status
│   │   ├── subscribers.js          # CRUD + CSV export
│   │   ├── messages.js             # Blast CRUD, send, AI rephrase
│   │   ├── links.js                # Short link CRUD + redirect handler
│   │   ├── keywords.js             # Keyword CRUD
│   │   ├── analytics.js            # Overview + per-blast stats
│   │   └── settings.js             # AI provider config
│   ├── services/
│   │   ├── twilio.js               # Twilio send helper
│   │   ├── ai/
│   │   │   ├── index.js            # Provider router (reads Settings, dispatches)
│   │   │   ├── openai.js           # OpenAI adapter
│   │   │   ├── gemini.js           # Gemini adapter
│   │   │   └── claude.js           # Claude adapter
│   │   ├── scheduler.js            # node-cron scheduled blast checker
│   │   ├── shortener.js            # nanoid code generation
│   │   └── encryption.js           # AES encrypt/decrypt for API keys
│   └── middleware/
│       ├── auth.js                 # JWT verification guard
│       └── twilioValidation.js     # Twilio request signature validation
├── client/
│   ├── index.html
│   ├── vite.config.js
│   ├── tailwind.config.js
│   ├── postcss.config.js
│   ├── src/
│   │   ├── main.jsx                # React entry
│   │   ├── App.jsx                 # Router + auth guard
│   │   ├── lib/
│   │   │   ├── api.js              # Axios instance with JWT interceptor
│   │   │   └── auth.js             # JWT localStorage helpers
│   │   ├── components/
│   │   │   ├── Layout.jsx          # Sidebar + main content wrapper
│   │   │   ├── Sidebar.jsx         # Navigation sidebar
│   │   │   ├── AIComposer.jsx      # AI rephrase panel (tone picker + variations)
│   │   │   ├── LinkInserter.jsx    # URL shortener + insert at cursor
│   │   │   └── SchedulePicker.jsx  # Date/time picker for scheduling
│   │   └── pages/
│   │       ├── Login.jsx
│   │       ├── Dashboard.jsx
│   │       ├── Compose.jsx
│   │       ├── Subscribers.jsx
│   │       ├── MessageLogs.jsx
│   │       ├── Links.jsx
│   │       ├── Keywords.jsx
│   │       └── Settings.jsx
├── prisma/
│   ├── schema.prisma
│   └── seed.js                     # Seed default lists + keywords
├── tests/
│   ├── setup.js                    # Vitest global setup (test DB, prisma reset)
│   ├── helpers.js                  # Test utilities (createTestUser, getAuthToken, etc.)
│   ├── server/
│   │   ├── auth.test.js
│   │   ├── twilio-webhook.test.js
│   │   ├── subscribers.test.js
│   │   ├── messages.test.js
│   │   ├── links.test.js
│   │   ├── keywords.test.js
│   │   ├── analytics.test.js
│   │   ├── settings.test.js
│   │   └── services/
│   │       ├── ai.test.js
│   │       ├── scheduler.test.js
│   │       └── encryption.test.js
├── .env.example
├── .gitignore
├── package.json
├── ecosystem.config.js
├── Caddyfile
└── vitest.config.js
```

---

## Task 1: Project Scaffold & Dependencies

**Files:**
- Create: `bylxe/package.json`
- Create: `bylxe/.env.example`
- Create: `bylxe/.env` (local dev copy)
- Create: `bylxe/.gitignore`
- Create: `bylxe/vitest.config.js`

- [ ] **Step 1: Create project directory and initialize**

```bash
mkdir -p "C:/Users/hammo/Documents/Code Playground/LuxeSense/bylxe"
cd "C:/Users/hammo/Documents/Code Playground/LuxeSense/bylxe"
```

- [ ] **Step 2: Create package.json**

Write `package.json`:
```json
{
  "name": "bylxe",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "dev": "concurrently \"npm run server:dev\" \"npm run client:dev\"",
    "server:dev": "nodemon server/index.js",
    "client:dev": "cd client && npm run dev",
    "build": "cd client && npm run build",
    "start": "node server/index.js",
    "test": "vitest run",
    "test:watch": "vitest",
    "db:generate": "prisma generate",
    "db:migrate": "prisma migrate dev",
    "db:push": "prisma db push",
    "db:seed": "node prisma/seed.js"
  }
}
```

- [ ] **Step 3: Install server dependencies**

```bash
npm install express cors helmet dotenv jsonwebtoken bcrypt @prisma/client twilio nanoid@3 node-cron multer
```

Note: `nanoid@3` for CommonJS compatibility (v4+ is ESM-only).

- [ ] **Step 4: Install dev dependencies**

```bash
npm install -D prisma nodemon concurrently vitest supertest @vitest/coverage-v8
```

- [ ] **Step 5: Create .env.example**

Write `.env.example`:
```env
# Server
PORT=3001
JWT_SECRET=replace_with_random_64_char_string
ENCRYPTION_KEY=replace_with_random_32_hex_bytes
NODE_ENV=development

# Database
DATABASE_URL=postgresql://postgres:password@localhost:5432/bylxe

# Twilio
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_PHONE_NUMBER=+1XXXXXXXXXX

# Short Link Domain
SHORT_DOMAIN=http://localhost:3001

# Base URL (for Twilio status callbacks)
BASE_URL=http://localhost:3001
```

- [ ] **Step 6: Create .env for local dev**

Copy `.env.example` to `.env` and fill in the `DATABASE_URL` with a real local PostgreSQL connection string. Set `JWT_SECRET` to a random string. Set `ENCRYPTION_KEY` to 32 hex bytes (run `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`).

- [ ] **Step 7: Create .gitignore**

Write `.gitignore`:
```
node_modules/
.env
client/dist/
client/node_modules/
*.log
```

- [ ] **Step 8: Create vitest.config.js**

Write `vitest.config.js`:
```javascript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    setupFiles: ['./tests/setup.js'],
    testTimeout: 10000,
  },
});
```

- [ ] **Step 9: Initialize git**

```bash
git init
git add -A
git commit -m "chore: scaffold bylxe project with dependencies"
```

---

## Task 2: Prisma Schema & Database Setup

**Files:**
- Create: `bylxe/prisma/schema.prisma`
- Create: `bylxe/prisma/seed.js`
- Create: `bylxe/server/prisma.js`

- [ ] **Step 1: Create Prisma schema**

Write `prisma/schema.prisma`:
```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model User {
  id           Int       @id @default(autoincrement())
  name         String
  email        String    @unique
  passwordHash String    @map("password_hash")
  role         String    @default("admin")
  createdAt    DateTime  @default(now()) @map("created_at")
  blasts       Blast[]
  shortLinks   ShortLink[]
  settings     Setting[]

  @@map("users")
}

model List {
  id               Int              @id @default(autoincrement())
  name             String
  keyword          String           @unique
  welcomeMessage   String?          @map("welcome_message")
  requireDoubleOptIn Boolean        @default(true) @map("require_double_opt_in")
  createdAt        DateTime         @default(now()) @map("created_at")
  subscribers      SubscriberList[]
  keywords         Keyword[]
  blasts           Blast[]

  @@map("lists")
}

model Subscriber {
  id          Int              @id @default(autoincrement())
  phone       String           @unique
  status      String           @default("pending")
  optedOutAt  DateTime?        @map("opted_out_at")
  confirmedAt DateTime?        @map("confirmed_at")
  createdAt   DateTime         @default(now()) @map("created_at")
  lists       SubscriberList[]
  messageLogs MessageLog[]
  linkClicks  LinkClick[]

  @@map("subscribers")
}

model SubscriberList {
  subscriberId Int        @map("subscriber_id")
  listId       Int        @map("list_id")
  joinedAt     DateTime   @default(now()) @map("joined_at")
  subscriber   Subscriber @relation(fields: [subscriberId], references: [id], onDelete: Cascade)
  list         List       @relation(fields: [listId], references: [id], onDelete: Cascade)

  @@id([subscriberId, listId])
  @@map("subscriber_lists")
}

model Keyword {
  id              Int      @id @default(autoincrement())
  keyword         String   @unique
  listId          Int      @map("list_id")
  responseMessage String?  @map("response_message")
  active          Boolean  @default(true)
  createdAt       DateTime @default(now()) @map("created_at")
  list            List     @relation(fields: [listId], references: [id], onDelete: Cascade)

  @@map("keywords")
}

model Blast {
  id             Int          @id @default(autoincrement())
  listId         Int          @map("list_id")
  body           String
  mediaUrl       String?      @map("media_url")
  status         String       @default("draft")
  scheduledAt    DateTime?    @map("scheduled_at")
  sentAt         DateTime?    @map("sent_at")
  createdBy      Int          @map("created_by")
  recipientCount Int          @default(0) @map("recipient_count")
  deliveredCount Int          @default(0) @map("delivered_count")
  createdAt      DateTime     @default(now()) @map("created_at")
  list           List         @relation(fields: [listId], references: [id])
  creator        User         @relation(fields: [createdBy], references: [id])
  messageLogs    MessageLog[]
  shortLinks     ShortLink[]
  linkClicks     LinkClick[]

  @@map("blasts")
}

model MessageLog {
  id           Int        @id @default(autoincrement())
  blastId      Int        @map("blast_id")
  subscriberId Int        @map("subscriber_id")
  twilioSid    String?    @map("twilio_sid")
  status       String     @default("queued")
  errorMessage String?    @map("error_message")
  sentAt       DateTime   @default(now()) @map("sent_at")
  blast        Blast      @relation(fields: [blastId], references: [id], onDelete: Cascade)
  subscriber   Subscriber @relation(fields: [subscriberId], references: [id], onDelete: Cascade)

  @@map("message_logs")
}

model ShortLink {
  id             Int         @id @default(autoincrement())
  code           String      @unique
  destinationUrl String      @map("destination_url")
  blastId        Int?        @map("blast_id")
  createdBy      Int         @map("created_by")
  createdAt      DateTime    @default(now()) @map("created_at")
  blast          Blast?      @relation(fields: [blastId], references: [id])
  creator        User        @relation(fields: [createdBy], references: [id])
  linkClicks     LinkClick[]

  @@map("short_links")
}

model LinkClick {
  id           Int         @id @default(autoincrement())
  linkId       Int         @map("link_id")
  subscriberId Int?        @map("subscriber_id")
  blastId      Int?        @map("blast_id")
  userAgent    String?     @map("user_agent")
  clickedAt    DateTime    @default(now()) @map("clicked_at")
  link         ShortLink   @relation(fields: [linkId], references: [id], onDelete: Cascade)
  subscriber   Subscriber? @relation(fields: [subscriberId], references: [id])
  blast        Blast?      @relation(fields: [blastId], references: [id])

  @@map("link_clicks")
}

model InboundMessage {
  id         Int      @id @default(autoincrement())
  fromPhone  String   @map("from_phone")
  body       String
  action     String?
  receivedAt DateTime @default(now()) @map("received_at")

  @@map("inbound_messages")
}

model Setting {
  id        Int      @id @default(autoincrement())
  key       String   @unique
  value     String
  updatedBy Int      @map("updated_by")
  updatedAt DateTime @updatedAt @map("updated_at")
  user      User     @relation(fields: [updatedBy], references: [id])

  @@map("settings")
}
```

- [ ] **Step 2: Create Prisma client singleton**

Write `server/prisma.js`:
```javascript
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

module.exports = prisma;
```

- [ ] **Step 3: Create seed script**

Write `prisma/seed.js`:
```javascript
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  // Seed default lists
  const luxe = await prisma.list.upsert({
    where: { keyword: 'LUXE' },
    update: {},
    create: {
      name: 'Drops & Deals',
      keyword: 'LUXE',
      welcomeMessage: "You're in! Welcome to bylxe exclusive drops & deals. Reply STOP to unsubscribe.",
      requireDoubleOptIn: true,
    },
  });

  const wholesale = await prisma.list.upsert({
    where: { keyword: 'WHOLESALE' },
    update: {},
    create: {
      name: 'Wholesale',
      keyword: 'WHOLESALE',
      welcomeMessage: 'Welcome to bylxe Wholesale! You\'ll receive new catalog drops and reorder reminders. Reply STOP to unsubscribe.',
      requireDoubleOptIn: true,
    },
  });

  // Seed keywords that map to these lists
  await prisma.keyword.upsert({
    where: { keyword: 'LUXE' },
    update: {},
    create: { keyword: 'LUXE', listId: luxe.id },
  });

  await prisma.keyword.upsert({
    where: { keyword: 'WHOLESALE' },
    update: {},
    create: { keyword: 'WHOLESALE', listId: wholesale.id },
  });

  console.log('Seed complete: lists and keywords created');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
```

- [ ] **Step 4: Run initial migration**

```bash
npx prisma generate
npx prisma migrate dev --name init
```

- [ ] **Step 5: Run seed**

```bash
node prisma/seed.js
```

- [ ] **Step 6: Create test setup and helpers**

Write `tests/setup.js`:
```javascript
const { execSync } = require('child_process');

// Use a test database — set DATABASE_URL in .env.test or override here
process.env.JWT_SECRET = 'test-secret-key-for-jwt-signing-only';
process.env.ENCRYPTION_KEY = 'a'.repeat(64);
process.env.SHORT_DOMAIN = 'http://localhost:3001';
process.env.BASE_URL = 'http://localhost:3001';
process.env.TWILIO_ACCOUNT_SID = 'ACtest';
process.env.TWILIO_AUTH_TOKEN = 'test-auth-token';
process.env.TWILIO_PHONE_NUMBER = '+15555555555';
```

Write `tests/helpers.js`:
```javascript
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const prisma = require('../server/prisma');

async function cleanDatabase() {
  await prisma.linkClick.deleteMany();
  await prisma.messageLog.deleteMany();
  await prisma.shortLink.deleteMany();
  await prisma.blast.deleteMany();
  await prisma.subscriberList.deleteMany();
  await prisma.keyword.deleteMany();
  await prisma.subscriber.deleteMany();
  await prisma.list.deleteMany();
  await prisma.inboundMessage.deleteMany();
  await prisma.setting.deleteMany();
  await prisma.user.deleteMany();
}

async function createTestUser(overrides = {}) {
  const data = {
    name: 'Test Admin',
    email: `test-${Date.now()}@test.com`,
    passwordHash: bcrypt.hashSync('password123', 10),
    role: 'admin',
    ...overrides,
  };
  return prisma.user.create({ data });
}

function getAuthToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
}

async function createTestList(overrides = {}) {
  const data = {
    name: 'Test List',
    keyword: `TEST-${Date.now()}`,
    welcomeMessage: 'Welcome to the test list! Reply STOP to unsubscribe.',
    requireDoubleOptIn: true,
    ...overrides,
  };
  return prisma.list.create({ data });
}

async function createTestSubscriber(overrides = {}) {
  const data = {
    phone: `+1555${Date.now().toString().slice(-7)}`,
    status: 'active',
    ...overrides,
  };
  return prisma.subscriber.create({ data });
}

module.exports = {
  cleanDatabase,
  createTestUser,
  getAuthToken,
  createTestList,
  createTestSubscriber,
  prisma,
};
```

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: add Prisma schema, seed, and test infrastructure"
```

---

## Task 3: Express Server Entry & Middleware

**Files:**
- Create: `bylxe/server/index.js`
- Create: `bylxe/server/middleware/auth.js`
- Create: `bylxe/server/middleware/twilioValidation.js`
- Create: `bylxe/server/services/encryption.js`
- Test: `bylxe/tests/server/services/encryption.test.js`

- [ ] **Step 1: Write encryption service test**

Write `tests/server/services/encryption.test.js`:
```javascript
const { describe, it, expect } = require('vitest');
const { encrypt, decrypt } = require('../../../server/services/encryption');

describe('encryption service', () => {
  it('encrypts and decrypts a string', () => {
    const plaintext = 'sk-ant-api03-secret-key';
    const encrypted = encrypt(plaintext);
    expect(encrypted).not.toBe(plaintext);
    expect(encrypted).toContain(':'); // iv:encrypted format
    const decrypted = decrypt(encrypted);
    expect(decrypted).toBe(plaintext);
  });

  it('produces different ciphertexts for the same input', () => {
    const plaintext = 'same-input';
    const a = encrypt(plaintext);
    const b = encrypt(plaintext);
    expect(a).not.toBe(b); // different IVs
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/server/services/encryption.test.js
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write encryption service**

Write `server/services/encryption.js`:
```javascript
const crypto = require('crypto');

const ALGORITHM = 'aes-256-cbc';

function getKey() {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex || hex.length < 64) {
    throw new Error('ENCRYPTION_KEY must be 32 bytes (64 hex chars)');
  }
  return Buffer.from(hex.slice(0, 64), 'hex');
}

function encrypt(text) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

function decrypt(text) {
  const [ivHex, encrypted] = text.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv);
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

module.exports = { encrypt, decrypt };
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run tests/server/services/encryption.test.js
```

Expected: PASS.

- [ ] **Step 5: Write auth middleware**

Write `server/middleware/auth.js`:
```javascript
const jwt = require('jsonwebtoken');

module.exports = (req, res, next) => {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ error: 'No token provided' });

  const token = header.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided' });

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
};
```

- [ ] **Step 6: Write Twilio validation middleware**

Write `server/middleware/twilioValidation.js`:
```javascript
const twilio = require('twilio');

module.exports = (req, res, next) => {
  // Skip validation in development/test
  if (process.env.NODE_ENV !== 'production') return next();

  const signature = req.headers['x-twilio-signature'];
  const url = `${process.env.BASE_URL}${req.originalUrl}`;
  const params = req.body;

  const isValid = twilio.validateRequest(
    process.env.TWILIO_AUTH_TOKEN,
    signature,
    url,
    params
  );

  if (!isValid) return res.status(403).json({ error: 'Invalid Twilio signature' });
  next();
};
```

- [ ] **Step 7: Write Express server entry**

Write `server/index.js`:
```javascript
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');

const app = express();

// Security
app.use(helmet());
app.use(cors({
  origin: process.env.NODE_ENV === 'production'
    ? ['https://sms.luxesenseedit.com']
    : '*',
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// API Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/subscribers', require('./routes/subscribers'));
app.use('/api/messages', require('./routes/messages'));
app.use('/api/links', require('./routes/links'));
app.use('/api/keywords', require('./routes/keywords'));
app.use('/api/analytics', require('./routes/analytics'));
app.use('/api/settings', require('./routes/settings'));

// Twilio webhooks
app.use('/webhook', require('./routes/twilio'));

// Short link redirect — matches 4-8 char alphanumeric codes
const { redirect } = require('./routes/links');
app.get('/:code([a-zA-Z0-9]{4,8})', redirect);

// Serve React frontend in production
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '../client/dist')));
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../client/dist/index.html'));
  });
}

// Start scheduler
require('./services/scheduler').init();

// Only start listening if not imported for testing
if (require.main === module) {
  const PORT = process.env.PORT || 3001;
  app.listen(PORT, () => console.log(`bylxe server running on port ${PORT}`));
}

module.exports = app;
```

Note: This file references routes that don't exist yet. They'll be created in subsequent tasks. For now, the server won't start — that's expected.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: add Express server entry, auth middleware, encryption service"
```

---

## Task 4: Auth Routes

**Files:**
- Create: `bylxe/server/routes/auth.js`
- Test: `bylxe/tests/server/auth.test.js`

- [ ] **Step 1: Write auth route tests**

Write `tests/server/auth.test.js`:
```javascript
const { describe, it, expect, beforeEach } = require('vitest');
const request = require('supertest');
const { cleanDatabase, prisma } = require('../helpers');

// Need a minimal app for testing just the auth route
const express = require('express');
const app = express();
app.use(express.json());
app.use('/api/auth', require('../../server/routes/auth'));

describe('POST /api/auth/register', () => {
  beforeEach(async () => {
    await cleanDatabase();
  });

  it('creates the first admin user', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ name: 'Admin', email: 'admin@test.com', password: 'password123' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('id');

    const user = await prisma.user.findUnique({ where: { email: 'admin@test.com' } });
    expect(user).not.toBeNull();
    expect(user.name).toBe('Admin');
  });

  it('rejects duplicate email', async () => {
    await request(app)
      .post('/api/auth/register')
      .send({ name: 'Admin', email: 'dup@test.com', password: 'password123' });

    const res = await request(app)
      .post('/api/auth/register')
      .send({ name: 'Admin 2', email: 'dup@test.com', password: 'password456' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/already exists/i);
  });
});

describe('POST /api/auth/login', () => {
  beforeEach(async () => {
    await cleanDatabase();
    await request(app)
      .post('/api/auth/register')
      .send({ name: 'Admin', email: 'login@test.com', password: 'password123' });
  });

  it('returns JWT on valid credentials', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'login@test.com', password: 'password123' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('token');
    expect(res.body.user.email).toBe('login@test.com');
  });

  it('rejects invalid password', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'login@test.com', password: 'wrong' });

    expect(res.status).toBe(401);
  });

  it('rejects unknown email', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'nobody@test.com', password: 'password123' });

    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/server/auth.test.js
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write auth routes**

Write `server/routes/auth.js`:
```javascript
const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const prisma = require('../prisma');

// POST /api/auth/register
router.post('/register', async (req, res) => {
  const { name, email, password } = req.body;

  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Name, email, and password are required' });
  }

  const passwordHash = await bcrypt.hash(password, 10);

  try {
    const user = await prisma.user.create({
      data: { name, email, passwordHash },
    });
    res.json({ id: user.id });
  } catch (e) {
    if (e.code === 'P2002') {
      return res.status(400).json({ error: 'Email already exists' });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

  const token = jwt.sign(
    { id: user.id, email: user.email, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );

  res.json({
    token,
    user: { id: user.id, name: user.name, email: user.email },
  });
});

module.exports = router;
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/server/auth.test.js
```

Expected: PASS — all 5 tests.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add auth routes (register + login) with tests"
```

---

## Task 5: Twilio Webhook — Inbound SMS + Double Opt-In

**Files:**
- Create: `bylxe/server/routes/twilio.js`
- Create: `bylxe/server/services/twilio.js`
- Test: `bylxe/tests/server/twilio-webhook.test.js`

- [ ] **Step 1: Write Twilio send service**

Write `server/services/twilio.js`:
```javascript
const twilio = require('twilio');

let client;
function getClient() {
  if (!client) {
    client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  }
  return client;
}

async function send({ to, body, mediaUrl }) {
  const params = {
    from: process.env.TWILIO_PHONE_NUMBER,
    to,
    body,
    statusCallback: `${process.env.BASE_URL}/webhook/status`,
  };

  if (mediaUrl) {
    params.mediaUrl = [mediaUrl];
  }

  return getClient().messages.create(params);
}

module.exports = { send };
```

- [ ] **Step 2: Write webhook tests**

Write `tests/server/twilio-webhook.test.js`:
```javascript
const { describe, it, expect, beforeEach, vi } = require('vitest');
const request = require('supertest');
const express = require('express');
const { cleanDatabase, createTestList, prisma } = require('../helpers');

// Mock Twilio send service
vi.mock('../../server/services/twilio', () => ({
  send: vi.fn().mockResolvedValue({ sid: 'SM_mock_sid' }),
}));

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/webhook', require('../../server/routes/twilio'));

describe('POST /webhook/sms', () => {
  let list;

  beforeEach(async () => {
    await cleanDatabase();
    list = await createTestList({ keyword: 'LUXE', name: 'Drops & Deals' });
    await prisma.keyword.create({
      data: { keyword: 'LUXE', listId: list.id },
    });
  });

  it('creates a pending subscriber on keyword text (double opt-in)', async () => {
    const res = await request(app)
      .post('/webhook/sms')
      .type('form')
      .send({ From: '+15551234567', Body: 'LUXE' });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/xml/);

    const sub = await prisma.subscriber.findUnique({ where: { phone: '+15551234567' } });
    expect(sub).not.toBeNull();
    expect(sub.status).toBe('pending');

    // Should have a pending list membership
    const membership = await prisma.subscriberList.findUnique({
      where: { subscriberId_listId: { subscriberId: sub.id, listId: list.id } },
    });
    expect(membership).not.toBeNull();

    // Inbound message should be logged
    const inbound = await prisma.inboundMessage.findFirst({ where: { fromPhone: '+15551234567' } });
    expect(inbound).not.toBeNull();
    expect(inbound.body).toBe('LUXE');
  });

  it('activates subscriber on YES reply (double opt-in confirmation)', async () => {
    // First, subscribe
    await request(app)
      .post('/webhook/sms')
      .type('form')
      .send({ From: '+15551234567', Body: 'LUXE' });

    // Then confirm
    const res = await request(app)
      .post('/webhook/sms')
      .type('form')
      .send({ From: '+15551234567', Body: 'YES' });

    expect(res.status).toBe(200);

    const sub = await prisma.subscriber.findUnique({ where: { phone: '+15551234567' } });
    expect(sub.status).toBe('active');
    expect(sub.confirmedAt).not.toBeNull();
  });

  it('handles STOP keyword — opts out subscriber', async () => {
    // Create an active subscriber
    const sub = await prisma.subscriber.create({
      data: { phone: '+15559999999', status: 'active' },
    });

    const res = await request(app)
      .post('/webhook/sms')
      .type('form')
      .send({ From: '+15559999999', Body: 'STOP' });

    expect(res.status).toBe(200);

    const updated = await prisma.subscriber.findUnique({ where: { id: sub.id } });
    expect(updated.status).toBe('opted_out');
    expect(updated.optedOutAt).not.toBeNull();
  });

  it('handles START keyword — re-activates subscriber', async () => {
    const sub = await prisma.subscriber.create({
      data: { phone: '+15558888888', status: 'opted_out', optedOutAt: new Date() },
    });

    const res = await request(app)
      .post('/webhook/sms')
      .type('form')
      .send({ From: '+15558888888', Body: 'START' });

    expect(res.status).toBe(200);

    const updated = await prisma.subscriber.findUnique({ where: { id: sub.id } });
    expect(updated.status).toBe('active');
    expect(updated.optedOutAt).toBeNull();
  });

  it('sends default reply for unknown keywords', async () => {
    const res = await request(app)
      .post('/webhook/sms')
      .type('form')
      .send({ From: '+15557777777', Body: 'RANDOM' });

    expect(res.status).toBe(200);
    expect(res.text).toContain('LUXE');
  });

  it('skips double opt-in when list has requireDoubleOptIn=false', async () => {
    const noOptInList = await createTestList({
      keyword: 'FAST',
      name: 'Fast List',
      requireDoubleOptIn: false,
    });
    await prisma.keyword.create({
      data: { keyword: 'FAST', listId: noOptInList.id },
    });

    await request(app)
      .post('/webhook/sms')
      .type('form')
      .send({ From: '+15556666666', Body: 'FAST' });

    const sub = await prisma.subscriber.findUnique({ where: { phone: '+15556666666' } });
    expect(sub.status).toBe('active');
  });
});

describe('POST /webhook/status', () => {
  it('updates message log status on delivery callback', async () => {
    await cleanDatabase();
    const user = await prisma.user.create({
      data: { name: 'A', email: 'a@test.com', passwordHash: 'x' },
    });
    const list = await createTestList({ keyword: 'S1' });
    const blast = await prisma.blast.create({
      data: { listId: list.id, body: 'test', createdBy: user.id },
    });
    const sub = await prisma.subscriber.create({
      data: { phone: '+15550000000', status: 'active' },
    });
    await prisma.messageLog.create({
      data: {
        blastId: blast.id,
        subscriberId: sub.id,
        twilioSid: 'SM_test_123',
        status: 'sent',
      },
    });

    const res = await request(app)
      .post('/webhook/status')
      .type('form')
      .send({
        MessageSid: 'SM_test_123',
        MessageStatus: 'delivered',
      });

    expect(res.status).toBe(200);

    const log = await prisma.messageLog.findFirst({ where: { twilioSid: 'SM_test_123' } });
    expect(log.status).toBe('delivered');

    const updatedBlast = await prisma.blast.findUnique({ where: { id: blast.id } });
    expect(updatedBlast.deliveredCount).toBe(1);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
npx vitest run tests/server/twilio-webhook.test.js
```

Expected: FAIL — module not found.

- [ ] **Step 4: Write Twilio webhook routes**

Write `server/routes/twilio.js`:
```javascript
const express = require('express');
const router = express.Router();
const prisma = require('../prisma');
const twilioValidation = require('../middleware/twilioValidation');
const MessagingResponse = require('twilio').twiml.MessagingResponse;

const STOP_KEYWORDS = ['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT'];
const START_KEYWORDS = ['UNSTOP', 'START'];

// POST /webhook/sms
router.post('/sms', twilioValidation, async (req, res) => {
  const { From: phone, Body } = req.body;
  const keyword = (Body || '').trim().toUpperCase();
  const twiml = new MessagingResponse();

  // Log inbound message
  await prisma.inboundMessage.create({
    data: { fromPhone: phone, body: Body.trim(), action: keyword },
  });

  // Handle STOP
  if (STOP_KEYWORDS.includes(keyword)) {
    await prisma.subscriber.updateMany({
      where: { phone },
      data: { status: 'opted_out', optedOutAt: new Date() },
    });
    return res.type('text/xml').send(twiml.toString());
  }

  // Handle START/UNSTOP
  if (START_KEYWORDS.includes(keyword)) {
    await prisma.subscriber.updateMany({
      where: { phone },
      data: { status: 'active', optedOutAt: null },
    });
    return res.type('text/xml').send(twiml.toString());
  }

  // Handle YES — double opt-in confirmation
  if (keyword === 'YES') {
    const sub = await prisma.subscriber.findUnique({ where: { phone } });
    if (sub && sub.status === 'pending') {
      await prisma.subscriber.update({
        where: { id: sub.id },
        data: { status: 'active', confirmedAt: new Date() },
      });

      // Find the list they're pending for and send welcome
      const membership = await prisma.subscriberList.findFirst({
        where: { subscriberId: sub.id },
        include: { list: true },
      });
      if (membership && membership.list.welcomeMessage) {
        twiml.message(membership.list.welcomeMessage);
      }
    }
    return res.type('text/xml').send(twiml.toString());
  }

  // Look up keyword
  const keywordRecord = await prisma.keyword.findUnique({
    where: { keyword, active: true },
    include: { list: true },
  });

  if (!keywordRecord) {
    twiml.message('Hey! Text LUXE for exclusive drops or WHOLESALE for bulk deals.');
    return res.type('text/xml').send(twiml.toString());
  }

  // Upsert subscriber
  let subscriber = await prisma.subscriber.findUnique({ where: { phone } });

  if (subscriber) {
    if (subscriber.status === 'opted_out') {
      await prisma.subscriber.update({
        where: { id: subscriber.id },
        data: { status: keywordRecord.list.requireDoubleOptIn ? 'pending' : 'active', optedOutAt: null },
      });
    }
  } else {
    subscriber = await prisma.subscriber.create({
      data: {
        phone,
        status: keywordRecord.list.requireDoubleOptIn ? 'pending' : 'active',
        confirmedAt: keywordRecord.list.requireDoubleOptIn ? null : new Date(),
      },
    });
  }

  // Add to list (upsert to avoid duplicates)
  await prisma.subscriberList.upsert({
    where: {
      subscriberId_listId: { subscriberId: subscriber.id, listId: keywordRecord.listId },
    },
    update: {},
    create: { subscriberId: subscriber.id, listId: keywordRecord.listId },
  });

  // Send response
  if (keywordRecord.list.requireDoubleOptIn && subscriber.status !== 'active') {
    twiml.message('Reply YES to confirm your subscription to bylxe drops. Reply STOP to cancel.');
  } else {
    const msg = keywordRecord.responseMessage || keywordRecord.list.welcomeMessage;
    if (msg) twiml.message(msg);
  }

  res.type('text/xml').send(twiml.toString());
});

// POST /webhook/status — delivery status callbacks
router.post('/status', twilioValidation, async (req, res) => {
  const { MessageSid, MessageStatus, ErrorMessage } = req.body;

  await prisma.messageLog.updateMany({
    where: { twilioSid: MessageSid },
    data: { status: MessageStatus, errorMessage: ErrorMessage || null },
  });

  if (MessageStatus === 'delivered') {
    const log = await prisma.messageLog.findFirst({ where: { twilioSid: MessageSid } });
    if (log) {
      await prisma.blast.update({
        where: { id: log.blastId },
        data: { deliveredCount: { increment: 1 } },
      });
    }
  }

  res.sendStatus(200);
});

module.exports = router;
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
npx vitest run tests/server/twilio-webhook.test.js
```

Expected: PASS — all tests.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add Twilio webhook routes with double opt-in flow"
```

---

## Task 6: Subscriber Routes

**Files:**
- Create: `bylxe/server/routes/subscribers.js`
- Test: `bylxe/tests/server/subscribers.test.js`

- [ ] **Step 1: Write subscriber route tests**

Write `tests/server/subscribers.test.js`:
```javascript
const { describe, it, expect, beforeEach } = require('vitest');
const request = require('supertest');
const express = require('express');
const { cleanDatabase, createTestUser, getAuthToken, createTestList, createTestSubscriber, prisma } = require('../helpers');

const app = express();
app.use(express.json());
app.use('/api/subscribers', require('../../server/routes/subscribers'));

describe('Subscriber routes', () => {
  let token;
  let list;

  beforeEach(async () => {
    await cleanDatabase();
    const user = await createTestUser();
    token = getAuthToken(user);
    list = await createTestList({ keyword: 'LUXE' });
  });

  describe('GET /api/subscribers', () => {
    it('returns subscribers filtered by status', async () => {
      await createTestSubscriber({ phone: '+15551111111', status: 'active' });
      await createTestSubscriber({ phone: '+15552222222', status: 'opted_out' });

      const res = await request(app)
        .get('/api/subscribers?status=active')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].phone).toBe('+15551111111');
    });
  });

  describe('GET /api/subscribers/:id', () => {
    it('returns subscriber with list memberships', async () => {
      const sub = await createTestSubscriber({ phone: '+15553333333' });
      await prisma.subscriberList.create({
        data: { subscriberId: sub.id, listId: list.id },
      });

      const res = await request(app)
        .get(`/api/subscribers/${sub.id}`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.phone).toBe('+15553333333');
      expect(res.body.lists).toHaveLength(1);
    });
  });

  describe('DELETE /api/subscribers/:id', () => {
    it('deletes a subscriber', async () => {
      const sub = await createTestSubscriber({ phone: '+15554444444' });

      const res = await request(app)
        .delete(`/api/subscribers/${sub.id}`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);

      const deleted = await prisma.subscriber.findUnique({ where: { id: sub.id } });
      expect(deleted).toBeNull();
    });
  });

  describe('GET /api/subscribers/export', () => {
    it('returns CSV data', async () => {
      await createTestSubscriber({ phone: '+15555555555', status: 'active' });

      const res = await request(app)
        .get('/api/subscribers/export')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/csv/);
      expect(res.text).toContain('+15555555555');
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/server/subscribers.test.js
```

Expected: FAIL.

- [ ] **Step 3: Write subscriber routes**

Write `server/routes/subscribers.js`:
```javascript
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const prisma = require('../prisma');

// GET /api/subscribers
router.get('/', auth, async (req, res) => {
  const { status, listId } = req.query;
  const where = {};
  if (status) where.status = status;
  if (listId) where.lists = { some: { listId: parseInt(listId) } };

  const subscribers = await prisma.subscriber.findMany({
    where,
    include: { lists: { include: { list: true } } },
    orderBy: { createdAt: 'desc' },
  });

  res.json(subscribers);
});

// GET /api/subscribers/export — must be before /:id to avoid conflict
router.get('/export', auth, async (req, res) => {
  const subscribers = await prisma.subscriber.findMany({
    include: { lists: { include: { list: true } } },
    orderBy: { createdAt: 'desc' },
  });

  const header = 'phone,status,lists,joined_at\n';
  const rows = subscribers.map((s) => {
    const listNames = s.lists.map((sl) => sl.list.name).join('; ');
    return `${s.phone},${s.status},"${listNames}",${s.createdAt.toISOString()}`;
  });

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="subscribers.csv"');
  res.send(header + rows.join('\n'));
});

// GET /api/subscribers/:id
router.get('/:id', auth, async (req, res) => {
  const subscriber = await prisma.subscriber.findUnique({
    where: { id: parseInt(req.params.id) },
    include: { lists: { include: { list: true } } },
  });

  if (!subscriber) return res.status(404).json({ error: 'Subscriber not found' });
  res.json(subscriber);
});

// DELETE /api/subscribers/:id
router.delete('/:id', auth, async (req, res) => {
  try {
    await prisma.subscriber.delete({ where: { id: parseInt(req.params.id) } });
    res.json({ success: true });
  } catch {
    res.status(404).json({ error: 'Subscriber not found' });
  }
});

module.exports = router;
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/server/subscribers.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add subscriber CRUD routes with CSV export"
```

---

## Task 7: Keyword Routes

**Files:**
- Create: `bylxe/server/routes/keywords.js`
- Test: `bylxe/tests/server/keywords.test.js`

- [ ] **Step 1: Write keyword route tests**

Write `tests/server/keywords.test.js`:
```javascript
const { describe, it, expect, beforeEach } = require('vitest');
const request = require('supertest');
const express = require('express');
const { cleanDatabase, createTestUser, getAuthToken, createTestList, prisma } = require('../helpers');

const app = express();
app.use(express.json());
app.use('/api/keywords', require('../../server/routes/keywords'));

describe('Keyword routes', () => {
  let token, list;

  beforeEach(async () => {
    await cleanDatabase();
    const user = await createTestUser();
    token = getAuthToken(user);
    list = await createTestList({ keyword: 'MAIN' });
  });

  it('POST / — creates a keyword', async () => {
    const res = await request(app)
      .post('/api/keywords')
      .set('Authorization', `Bearer ${token}`)
      .send({ keyword: 'VIP', listId: list.id, responseMessage: 'Welcome VIP!' });

    expect(res.status).toBe(200);
    expect(res.body.keyword).toBe('VIP');
  });

  it('GET / — lists keywords', async () => {
    await prisma.keyword.create({
      data: { keyword: 'TEST1', listId: list.id },
    });

    const res = await request(app)
      .get('/api/keywords')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
  });

  it('PUT /:id — updates a keyword', async () => {
    const kw = await prisma.keyword.create({
      data: { keyword: 'OLD', listId: list.id },
    });

    const res = await request(app)
      .put(`/api/keywords/${kw.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ responseMessage: 'Updated reply', active: false });

    expect(res.status).toBe(200);
    expect(res.body.responseMessage).toBe('Updated reply');
    expect(res.body.active).toBe(false);
  });

  it('DELETE /:id — removes a keyword', async () => {
    const kw = await prisma.keyword.create({
      data: { keyword: 'DEL', listId: list.id },
    });

    const res = await request(app)
      .delete(`/api/keywords/${kw.id}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/server/keywords.test.js
```

- [ ] **Step 3: Write keyword routes**

Write `server/routes/keywords.js`:
```javascript
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const prisma = require('../prisma');

// GET /api/keywords
router.get('/', auth, async (req, res) => {
  const keywords = await prisma.keyword.findMany({
    include: { list: true },
    orderBy: { createdAt: 'desc' },
  });
  res.json(keywords);
});

// POST /api/keywords
router.post('/', auth, async (req, res) => {
  const { keyword, listId, responseMessage } = req.body;

  if (!keyword || !listId) {
    return res.status(400).json({ error: 'keyword and listId are required' });
  }

  try {
    const kw = await prisma.keyword.create({
      data: {
        keyword: keyword.toUpperCase(),
        listId,
        responseMessage: responseMessage || null,
      },
      include: { list: true },
    });
    res.json(kw);
  } catch (e) {
    if (e.code === 'P2002') {
      return res.status(400).json({ error: 'Keyword already exists' });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/keywords/:id
router.put('/:id', auth, async (req, res) => {
  const { responseMessage, active } = req.body;

  const kw = await prisma.keyword.update({
    where: { id: parseInt(req.params.id) },
    data: {
      ...(responseMessage !== undefined && { responseMessage }),
      ...(active !== undefined && { active }),
    },
    include: { list: true },
  });

  res.json(kw);
});

// DELETE /api/keywords/:id
router.delete('/:id', auth, async (req, res) => {
  try {
    await prisma.keyword.delete({ where: { id: parseInt(req.params.id) } });
    res.json({ success: true });
  } catch {
    res.status(404).json({ error: 'Keyword not found' });
  }
});

module.exports = router;
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/server/keywords.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add keyword CRUD routes with tests"
```

---

## Task 8: Link Shortener + Redirect

**Files:**
- Create: `bylxe/server/services/shortener.js`
- Create: `bylxe/server/routes/links.js`
- Test: `bylxe/tests/server/links.test.js`

- [ ] **Step 1: Write shortener service**

Write `server/services/shortener.js`:
```javascript
const { nanoid } = require('nanoid');

function generateCode() {
  return nanoid(6);
}

module.exports = { generateCode };
```

- [ ] **Step 2: Write link route tests**

Write `tests/server/links.test.js`:
```javascript
const { describe, it, expect, beforeEach } = require('vitest');
const request = require('supertest');
const express = require('express');
const { cleanDatabase, createTestUser, getAuthToken, createTestList, createTestSubscriber, prisma } = require('../helpers');

const app = express();
app.use(express.json());
app.use('/api/links', require('../../server/routes/links'));

const { redirect } = require('../../server/routes/links');
app.get('/:code([a-zA-Z0-9]{4,8})', redirect);

describe('Link routes', () => {
  let token, user;

  beforeEach(async () => {
    await cleanDatabase();
    user = await createTestUser();
    token = getAuthToken(user);
  });

  it('POST /api/links — creates a short link', async () => {
    const res = await request(app)
      .post('/api/links')
      .set('Authorization', `Bearer ${token}`)
      .send({ destination_url: 'https://example.com/long-product-page' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('code');
    expect(res.body).toHaveProperty('short_url');
    expect(res.body.code).toHaveLength(6);
  });

  it('GET /api/links — lists links with click counts', async () => {
    await prisma.shortLink.create({
      data: { code: 'abc123', destinationUrl: 'https://example.com', createdBy: user.id },
    });

    const res = await request(app)
      .get('/api/links')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toHaveProperty('_count');
  });

  it('GET /:code — redirects and logs click', async () => {
    await prisma.shortLink.create({
      data: { code: 'redir1', destinationUrl: 'https://example.com/product', createdBy: user.id },
    });

    const res = await request(app).get('/redir1');

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('https://example.com/product');

    const clicks = await prisma.linkClick.findMany();
    expect(clicks).toHaveLength(1);
  });

  it('GET /:code?s=123 — tracks subscriber attribution', async () => {
    const sub = await createTestSubscriber({ phone: '+15550001111' });
    await prisma.shortLink.create({
      data: { code: 'track1', destinationUrl: 'https://example.com', createdBy: user.id },
    });

    await request(app).get(`/track1?s=${sub.id}`);

    const click = await prisma.linkClick.findFirst();
    expect(click.subscriberId).toBe(sub.id);
  });

  it('GET /:code — returns 404 for unknown code', async () => {
    const res = await request(app).get('/zzzzzz');
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
npx vitest run tests/server/links.test.js
```

- [ ] **Step 4: Write link routes**

Write `server/routes/links.js`:
```javascript
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const prisma = require('../prisma');
const { generateCode } = require('../services/shortener');

// POST /api/links
router.post('/', auth, async (req, res) => {
  const { destination_url, blast_id } = req.body;

  if (!destination_url) {
    return res.status(400).json({ error: 'destination_url is required' });
  }

  const code = generateCode();

  const link = await prisma.shortLink.create({
    data: {
      code,
      destinationUrl: destination_url,
      blastId: blast_id || null,
      createdBy: req.user.id,
    },
  });

  const shortUrl = `${process.env.SHORT_DOMAIN}/${code}`;
  res.json({ id: link.id, code, short_url: shortUrl });
});

// GET /api/links
router.get('/', auth, async (req, res) => {
  const links = await prisma.shortLink.findMany({
    include: {
      _count: { select: { linkClicks: true } },
      blast: { select: { body: true } },
    },
    orderBy: { createdAt: 'desc' },
  });
  res.json(links);
});

// GET /api/links/:id/clicks
router.get('/:id/clicks', auth, async (req, res) => {
  const clicks = await prisma.linkClick.findMany({
    where: { linkId: parseInt(req.params.id) },
    include: { subscriber: { select: { phone: true } } },
    orderBy: { clickedAt: 'desc' },
  });
  res.json(clicks);
});

// Redirect handler — exported separately for use in index.js
const redirect = async (req, res) => {
  const { code } = req.params;
  const subscriberId = req.query.s ? parseInt(req.query.s) : null;

  const link = await prisma.shortLink.findUnique({ where: { code } });
  if (!link) return res.status(404).send('Link not found');

  await prisma.linkClick.create({
    data: {
      linkId: link.id,
      blastId: link.blastId || null,
      subscriberId,
      userAgent: req.headers['user-agent'] || null,
    },
  });

  res.redirect(302, link.destinationUrl);
};

module.exports = router;
module.exports.redirect = redirect;
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
npx vitest run tests/server/links.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add link shortener routes with redirect and click tracking"
```

---

## Task 9: Message Routes (Compose, Send, AI Rephrase)

**Files:**
- Create: `bylxe/server/routes/messages.js`
- Test: `bylxe/tests/server/messages.test.js`

- [ ] **Step 1: Write message route tests**

Write `tests/server/messages.test.js`:
```javascript
const { describe, it, expect, beforeEach, vi } = require('vitest');
const request = require('supertest');
const express = require('express');
const { cleanDatabase, createTestUser, getAuthToken, createTestList, createTestSubscriber, prisma } = require('../helpers');

// Mock Twilio
vi.mock('../../server/services/twilio', () => ({
  send: vi.fn().mockResolvedValue({ sid: 'SM_mock' }),
}));

// Mock AI service
vi.mock('../../server/services/ai', () => ({
  rephrase: vi.fn().mockResolvedValue({
    tone: 'hype',
    variations: ['Variation 1', 'Variation 2', 'Variation 3'],
  }),
}));

const app = express();
app.use(express.json());
app.use('/api/messages', require('../../server/routes/messages'));

describe('Message routes', () => {
  let token, user, list;

  beforeEach(async () => {
    await cleanDatabase();
    user = await createTestUser();
    token = getAuthToken(user);
    list = await createTestList({ keyword: 'MSG' });
  });

  it('POST /api/messages/draft — saves a draft blast', async () => {
    const res = await request(app)
      .post('/api/messages/draft')
      .set('Authorization', `Bearer ${token}`)
      .send({ list_id: list.id, body: 'New drop incoming!' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('id');

    const blast = await prisma.blast.findUnique({ where: { id: res.body.id } });
    expect(blast.status).toBe('draft');
    expect(blast.body).toBe('New drop incoming!');
  });

  it('POST /api/messages/draft — saves a scheduled blast', async () => {
    const scheduledAt = new Date(Date.now() + 86400000).toISOString();

    const res = await request(app)
      .post('/api/messages/draft')
      .set('Authorization', `Bearer ${token}`)
      .send({ list_id: list.id, body: 'Scheduled drop', scheduled_at: scheduledAt });

    expect(res.status).toBe(200);

    const blast = await prisma.blast.findUnique({ where: { id: res.body.id } });
    expect(blast.status).toBe('scheduled');
  });

  it('POST /api/messages/:id/send — sends blast to active subscribers', async () => {
    const sub = await createTestSubscriber({ phone: '+15551112222' });
    await prisma.subscriberList.create({
      data: { subscriberId: sub.id, listId: list.id },
    });

    const blast = await prisma.blast.create({
      data: { listId: list.id, body: 'Fire drop!', createdBy: user.id },
    });

    const res = await request(app)
      .post(`/api/messages/${blast.id}/send`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.queued).toBe(1);
  });

  it('GET /api/messages — returns blast history', async () => {
    await prisma.blast.create({
      data: { listId: list.id, body: 'Test blast', createdBy: user.id, status: 'sent' },
    });

    const res = await request(app)
      .get('/api/messages')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  it('POST /api/messages/ai-rephrase — returns AI variations', async () => {
    const res = await request(app)
      .post('/api/messages/ai-rephrase')
      .set('Authorization', `Bearer ${token}`)
      .send({ text: 'New shoes available', tone: 'hype' });

    expect(res.status).toBe(200);
    expect(res.body.variations).toHaveLength(3);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/server/messages.test.js
```

- [ ] **Step 3: Write message routes**

Write `server/routes/messages.js`:
```javascript
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const prisma = require('../prisma');
const twilioService = require('../services/twilio');
const aiService = require('../services/ai');

// GET /api/messages
router.get('/', auth, async (req, res) => {
  const blasts = await prisma.blast.findMany({
    include: {
      list: { select: { name: true } },
      creator: { select: { name: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
  res.json(blasts);
});

// POST /api/messages/draft
router.post('/draft', auth, async (req, res) => {
  const { list_id, body, media_url, scheduled_at } = req.body;

  if (!list_id || !body) {
    return res.status(400).json({ error: 'list_id and body are required' });
  }

  const blast = await prisma.blast.create({
    data: {
      listId: list_id,
      body,
      mediaUrl: media_url || null,
      status: scheduled_at ? 'scheduled' : 'draft',
      scheduledAt: scheduled_at ? new Date(scheduled_at) : null,
      createdBy: req.user.id,
    },
  });

  res.json({ id: blast.id });
});

// POST /api/messages/:id/send
router.post('/:id/send', auth, async (req, res) => {
  const blast = await prisma.blast.findUnique({
    where: { id: parseInt(req.params.id) },
  });
  if (!blast) return res.status(404).json({ error: 'Blast not found' });

  const subscribers = await prisma.subscriber.findMany({
    where: {
      status: 'active',
      lists: { some: { listId: blast.listId } },
    },
  });

  if (!subscribers.length) {
    return res.status(400).json({ error: 'No active subscribers in this list' });
  }

  await prisma.blast.update({
    where: { id: blast.id },
    data: { status: 'sending', recipientCount: subscribers.length },
  });

  // Respond immediately
  res.json({ queued: subscribers.length });

  // Send asynchronously
  for (const sub of subscribers) {
    try {
      // Per-subscriber click attribution — tag bylxe.co links with ?s=subscriberId
      let personalizedBody = blast.body.replace(
        /https?:\/\/bylxe\.co\/([a-zA-Z0-9]{4,8})/g,
        (match, code) => `${process.env.SHORT_DOMAIN}/${code}?s=${sub.id}`
      );

      const msg = await twilioService.send({
        to: sub.phone,
        body: personalizedBody,
        mediaUrl: blast.mediaUrl,
      });

      await prisma.messageLog.create({
        data: {
          blastId: blast.id,
          subscriberId: sub.id,
          twilioSid: msg.sid,
          status: 'sent',
        },
      });
    } catch (err) {
      await prisma.messageLog.create({
        data: {
          blastId: blast.id,
          subscriberId: sub.id,
          status: 'failed',
          errorMessage: err.message,
        },
      });
    }
  }

  await prisma.blast.update({
    where: { id: blast.id },
    data: { status: 'sent', sentAt: new Date() },
  });
});

// POST /api/messages/ai-rephrase
router.post('/ai-rephrase', auth, async (req, res) => {
  const { text, tone } = req.body;

  if (!text) return res.status(400).json({ error: 'text is required' });

  try {
    const result = await aiService.rephrase(text, tone || 'hype');
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/messages/:id/logs
router.get('/:id/logs', auth, async (req, res) => {
  const logs = await prisma.messageLog.findMany({
    where: { blastId: parseInt(req.params.id) },
    include: { subscriber: { select: { phone: true } } },
    orderBy: { sentAt: 'desc' },
  });
  res.json(logs);
});

module.exports = router;
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/server/messages.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add message routes (draft, send, AI rephrase, logs)"
```

---

## Task 10: AI Rephrase Service (Multi-Provider)

**Files:**
- Create: `bylxe/server/services/ai/index.js`
- Create: `bylxe/server/services/ai/openai.js`
- Create: `bylxe/server/services/ai/gemini.js`
- Create: `bylxe/server/services/ai/claude.js`
- Test: `bylxe/tests/server/services/ai.test.js`

- [ ] **Step 1: Write AI service tests**

Write `tests/server/services/ai.test.js`:
```javascript
const { describe, it, expect, beforeEach, vi } = require('vitest');
const { cleanDatabase, createTestUser, prisma } = require('../../helpers');

// We test the provider routing logic, not the actual API calls
describe('AI service provider routing', () => {
  let user;

  beforeEach(async () => {
    await cleanDatabase();
    user = await createTestUser();
  });

  it('throws if no AI provider is configured', async () => {
    // Clear require cache so it re-reads settings
    delete require.cache[require.resolve('../../../server/services/ai/index')];
    const aiService = require('../../../server/services/ai/index');

    await expect(aiService.rephrase('test', 'hype')).rejects.toThrow(/not configured/i);
  });

  it('reads provider from settings and dispatches', async () => {
    await prisma.setting.createMany({
      data: [
        { key: 'ai_provider', value: 'openai', updatedBy: user.id },
        { key: 'ai_api_key', value: 'fake-encrypted-key', updatedBy: user.id },
        { key: 'ai_model', value: 'gpt-4o', updatedBy: user.id },
      ],
    });

    delete require.cache[require.resolve('../../../server/services/ai/index')];
    const aiService = require('../../../server/services/ai/index');

    // Mock the openai adapter
    const openaiAdapter = require('../../../server/services/ai/openai');
    vi.spyOn(openaiAdapter, 'rephrase').mockResolvedValue({
      tone: 'hype',
      variations: ['V1', 'V2', 'V3'],
    });

    const result = await aiService.rephrase('test msg', 'hype');
    expect(result.variations).toHaveLength(3);
    expect(openaiAdapter.rephrase).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/server/services/ai.test.js
```

- [ ] **Step 3: Write shared tone prompts and provider adapters**

Write `server/services/ai/index.js`:
```javascript
const prisma = require('../../prisma');
const { decrypt } = require('../encryption');

const TONE_PROMPTS = {
  hype: 'Rewrite this SMS message for a streetwear brand drop in a hype, energetic tone. Use relevant slang, emojis, and urgency. Keep it under 160 characters.',
  clean: 'Rewrite this SMS message in a clean, minimal, premium tone. No emojis. Sophisticated. Under 160 characters.',
  urgency: 'Rewrite this SMS message to create strong urgency and FOMO. Limited time, limited stock feel. Under 160 characters.',
};

const ADAPTERS = {
  openai: () => require('./openai'),
  gemini: () => require('./gemini'),
  claude: () => require('./claude'),
};

async function getSettings() {
  const rows = await prisma.setting.findMany({
    where: { key: { in: ['ai_provider', 'ai_api_key', 'ai_model'] } },
  });
  const settings = {};
  for (const row of rows) {
    settings[row.key] = row.value;
  }
  return settings;
}

async function rephrase(text, tone = 'hype') {
  const settings = await getSettings();
  const provider = settings.ai_provider;

  if (!provider || !settings.ai_api_key) {
    throw new Error('AI provider not configured. Go to Settings to configure.');
  }

  const adapterFactory = ADAPTERS[provider];
  if (!adapterFactory) {
    throw new Error(`Unknown AI provider: ${provider}`);
  }

  let apiKey;
  try {
    apiKey = decrypt(settings.ai_api_key);
  } catch {
    apiKey = settings.ai_api_key; // fallback if not encrypted
  }

  const prompt = TONE_PROMPTS[tone] || TONE_PROMPTS.hype;
  const model = settings.ai_model;
  const adapter = adapterFactory();

  return adapter.rephrase(text, prompt, apiKey, model);
}

module.exports = { rephrase, TONE_PROMPTS };
```

Write `server/services/ai/openai.js`:
```javascript
async function rephrase(text, prompt, apiKey, model = 'gpt-4o') {
  const { default: OpenAI } = await import('openai');
  const client = new OpenAI({ apiKey });

  const response = await client.chat.completions.create({
    model,
    max_tokens: 300,
    messages: [
      {
        role: 'user',
        content: `${prompt}\n\nOriginal message:\n${text}\n\nProvide 3 variations, each on a new line, prefixed with 1), 2), 3).`,
      },
    ],
  });

  const raw = response.choices[0].message.content;
  const variations = raw
    .split('\n')
    .filter((l) => /^\d\)/.test(l.trim()))
    .map((l) => l.replace(/^\d\)\s*/, '').trim());

  return { tone: 'custom', variations };
}

module.exports = { rephrase };
```

Write `server/services/ai/gemini.js`:
```javascript
async function rephrase(text, prompt, apiKey, model = 'gemini-2.0-flash') {
  const { GoogleGenerativeAI } = await import('@google/generative-ai');
  const genAI = new GoogleGenerativeAI(apiKey);
  const genModel = genAI.getGenerativeModel({ model });

  const result = await genModel.generateContent(
    `${prompt}\n\nOriginal message:\n${text}\n\nProvide 3 variations, each on a new line, prefixed with 1), 2), 3).`
  );

  const raw = result.response.text();
  const variations = raw
    .split('\n')
    .filter((l) => /^\d\)/.test(l.trim()))
    .map((l) => l.replace(/^\d\)\s*/, '').trim());

  return { tone: 'custom', variations };
}

module.exports = { rephrase };
```

Write `server/services/ai/claude.js`:
```javascript
async function rephrase(text, prompt, apiKey, model = 'claude-sonnet-4-20250514') {
  const Anthropic = (await import('@anthropic-ai/sdk')).default;
  const client = new Anthropic({ apiKey });

  const response = await client.messages.create({
    model,
    max_tokens: 300,
    messages: [
      {
        role: 'user',
        content: `${prompt}\n\nOriginal message:\n${text}\n\nProvide 3 variations, each on a new line, prefixed with 1), 2), 3).`,
      },
    ],
  });

  const raw = response.content[0].text;
  const variations = raw
    .split('\n')
    .filter((l) => /^\d\)/.test(l.trim()))
    .map((l) => l.replace(/^\d\)\s*/, '').trim());

  return { tone: 'custom', variations };
}

module.exports = { rephrase };
```

- [ ] **Step 4: Install optional AI provider SDKs**

```bash
npm install openai @google/generative-ai @anthropic-ai/sdk
```

These are loaded dynamically via `import()` so they only fail at runtime if the selected provider's SDK is missing.

- [ ] **Step 5: Run tests to verify they pass**

```bash
npx vitest run tests/server/services/ai.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add multi-provider AI rephrase service (OpenAI, Gemini, Claude)"
```

---

## Task 11: Analytics Routes

**Files:**
- Create: `bylxe/server/routes/analytics.js`
- Test: `bylxe/tests/server/analytics.test.js`

- [ ] **Step 1: Write analytics tests**

Write `tests/server/analytics.test.js`:
```javascript
const { describe, it, expect, beforeEach } = require('vitest');
const request = require('supertest');
const express = require('express');
const { cleanDatabase, createTestUser, getAuthToken, createTestList, createTestSubscriber, prisma } = require('../helpers');

const app = express();
app.use(express.json());
app.use('/api/analytics', require('../../server/routes/analytics'));

describe('Analytics routes', () => {
  let token, user, list;

  beforeEach(async () => {
    await cleanDatabase();
    user = await createTestUser();
    token = getAuthToken(user);
    list = await createTestList({ keyword: 'LUXE', name: 'Drops & Deals' });
  });

  describe('GET /api/analytics/overview', () => {
    it('returns dashboard stats', async () => {
      const sub = await createTestSubscriber({ phone: '+15551111111', status: 'active' });
      await prisma.subscriberList.create({
        data: { subscriberId: sub.id, listId: list.id },
      });

      await prisma.blast.create({
        data: { listId: list.id, body: 'test', createdBy: user.id, status: 'sent' },
      });

      const res = await request(app)
        .get('/api/analytics/overview')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.totalSubs).toBe(1);
      expect(res.body.totalBlasts).toBe(1);
      expect(res.body).toHaveProperty('growth');
    });
  });

  describe('GET /api/analytics/blast/:id', () => {
    it('returns per-blast stats', async () => {
      const blast = await prisma.blast.create({
        data: { listId: list.id, body: 'test', createdBy: user.id, status: 'sent', sentAt: new Date() },
      });

      const res = await request(app)
        .get(`/api/analytics/blast/${blast.id}`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('blast');
      expect(res.body).toHaveProperty('clicks');
      expect(res.body).toHaveProperty('deliveries');
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/server/analytics.test.js
```

- [ ] **Step 3: Write analytics routes**

Write `server/routes/analytics.js`:
```javascript
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const prisma = require('../prisma');

// GET /api/analytics/overview
router.get('/overview', auth, async (req, res) => {
  const [totalSubs, totalBlasts, totalClicks, optOuts] = await Promise.all([
    prisma.subscriber.count({ where: { status: 'active' } }),
    prisma.blast.count({ where: { status: 'sent' } }),
    prisma.linkClick.count(),
    prisma.subscriber.count({ where: { status: 'opted_out' } }),
  ]);

  // Per-list subscriber counts
  const listCounts = await prisma.list.findMany({
    include: {
      _count: {
        select: {
          subscribers: {
            where: { subscriber: { status: 'active' } },
          },
        },
      },
    },
  });

  // 30-day subscriber growth
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const growth = await prisma.$queryRaw`
    SELECT DATE("created_at") as date, COUNT(*)::int as new_subs
    FROM subscribers
    WHERE "created_at" >= ${thirtyDaysAgo}
    GROUP BY DATE("created_at")
    ORDER BY date ASC
  `;

  res.json({
    totalSubs,
    totalBlasts,
    totalClicks,
    optOuts,
    listCounts: listCounts.map((l) => ({
      id: l.id,
      name: l.name,
      keyword: l.keyword,
      count: l._count.subscribers,
    })),
    growth,
  });
});

// GET /api/analytics/blast/:id
router.get('/blast/:id', auth, async (req, res) => {
  const blastId = parseInt(req.params.id);

  const [blast, clicks, deliveries] = await Promise.all([
    prisma.blast.findUnique({
      where: { id: blastId },
      include: { list: { select: { name: true } } },
    }),
    prisma.linkClick.count({ where: { blastId } }),
    prisma.messageLog.groupBy({
      by: ['status'],
      where: { blastId },
      _count: true,
    }),
  ]);

  if (!blast) return res.status(404).json({ error: 'Blast not found' });

  // Time-to-click distribution (minutes after blast sent)
  let timeToClick = [];
  if (blast.sentAt) {
    timeToClick = await prisma.$queryRaw`
      SELECT
        ROUND(EXTRACT(EPOCH FROM (lc."clicked_at" - ${blast.sentAt})) / 60)::int as minutes_after,
        COUNT(*)::int as clicks
      FROM link_clicks lc
      WHERE lc."blast_id" = ${blastId}
      GROUP BY minutes_after
      ORDER BY minutes_after ASC
      LIMIT 60
    `;
  }

  res.json({
    blast,
    clicks,
    deliveries: deliveries.map((d) => ({ status: d.status, count: d._count })),
    timeToClick,
  });
});

module.exports = router;
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/server/analytics.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add analytics routes (overview + per-blast stats)"
```

---

## Task 12: Settings Routes

**Files:**
- Create: `bylxe/server/routes/settings.js`
- Test: `bylxe/tests/server/settings.test.js`

- [ ] **Step 1: Write settings tests**

Write `tests/server/settings.test.js`:
```javascript
const { describe, it, expect, beforeEach } = require('vitest');
const request = require('supertest');
const express = require('express');
const { cleanDatabase, createTestUser, getAuthToken, prisma } = require('../helpers');

const app = express();
app.use(express.json());
app.use('/api/settings', require('../../server/routes/settings'));

describe('Settings routes', () => {
  let token, user;

  beforeEach(async () => {
    await cleanDatabase();
    user = await createTestUser();
    token = getAuthToken(user);
  });

  it('PUT /api/settings — saves AI provider settings', async () => {
    const res = await request(app)
      .put('/api/settings')
      .set('Authorization', `Bearer ${token}`)
      .send({
        ai_provider: 'openai',
        ai_api_key: 'sk-test-key-123',
        ai_model: 'gpt-4o',
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    // Verify the API key is encrypted
    const setting = await prisma.setting.findUnique({ where: { key: 'ai_api_key' } });
    expect(setting.value).not.toBe('sk-test-key-123');
    expect(setting.value).toContain(':'); // iv:encrypted format
  });

  it('GET /api/settings — returns settings with masked API key', async () => {
    await request(app)
      .put('/api/settings')
      .set('Authorization', `Bearer ${token}`)
      .send({
        ai_provider: 'openai',
        ai_api_key: 'sk-test-key-123',
        ai_model: 'gpt-4o',
      });

    const res = await request(app)
      .get('/api/settings')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.ai_provider).toBe('openai');
    expect(res.body.ai_api_key).toMatch(/^\*+/); // masked
    expect(res.body.ai_model).toBe('gpt-4o');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/server/settings.test.js
```

- [ ] **Step 3: Write settings routes**

Write `server/routes/settings.js`:
```javascript
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const prisma = require('../prisma');
const { encrypt, decrypt } = require('../services/encryption');

const SENSITIVE_KEYS = ['ai_api_key'];

// GET /api/settings
router.get('/', auth, async (req, res) => {
  const rows = await prisma.setting.findMany();
  const settings = {};

  for (const row of rows) {
    if (SENSITIVE_KEYS.includes(row.key)) {
      // Return masked value
      try {
        const decrypted = decrypt(row.value);
        settings[row.key] = '****' + decrypted.slice(-4);
      } catch {
        settings[row.key] = '********';
      }
    } else {
      settings[row.key] = row.value;
    }
  }

  res.json(settings);
});

// PUT /api/settings
router.put('/', auth, async (req, res) => {
  const entries = Object.entries(req.body);

  for (const [key, value] of entries) {
    const storedValue = SENSITIVE_KEYS.includes(key) ? encrypt(value) : value;

    await prisma.setting.upsert({
      where: { key },
      update: { value: storedValue, updatedBy: req.user.id },
      create: { key, value: storedValue, updatedBy: req.user.id },
    });
  }

  res.json({ success: true });
});

module.exports = router;
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/server/settings.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add settings routes with encrypted API key storage"
```

---

## Task 13: Scheduler Service

**Files:**
- Create: `bylxe/server/services/scheduler.js`
- Test: `bylxe/tests/server/services/scheduler.test.js`

- [ ] **Step 1: Write scheduler test**

Write `tests/server/services/scheduler.test.js`:
```javascript
const { describe, it, expect, beforeEach, vi } = require('vitest');
const { cleanDatabase, createTestUser, createTestList, createTestSubscriber, prisma } = require('../../helpers');

// Mock Twilio
vi.mock('../../../server/services/twilio', () => ({
  send: vi.fn().mockResolvedValue({ sid: 'SM_sched_mock' }),
}));

// Mock node-cron so it doesn't actually schedule
vi.mock('node-cron', () => ({
  schedule: vi.fn(),
}));

describe('Scheduler', () => {
  it('sendDueBlasts sends blasts that are past their scheduled time', async () => {
    await cleanDatabase();
    const user = await createTestUser();
    const list = await createTestList({ keyword: 'SCHED' });
    const sub = await createTestSubscriber({ phone: '+15550001234' });
    await prisma.subscriberList.create({
      data: { subscriberId: sub.id, listId: list.id },
    });

    // Create a blast scheduled in the past
    await prisma.blast.create({
      data: {
        listId: list.id,
        body: 'Scheduled drop!',
        status: 'scheduled',
        scheduledAt: new Date(Date.now() - 60000), // 1 minute ago
        createdBy: user.id,
      },
    });

    const { sendDueBlasts } = require('../../../server/services/scheduler');
    await sendDueBlasts();

    const twilioService = require('../../../server/services/twilio');
    expect(twilioService.send).toHaveBeenCalledWith(
      expect.objectContaining({ to: '+15550001234', body: 'Scheduled drop!' })
    );

    const blast = await prisma.blast.findFirst({ where: { body: 'Scheduled drop!' } });
    expect(blast.status).toBe('sent');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/server/services/scheduler.test.js
```

- [ ] **Step 3: Write scheduler service**

Write `server/services/scheduler.js`:
```javascript
const cron = require('node-cron');
const prisma = require('../prisma');
const twilioService = require('./twilio');

async function sendDueBlasts() {
  const due = await prisma.blast.findMany({
    where: {
      status: 'scheduled',
      scheduledAt: { lte: new Date() },
    },
  });

  for (const blast of due) {
    const subscribers = await prisma.subscriber.findMany({
      where: {
        status: 'active',
        lists: { some: { listId: blast.listId } },
      },
    });

    await prisma.blast.update({
      where: { id: blast.id },
      data: { status: 'sending', recipientCount: subscribers.length },
    });

    for (const sub of subscribers) {
      try {
        let personalizedBody = blast.body.replace(
          /https?:\/\/bylxe\.co\/([a-zA-Z0-9]{4,8})/g,
          (match, code) => `${process.env.SHORT_DOMAIN}/${code}?s=${sub.id}`
        );

        const msg = await twilioService.send({
          to: sub.phone,
          body: personalizedBody,
          mediaUrl: blast.mediaUrl,
        });

        await prisma.messageLog.create({
          data: {
            blastId: blast.id,
            subscriberId: sub.id,
            twilioSid: msg.sid,
            status: 'sent',
          },
        });
      } catch (err) {
        await prisma.messageLog.create({
          data: {
            blastId: blast.id,
            subscriberId: sub.id,
            status: 'failed',
            errorMessage: err.message,
          },
        });
      }
    }

    await prisma.blast.update({
      where: { id: blast.id },
      data: { status: 'sent', sentAt: new Date() },
    });
  }
}

function init() {
  // Check every minute for scheduled blasts
  cron.schedule('* * * * *', () => {
    sendDueBlasts().catch((err) => console.error('Scheduler error:', err));
  });
  console.log('Scheduler running');
}

module.exports = { init, sendDueBlasts };
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run tests/server/services/scheduler.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add node-cron scheduler for sending due blasts"
```

---

## Task 14: Run All Server Tests

- [ ] **Step 1: Run the full test suite**

```bash
npx vitest run
```

Expected: All tests pass. If any fail, fix them before proceeding.

- [ ] **Step 2: Verify server starts**

```bash
node server/index.js
```

Expected: `bylxe server running on port 3001` and `Scheduler running`. Press Ctrl+C to stop.

- [ ] **Step 3: Commit any fixes**

```bash
git add -A
git commit -m "fix: resolve any issues found in full test suite run"
```

---

## Task 15: React Frontend — Scaffold & Layout

**Files:**
- Create: `bylxe/client/package.json`
- Create: `bylxe/client/index.html`
- Create: `bylxe/client/vite.config.js`
- Create: `bylxe/client/tailwind.config.js`
- Create: `bylxe/client/postcss.config.js`
- Create: `bylxe/client/src/main.jsx`
- Create: `bylxe/client/src/App.jsx`
- Create: `bylxe/client/src/index.css`
- Create: `bylxe/client/src/lib/api.js`
- Create: `bylxe/client/src/lib/auth.js`
- Create: `bylxe/client/src/components/Layout.jsx`
- Create: `bylxe/client/src/components/Sidebar.jsx`

- [ ] **Step 1: Initialize client package**

```bash
mkdir -p client/src/{pages,components,lib}
```

Write `client/package.json`:
```json
{
  "name": "bylxe-client",
  "private": true,
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview"
  }
}
```

- [ ] **Step 2: Install client dependencies**

```bash
cd client
npm install react react-dom react-router-dom axios recharts
npm install -D vite @vitejs/plugin-react tailwindcss @tailwindcss/vite postcss
cd ..
```

- [ ] **Step 3: Create Vite config**

Write `client/vite.config.js`:
```javascript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/api': 'http://localhost:3001',
      '/webhook': 'http://localhost:3001',
    },
  },
});
```

- [ ] **Step 4: Create Tailwind and PostCSS config**

Write `client/tailwind.config.js`:
```javascript
/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {},
  },
  plugins: [],
};
```

Write `client/postcss.config.js`:
```javascript
export default {
  plugins: {},
};
```

- [ ] **Step 5: Create index.html**

Write `client/index.html`:
```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>bylxe SMS Dashboard</title>
  </head>
  <body class="bg-zinc-950 text-zinc-100">
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>
```

- [ ] **Step 6: Create CSS entry**

Write `client/src/index.css`:
```css
@import "tailwindcss";
```

- [ ] **Step 7: Create API and auth helpers**

Write `client/src/lib/api.js`:
```javascript
import axios from 'axios';
import { getToken } from './auth';

const api = axios.create({ baseURL: '/api' });

api.interceptors.request.use((config) => {
  const token = getToken();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401) {
      localStorage.removeItem('bylxe_token');
      window.location.href = '/login';
    }
    return Promise.reject(err);
  }
);

export default api;
```

Write `client/src/lib/auth.js`:
```javascript
const TOKEN_KEY = 'bylxe_token';
const USER_KEY = 'bylxe_user';

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function setAuth(token, user) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function getUser() {
  const raw = localStorage.getItem(USER_KEY);
  return raw ? JSON.parse(raw) : null;
}

export function clearAuth() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

export function isAuthenticated() {
  return !!getToken();
}
```

- [ ] **Step 8: Create Layout and Sidebar components**

Write `client/src/components/Sidebar.jsx`:
```jsx
import { NavLink } from 'react-router-dom';
import { clearAuth } from '../lib/auth';

const links = [
  { to: '/', label: 'Dashboard' },
  { to: '/compose', label: 'Compose' },
  { to: '/subscribers', label: 'Subscribers' },
  { to: '/messages', label: 'Message Logs' },
  { to: '/links', label: 'Links' },
  { to: '/keywords', label: 'Keywords' },
  { to: '/settings', label: 'Settings' },
];

export default function Sidebar() {
  const handleLogout = () => {
    clearAuth();
    window.location.href = '/login';
  };

  return (
    <aside className="w-56 bg-zinc-900 border-r border-zinc-800 flex flex-col min-h-screen">
      <div className="p-4 border-b border-zinc-800">
        <h1 className="text-lg font-bold tracking-tight">bylxe</h1>
        <p className="text-xs text-zinc-500">SMS Dashboard</p>
      </div>
      <nav className="flex-1 p-2">
        {links.map((link) => (
          <NavLink
            key={link.to}
            to={link.to}
            className={({ isActive }) =>
              `block px-3 py-2 rounded text-sm ${
                isActive
                  ? 'bg-zinc-800 text-white'
                  : 'text-zinc-400 hover:text-white hover:bg-zinc-800/50'
              }`
            }
          >
            {link.label}
          </NavLink>
        ))}
      </nav>
      <div className="p-2 border-t border-zinc-800">
        <button
          onClick={handleLogout}
          className="w-full px-3 py-2 text-sm text-zinc-400 hover:text-white hover:bg-zinc-800/50 rounded text-left"
        >
          Logout
        </button>
      </div>
    </aside>
  );
}
```

Write `client/src/components/Layout.jsx`:
```jsx
import { Outlet } from 'react-router-dom';
import Sidebar from './Sidebar';

export default function Layout() {
  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <main className="flex-1 p-6 overflow-auto">
        <Outlet />
      </main>
    </div>
  );
}
```

- [ ] **Step 9: Create App with routing and main entry**

Write `client/src/App.jsx`:
```jsx
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { isAuthenticated } from './lib/auth';
import Layout from './components/Layout';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Compose from './pages/Compose';
import Subscribers from './pages/Subscribers';
import MessageLogs from './pages/MessageLogs';
import Links from './pages/Links';
import Keywords from './pages/Keywords';
import Settings from './pages/Settings';

function ProtectedRoute({ children }) {
  return isAuthenticated() ? children : <Navigate to="/login" />;
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route
          element={
            <ProtectedRoute>
              <Layout />
            </ProtectedRoute>
          }
        >
          <Route path="/" element={<Dashboard />} />
          <Route path="/compose" element={<Compose />} />
          <Route path="/subscribers" element={<Subscribers />} />
          <Route path="/messages" element={<MessageLogs />} />
          <Route path="/links" element={<Links />} />
          <Route path="/keywords" element={<Keywords />} />
          <Route path="/settings" element={<Settings />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
```

Write `client/src/main.jsx`:
```jsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
```

- [ ] **Step 10: Create placeholder pages**

Create placeholder components for each page so the app compiles. Each is a simple export:

Write `client/src/pages/Login.jsx`:
```jsx
export default function Login() {
  return <div>Login placeholder</div>;
}
```

Write `client/src/pages/Dashboard.jsx`:
```jsx
export default function Dashboard() {
  return <div>Dashboard placeholder</div>;
}
```

Write `client/src/pages/Compose.jsx`:
```jsx
export default function Compose() {
  return <div>Compose placeholder</div>;
}
```

Write `client/src/pages/Subscribers.jsx`:
```jsx
export default function Subscribers() {
  return <div>Subscribers placeholder</div>;
}
```

Write `client/src/pages/MessageLogs.jsx`:
```jsx
export default function MessageLogs() {
  return <div>MessageLogs placeholder</div>;
}
```

Write `client/src/pages/Links.jsx`:
```jsx
export default function Links() {
  return <div>Links placeholder</div>;
}
```

Write `client/src/pages/Keywords.jsx`:
```jsx
export default function Keywords() {
  return <div>Keywords placeholder</div>;
}
```

Write `client/src/pages/Settings.jsx`:
```jsx
export default function Settings() {
  return <div>Settings placeholder</div>;
}
```

- [ ] **Step 11: Verify client builds**

```bash
cd client && npm run build && cd ..
```

Expected: Build succeeds, output in `client/dist/`.

- [ ] **Step 12: Commit**

```bash
git add -A
git commit -m "feat: scaffold React frontend with routing, layout, and sidebar"
```

---

## Task 16: Login Page

**Files:**
- Modify: `bylxe/client/src/pages/Login.jsx`

- [ ] **Step 1: Implement Login page**

Write `client/src/pages/Login.jsx`:
```jsx
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../lib/api';
import { setAuth } from '../lib/auth';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const { data } = await api.post('/auth/login', { email, password });
      setAuth(data.token, data.user);
      navigate('/');
    } catch (err) {
      setError(err.response?.data?.error || 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-zinc-950">
      <form onSubmit={handleSubmit} className="w-full max-w-sm space-y-4 p-8">
        <div className="text-center mb-8">
          <h1 className="text-2xl font-bold tracking-tight">bylxe</h1>
          <p className="text-sm text-zinc-500 mt-1">SMS Dashboard</p>
        </div>

        {error && (
          <div className="bg-red-900/30 border border-red-800 text-red-300 px-4 py-2 rounded text-sm">
            {error}
          </div>
        )}

        <input
          type="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          className="w-full px-3 py-2 bg-zinc-900 border border-zinc-800 rounded text-sm focus:outline-none focus:border-zinc-600"
        />
        <input
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          className="w-full px-3 py-2 bg-zinc-900 border border-zinc-800 rounded text-sm focus:outline-none focus:border-zinc-600"
        />
        <button
          type="submit"
          disabled={loading}
          className="w-full py-2 bg-white text-black rounded text-sm font-medium hover:bg-zinc-200 disabled:opacity-50"
        >
          {loading ? 'Signing in...' : 'Sign In'}
        </button>
      </form>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add -A
git commit -m "feat: implement Login page"
```

---

## Task 17: Dashboard Page

**Files:**
- Modify: `bylxe/client/src/pages/Dashboard.jsx`

- [ ] **Step 1: Implement Dashboard page**

Write `client/src/pages/Dashboard.jsx`:
```jsx
import { useState, useEffect } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import api from '../lib/api';

function StatCard({ label, value }) {
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
      <p className="text-xs text-zinc-500 uppercase tracking-wide">{label}</p>
      <p className="text-2xl font-bold mt-1">{value}</p>
    </div>
  );
}

export default function Dashboard() {
  const [stats, setStats] = useState(null);
  const [blasts, setBlasts] = useState([]);

  useEffect(() => {
    api.get('/analytics/overview').then((r) => setStats(r.data));
    api.get('/messages').then((r) => setBlasts(r.data.slice(0, 10)));
  }, []);

  if (!stats) return <p className="text-zinc-500">Loading...</p>;

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-bold">Dashboard</h2>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="Active Subscribers" value={stats.totalSubs} />
        <StatCard label="Blasts Sent" value={stats.totalBlasts} />
        <StatCard label="Total Clicks" value={stats.totalClicks} />
        <StatCard label="Opt-Outs" value={stats.optOuts} />
      </div>

      {stats.listCounts?.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {stats.listCounts.map((lc) => (
            <StatCard key={lc.id} label={`${lc.name} (${lc.keyword})`} value={lc.count} />
          ))}
        </div>
      )}

      {stats.growth?.length > 0 && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
          <h3 className="text-sm font-medium text-zinc-400 mb-4">Subscriber Growth (30 days)</h3>
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={stats.growth}>
              <CartesianGrid strokeDasharray="3 3" stroke="#333" />
              <XAxis dataKey="date" tick={{ fontSize: 11, fill: '#888' }} />
              <YAxis tick={{ fontSize: 11, fill: '#888' }} />
              <Tooltip
                contentStyle={{ background: '#1a1a1a', border: '1px solid #333', borderRadius: 8 }}
                labelStyle={{ color: '#888' }}
              />
              <Line type="monotone" dataKey="new_subs" stroke="#fff" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      <div className="bg-zinc-900 border border-zinc-800 rounded-lg">
        <div className="p-4 border-b border-zinc-800">
          <h3 className="text-sm font-medium text-zinc-400">Recent Blasts</h3>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-zinc-500 border-b border-zinc-800">
              <th className="px-4 py-2">List</th>
              <th className="px-4 py-2">Message</th>
              <th className="px-4 py-2">Status</th>
              <th className="px-4 py-2">Sent</th>
              <th className="px-4 py-2">Delivered</th>
            </tr>
          </thead>
          <tbody>
            {blasts.map((b) => (
              <tr key={b.id} className="border-b border-zinc-800/50">
                <td className="px-4 py-2">{b.list?.name || '—'}</td>
                <td className="px-4 py-2 max-w-xs truncate">{b.body}</td>
                <td className="px-4 py-2">
                  <span className={`px-2 py-0.5 rounded text-xs ${
                    b.status === 'sent' ? 'bg-green-900/50 text-green-400' :
                    b.status === 'sending' ? 'bg-yellow-900/50 text-yellow-400' :
                    b.status === 'failed' ? 'bg-red-900/50 text-red-400' :
                    'bg-zinc-800 text-zinc-400'
                  }`}>
                    {b.status}
                  </span>
                </td>
                <td className="px-4 py-2">{b.recipientCount}</td>
                <td className="px-4 py-2">{b.deliveredCount}</td>
              </tr>
            ))}
            {blasts.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-zinc-500">No blasts yet</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add -A
git commit -m "feat: implement Dashboard page with stats and growth chart"
```

---

## Task 18: Compose Page

**Files:**
- Modify: `bylxe/client/src/pages/Compose.jsx`
- Create: `bylxe/client/src/components/AIComposer.jsx`
- Create: `bylxe/client/src/components/LinkInserter.jsx`
- Create: `bylxe/client/src/components/SchedulePicker.jsx`

- [ ] **Step 1: Create AIComposer component**

Write `client/src/components/AIComposer.jsx`:
```jsx
import { useState } from 'react';
import api from '../lib/api';

const TONES = [
  { value: 'hype', label: 'Hype' },
  { value: 'clean', label: 'Clean' },
  { value: 'urgency', label: 'Urgency' },
];

export default function AIComposer({ onSelect }) {
  const [text, setText] = useState('');
  const [tone, setTone] = useState('hype');
  const [variations, setVariations] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleRephrase = async () => {
    if (!text.trim()) return;
    setLoading(true);
    setError('');
    try {
      const { data } = await api.post('/messages/ai-rephrase', { text, tone });
      setVariations(data.variations || []);
    } catch (err) {
      setError(err.response?.data?.error || 'AI rephrase failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 space-y-3">
      <h3 className="text-sm font-medium text-zinc-400">AI Rephrase</h3>

      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Paste your draft message here..."
        rows={2}
        className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded text-sm resize-none focus:outline-none focus:border-zinc-500"
      />

      <div className="flex gap-2 items-center">
        {TONES.map((t) => (
          <button
            key={t.value}
            onClick={() => setTone(t.value)}
            className={`px-3 py-1 rounded text-xs ${
              tone === t.value ? 'bg-white text-black' : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'
            }`}
          >
            {t.label}
          </button>
        ))}
        <button
          onClick={handleRephrase}
          disabled={loading || !text.trim()}
          className="ml-auto px-4 py-1 bg-zinc-700 hover:bg-zinc-600 rounded text-xs disabled:opacity-50"
        >
          {loading ? 'Generating...' : 'Rephrase'}
        </button>
      </div>

      {error && <p className="text-xs text-red-400">{error}</p>}

      {variations.length > 0 && (
        <div className="space-y-2">
          {variations.map((v, i) => (
            <div
              key={i}
              onClick={() => onSelect(v)}
              className="p-3 bg-zinc-800 border border-zinc-700 rounded cursor-pointer hover:border-zinc-500 text-sm"
            >
              {v}
              <span className="block text-xs text-zinc-500 mt-1">{v.length} chars — click to use</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Create LinkInserter component**

Write `client/src/components/LinkInserter.jsx`:
```jsx
import { useState } from 'react';
import api from '../lib/api';

export default function LinkInserter({ onInsert }) {
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [shortUrl, setShortUrl] = useState('');

  const handleShorten = async () => {
    if (!url.trim()) return;
    setLoading(true);
    try {
      const { data } = await api.post('/links', { destination_url: url });
      setShortUrl(data.short_url);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 space-y-3">
      <h3 className="text-sm font-medium text-zinc-400">Link Shortener</h3>
      <div className="flex gap-2">
        <input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="Paste long URL..."
          className="flex-1 px-3 py-2 bg-zinc-800 border border-zinc-700 rounded text-sm focus:outline-none focus:border-zinc-500"
        />
        <button
          onClick={handleShorten}
          disabled={loading || !url.trim()}
          className="px-4 py-2 bg-zinc-700 hover:bg-zinc-600 rounded text-xs disabled:opacity-50"
        >
          {loading ? '...' : 'Shorten'}
        </button>
      </div>
      {shortUrl && (
        <div className="flex items-center gap-2">
          <code className="text-xs text-green-400 flex-1">{shortUrl}</code>
          <button
            onClick={() => { onInsert(shortUrl); setShortUrl(''); setUrl(''); }}
            className="px-3 py-1 bg-white text-black rounded text-xs"
          >
            Insert into message
          </button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Create SchedulePicker component**

Write `client/src/components/SchedulePicker.jsx`:
```jsx
export default function SchedulePicker({ value, onChange }) {
  return (
    <div className="flex items-center gap-3">
      <label className="text-sm text-zinc-400">Schedule for:</label>
      <input
        type="datetime-local"
        value={value || ''}
        onChange={(e) => onChange(e.target.value || null)}
        className="px-3 py-2 bg-zinc-800 border border-zinc-700 rounded text-sm focus:outline-none focus:border-zinc-500"
      />
      {value && (
        <button
          onClick={() => onChange(null)}
          className="text-xs text-zinc-500 hover:text-white"
        >
          Clear
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Implement Compose page**

Write `client/src/pages/Compose.jsx`:
```jsx
import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../lib/api';
import AIComposer from '../components/AIComposer';
import LinkInserter from '../components/LinkInserter';
import SchedulePicker from '../components/SchedulePicker';

export default function Compose() {
  const [lists, setLists] = useState([]);
  const [listId, setListId] = useState('');
  const [body, setBody] = useState('');
  const [mediaUrl, setMediaUrl] = useState('');
  const [scheduledAt, setScheduledAt] = useState(null);
  const [showSchedule, setShowSchedule] = useState(false);
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState('');
  const textareaRef = useRef(null);
  const navigate = useNavigate();

  useEffect(() => {
    api.get('/keywords').then((r) => {
      const uniqueLists = [];
      const seen = new Set();
      for (const kw of r.data) {
        if (!seen.has(kw.list.id)) {
          seen.add(kw.list.id);
          uniqueLists.push(kw.list);
        }
      }
      setLists(uniqueLists);
      if (uniqueLists.length > 0) setListId(uniqueLists[0].id);
    });
  }, []);

  const charCount = body.length;
  const isOverLimit = charCount > (mediaUrl ? 1600 : 160);

  const insertAtCursor = (text) => {
    const el = textareaRef.current;
    if (!el) { setBody((prev) => prev + ' ' + text); return; }
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const newBody = body.slice(0, start) + text + body.slice(end);
    setBody(newBody);
    setTimeout(() => {
      el.selectionStart = el.selectionEnd = start + text.length;
      el.focus();
    }, 0);
  };

  const handleSave = async (sendNow = false) => {
    if (!listId || !body.trim()) return;
    setSending(true);
    setMessage('');

    try {
      const { data } = await api.post('/messages/draft', {
        list_id: parseInt(listId),
        body,
        media_url: mediaUrl || undefined,
        scheduled_at: showSchedule && scheduledAt ? new Date(scheduledAt).toISOString() : undefined,
      });

      if (sendNow) {
        await api.post(`/messages/${data.id}/send`);
        setMessage('Blast sent!');
      } else if (showSchedule && scheduledAt) {
        setMessage('Blast scheduled!');
      } else {
        setMessage('Draft saved!');
      }

      setTimeout(() => navigate('/messages'), 1500);
    } catch (err) {
      setMessage(err.response?.data?.error || 'Failed');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="max-w-3xl space-y-6">
      <h2 className="text-xl font-bold">Compose Blast</h2>

      {message && (
        <div className="bg-zinc-800 border border-zinc-700 px-4 py-2 rounded text-sm">{message}</div>
      )}

      <div className="space-y-4">
        <div>
          <label className="block text-sm text-zinc-400 mb-1">Send to list</label>
          <select
            value={listId}
            onChange={(e) => setListId(e.target.value)}
            className="w-full px-3 py-2 bg-zinc-900 border border-zinc-800 rounded text-sm focus:outline-none focus:border-zinc-600"
          >
            {lists.map((l) => (
              <option key={l.id} value={l.id}>{l.name} ({l.keyword})</option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-sm text-zinc-400 mb-1">
            Message
            <span className={`ml-2 ${isOverLimit ? 'text-red-400' : 'text-zinc-500'}`}>
              {charCount}/{mediaUrl ? 1600 : 160}
            </span>
          </label>
          <textarea
            ref={textareaRef}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={4}
            placeholder="Type your message..."
            className="w-full px-3 py-2 bg-zinc-900 border border-zinc-800 rounded text-sm resize-none focus:outline-none focus:border-zinc-600"
          />
        </div>

        <div>
          <label className="block text-sm text-zinc-400 mb-1">MMS Image URL (optional)</label>
          <input
            type="url"
            value={mediaUrl}
            onChange={(e) => setMediaUrl(e.target.value)}
            placeholder="https://example.com/image.jpg"
            className="w-full px-3 py-2 bg-zinc-900 border border-zinc-800 rounded text-sm focus:outline-none focus:border-zinc-600"
          />
        </div>

        <LinkInserter onInsert={insertAtCursor} />
        <AIComposer onSelect={(text) => setBody(text)} />

        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-zinc-400 cursor-pointer">
            <input
              type="checkbox"
              checked={showSchedule}
              onChange={(e) => setShowSchedule(e.target.checked)}
              className="accent-white"
            />
            Schedule send
          </label>
        </div>

        {showSchedule && (
          <SchedulePicker value={scheduledAt} onChange={setScheduledAt} />
        )}

        {/* Phone preview */}
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
          <h3 className="text-sm font-medium text-zinc-400 mb-2">Preview</h3>
          <div className="bg-blue-600 text-white px-4 py-2 rounded-2xl rounded-bl-sm max-w-xs text-sm whitespace-pre-wrap">
            {body || 'Your message will appear here...'}
          </div>
        </div>

        <div className="flex gap-3">
          <button
            onClick={() => handleSave(true)}
            disabled={sending || !body.trim() || !listId}
            className="px-6 py-2 bg-white text-black rounded text-sm font-medium hover:bg-zinc-200 disabled:opacity-50"
          >
            {sending ? 'Sending...' : 'Send Now'}
          </button>
          <button
            onClick={() => handleSave(false)}
            disabled={sending || !body.trim() || !listId}
            className="px-6 py-2 bg-zinc-800 text-white rounded text-sm hover:bg-zinc-700 disabled:opacity-50"
          >
            {showSchedule && scheduledAt ? 'Schedule' : 'Save Draft'}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: implement Compose page with AI rephrase, link shortener, and scheduling"
```

---

## Task 19: Subscribers Page

**Files:**
- Modify: `bylxe/client/src/pages/Subscribers.jsx`

- [ ] **Step 1: Implement Subscribers page**

Write `client/src/pages/Subscribers.jsx`:
```jsx
import { useState, useEffect } from 'react';
import api from '../lib/api';

export default function Subscribers() {
  const [subscribers, setSubscribers] = useState([]);
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    const params = filter ? `?status=${filter}` : '';
    const { data } = await api.get(`/subscribers${params}`);
    setSubscribers(data);
    setLoading(false);
  };

  useEffect(() => { load(); }, [filter]);

  const handleDelete = async (id) => {
    await api.delete(`/subscribers/${id}`);
    load();
  };

  const handleExport = () => {
    window.open('/api/subscribers/export', '_blank');
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold">Subscribers</h2>
        <button
          onClick={handleExport}
          className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 rounded text-sm"
        >
          Export CSV
        </button>
      </div>

      <div className="flex gap-2">
        {['', 'active', 'pending', 'opted_out'].map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-3 py-1 rounded text-xs ${
              filter === f ? 'bg-white text-black' : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'
            }`}
          >
            {f || 'All'}
          </button>
        ))}
      </div>

      <div className="bg-zinc-900 border border-zinc-800 rounded-lg">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-zinc-500 border-b border-zinc-800">
              <th className="px-4 py-2">Phone</th>
              <th className="px-4 py-2">Status</th>
              <th className="px-4 py-2">Lists</th>
              <th className="px-4 py-2">Joined</th>
              <th className="px-4 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-zinc-500">Loading...</td></tr>
            ) : subscribers.length === 0 ? (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-zinc-500">No subscribers</td></tr>
            ) : (
              subscribers.map((s) => (
                <tr key={s.id} className="border-b border-zinc-800/50">
                  <td className="px-4 py-2 font-mono">{s.phone}</td>
                  <td className="px-4 py-2">
                    <span className={`px-2 py-0.5 rounded text-xs ${
                      s.status === 'active' ? 'bg-green-900/50 text-green-400' :
                      s.status === 'pending' ? 'bg-yellow-900/50 text-yellow-400' :
                      'bg-red-900/50 text-red-400'
                    }`}>
                      {s.status}
                    </span>
                  </td>
                  <td className="px-4 py-2">
                    {s.lists?.map((sl) => (
                      <span key={sl.listId} className="inline-block bg-zinc-800 px-2 py-0.5 rounded text-xs mr-1">
                        {sl.list.name}
                      </span>
                    ))}
                  </td>
                  <td className="px-4 py-2 text-zinc-400">
                    {new Date(s.createdAt).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-2">
                    <button
                      onClick={() => handleDelete(s.id)}
                      className="text-xs text-red-400 hover:text-red-300"
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add -A
git commit -m "feat: implement Subscribers page with filtering and CSV export"
```

---

## Task 20: Message Logs Page

**Files:**
- Modify: `bylxe/client/src/pages/MessageLogs.jsx`

- [ ] **Step 1: Implement MessageLogs page**

Write `client/src/pages/MessageLogs.jsx`:
```jsx
import { useState, useEffect } from 'react';
import api from '../lib/api';

export default function MessageLogs() {
  const [blasts, setBlasts] = useState([]);
  const [selectedBlast, setSelectedBlast] = useState(null);
  const [logs, setLogs] = useState([]);

  useEffect(() => {
    api.get('/messages').then((r) => setBlasts(r.data));
  }, []);

  const viewLogs = async (blast) => {
    setSelectedBlast(blast);
    const { data } = await api.get(`/messages/${blast.id}/logs`);
    setLogs(data);
  };

  if (selectedBlast) {
    return (
      <div className="space-y-4">
        <button onClick={() => setSelectedBlast(null)} className="text-sm text-zinc-400 hover:text-white">
          &larr; Back to blasts
        </button>
        <h2 className="text-xl font-bold">Delivery Log</h2>
        <p className="text-sm text-zinc-400 max-w-lg truncate">{selectedBlast.body}</p>

        <div className="bg-zinc-900 border border-zinc-800 rounded-lg">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-zinc-500 border-b border-zinc-800">
                <th className="px-4 py-2">Phone</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2">Twilio SID</th>
                <th className="px-4 py-2">Error</th>
                <th className="px-4 py-2">Sent At</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((log) => (
                <tr key={log.id} className="border-b border-zinc-800/50">
                  <td className="px-4 py-2 font-mono">{log.subscriber?.phone}</td>
                  <td className="px-4 py-2">
                    <span className={`px-2 py-0.5 rounded text-xs ${
                      log.status === 'delivered' ? 'bg-green-900/50 text-green-400' :
                      log.status === 'sent' ? 'bg-blue-900/50 text-blue-400' :
                      log.status === 'failed' ? 'bg-red-900/50 text-red-400' :
                      'bg-zinc-800 text-zinc-400'
                    }`}>
                      {log.status}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-zinc-500 font-mono text-xs">{log.twilioSid || '—'}</td>
                  <td className="px-4 py-2 text-red-400 text-xs">{log.errorMessage || '—'}</td>
                  <td className="px-4 py-2 text-zinc-400">{new Date(log.sentAt).toLocaleString()}</td>
                </tr>
              ))}
              {logs.length === 0 && (
                <tr><td colSpan={5} className="px-4 py-8 text-center text-zinc-500">No delivery logs</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-bold">Message Logs</h2>

      <div className="bg-zinc-900 border border-zinc-800 rounded-lg">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-zinc-500 border-b border-zinc-800">
              <th className="px-4 py-2">List</th>
              <th className="px-4 py-2">Message</th>
              <th className="px-4 py-2">Status</th>
              <th className="px-4 py-2">Recipients</th>
              <th className="px-4 py-2">Delivered</th>
              <th className="px-4 py-2">Date</th>
            </tr>
          </thead>
          <tbody>
            {blasts.map((b) => (
              <tr
                key={b.id}
                onClick={() => viewLogs(b)}
                className="border-b border-zinc-800/50 cursor-pointer hover:bg-zinc-800/30"
              >
                <td className="px-4 py-2">{b.list?.name || '—'}</td>
                <td className="px-4 py-2 max-w-xs truncate">{b.body}</td>
                <td className="px-4 py-2">
                  <span className={`px-2 py-0.5 rounded text-xs ${
                    b.status === 'sent' ? 'bg-green-900/50 text-green-400' :
                    b.status === 'scheduled' ? 'bg-blue-900/50 text-blue-400' :
                    b.status === 'failed' ? 'bg-red-900/50 text-red-400' :
                    'bg-zinc-800 text-zinc-400'
                  }`}>
                    {b.status}
                  </span>
                </td>
                <td className="px-4 py-2">{b.recipientCount}</td>
                <td className="px-4 py-2">{b.deliveredCount}</td>
                <td className="px-4 py-2 text-zinc-400">{new Date(b.createdAt).toLocaleDateString()}</td>
              </tr>
            ))}
            {blasts.length === 0 && (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-zinc-500">No blasts yet</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add -A
git commit -m "feat: implement MessageLogs page with drill-down delivery view"
```

---

## Task 21: Links Page

**Files:**
- Modify: `bylxe/client/src/pages/Links.jsx`

- [ ] **Step 1: Implement Links page**

Write `client/src/pages/Links.jsx`:
```jsx
import { useState, useEffect } from 'react';
import api from '../lib/api';

export default function Links() {
  const [links, setLinks] = useState([]);
  const [selectedLink, setSelectedLink] = useState(null);
  const [clicks, setClicks] = useState([]);

  useEffect(() => {
    api.get('/links').then((r) => setLinks(r.data));
  }, []);

  const viewClicks = async (link) => {
    setSelectedLink(link);
    const { data } = await api.get(`/links/${link.id}/clicks`);
    setClicks(data);
  };

  if (selectedLink) {
    return (
      <div className="space-y-4">
        <button onClick={() => setSelectedLink(null)} className="text-sm text-zinc-400 hover:text-white">
          &larr; Back to links
        </button>
        <h2 className="text-xl font-bold">Click Detail</h2>
        <p className="text-sm text-zinc-400">
          <code className="text-green-400">{selectedLink.code}</code> &rarr; {selectedLink.destinationUrl}
        </p>

        <div className="bg-zinc-900 border border-zinc-800 rounded-lg">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-zinc-500 border-b border-zinc-800">
                <th className="px-4 py-2">Subscriber</th>
                <th className="px-4 py-2">User Agent</th>
                <th className="px-4 py-2">Clicked At</th>
              </tr>
            </thead>
            <tbody>
              {clicks.map((c) => (
                <tr key={c.id} className="border-b border-zinc-800/50">
                  <td className="px-4 py-2 font-mono">{c.subscriber?.phone || 'Anonymous'}</td>
                  <td className="px-4 py-2 text-zinc-500 text-xs max-w-xs truncate">{c.userAgent || '—'}</td>
                  <td className="px-4 py-2 text-zinc-400">{new Date(c.clickedAt).toLocaleString()}</td>
                </tr>
              ))}
              {clicks.length === 0 && (
                <tr><td colSpan={3} className="px-4 py-8 text-center text-zinc-500">No clicks yet</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-bold">Short Links</h2>

      <div className="bg-zinc-900 border border-zinc-800 rounded-lg">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-zinc-500 border-b border-zinc-800">
              <th className="px-4 py-2">Code</th>
              <th className="px-4 py-2">Destination</th>
              <th className="px-4 py-2">Blast</th>
              <th className="px-4 py-2">Clicks</th>
              <th className="px-4 py-2">Created</th>
            </tr>
          </thead>
          <tbody>
            {links.map((l) => (
              <tr
                key={l.id}
                onClick={() => viewClicks(l)}
                className="border-b border-zinc-800/50 cursor-pointer hover:bg-zinc-800/30"
              >
                <td className="px-4 py-2 font-mono text-green-400">{l.code}</td>
                <td className="px-4 py-2 max-w-xs truncate">{l.destinationUrl}</td>
                <td className="px-4 py-2 text-zinc-400 max-w-xs truncate">{l.blast?.body || '—'}</td>
                <td className="px-4 py-2">{l._count?.linkClicks || 0}</td>
                <td className="px-4 py-2 text-zinc-400">{new Date(l.createdAt).toLocaleDateString()}</td>
              </tr>
            ))}
            {links.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-zinc-500">No links yet</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add -A
git commit -m "feat: implement Links page with click detail drill-down"
```

---

## Task 22: Keywords Page

**Files:**
- Modify: `bylxe/client/src/pages/Keywords.jsx`

- [ ] **Step 1: Implement Keywords page**

Write `client/src/pages/Keywords.jsx`:
```jsx
import { useState, useEffect } from 'react';
import api from '../lib/api';

export default function Keywords() {
  const [keywords, setKeywords] = useState([]);
  const [newKeyword, setNewKeyword] = useState('');
  const [newListId, setNewListId] = useState('');
  const [newResponse, setNewResponse] = useState('');
  const [lists, setLists] = useState([]);

  const load = async () => {
    const { data } = await api.get('/keywords');
    setKeywords(data);

    // Extract unique lists
    const uniqueLists = [];
    const seen = new Set();
    for (const kw of data) {
      if (!seen.has(kw.list.id)) {
        seen.add(kw.list.id);
        uniqueLists.push(kw.list);
      }
    }
    setLists(uniqueLists);
    if (uniqueLists.length > 0 && !newListId) setNewListId(uniqueLists[0].id);
  };

  useEffect(() => { load(); }, []);

  const handleCreate = async (e) => {
    e.preventDefault();
    if (!newKeyword.trim() || !newListId) return;
    await api.post('/keywords', {
      keyword: newKeyword.toUpperCase(),
      listId: parseInt(newListId),
      responseMessage: newResponse || undefined,
    });
    setNewKeyword('');
    setNewResponse('');
    load();
  };

  const toggleActive = async (kw) => {
    await api.put(`/keywords/${kw.id}`, { active: !kw.active });
    load();
  };

  const handleDelete = async (id) => {
    await api.delete(`/keywords/${id}`);
    load();
  };

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-bold">Keywords</h2>

      <form onSubmit={handleCreate} className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 space-y-3">
        <h3 className="text-sm font-medium text-zinc-400">Add Keyword</h3>
        <div className="flex gap-3">
          <input
            type="text"
            value={newKeyword}
            onChange={(e) => setNewKeyword(e.target.value)}
            placeholder="KEYWORD"
            className="px-3 py-2 bg-zinc-800 border border-zinc-700 rounded text-sm w-32 uppercase focus:outline-none focus:border-zinc-500"
          />
          <select
            value={newListId}
            onChange={(e) => setNewListId(e.target.value)}
            className="px-3 py-2 bg-zinc-800 border border-zinc-700 rounded text-sm focus:outline-none focus:border-zinc-500"
          >
            {lists.map((l) => (
              <option key={l.id} value={l.id}>{l.name}</option>
            ))}
          </select>
          <input
            type="text"
            value={newResponse}
            onChange={(e) => setNewResponse(e.target.value)}
            placeholder="Custom reply (optional)"
            className="flex-1 px-3 py-2 bg-zinc-800 border border-zinc-700 rounded text-sm focus:outline-none focus:border-zinc-500"
          />
          <button type="submit" className="px-4 py-2 bg-white text-black rounded text-sm font-medium">
            Add
          </button>
        </div>
      </form>

      <div className="bg-zinc-900 border border-zinc-800 rounded-lg">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-zinc-500 border-b border-zinc-800">
              <th className="px-4 py-2">Keyword</th>
              <th className="px-4 py-2">List</th>
              <th className="px-4 py-2">Auto-Reply</th>
              <th className="px-4 py-2">Active</th>
              <th className="px-4 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {keywords.map((kw) => (
              <tr key={kw.id} className="border-b border-zinc-800/50">
                <td className="px-4 py-2 font-mono font-bold">{kw.keyword}</td>
                <td className="px-4 py-2">{kw.list?.name}</td>
                <td className="px-4 py-2 text-zinc-400 max-w-xs truncate">{kw.responseMessage || '(uses list welcome)'}</td>
                <td className="px-4 py-2">
                  <button
                    onClick={() => toggleActive(kw)}
                    className={`px-2 py-0.5 rounded text-xs ${
                      kw.active ? 'bg-green-900/50 text-green-400' : 'bg-zinc-800 text-zinc-500'
                    }`}
                  >
                    {kw.active ? 'Active' : 'Inactive'}
                  </button>
                </td>
                <td className="px-4 py-2">
                  <button
                    onClick={() => handleDelete(kw.id)}
                    className="text-xs text-red-400 hover:text-red-300"
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
            {keywords.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-zinc-500">No keywords</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add -A
git commit -m "feat: implement Keywords page with CRUD"
```

---

## Task 23: Settings Page

**Files:**
- Modify: `bylxe/client/src/pages/Settings.jsx`

- [ ] **Step 1: Implement Settings page**

Write `client/src/pages/Settings.jsx`:
```jsx
import { useState, useEffect } from 'react';
import api from '../lib/api';

const PROVIDERS = [
  { value: 'openai', label: 'OpenAI' },
  { value: 'gemini', label: 'Google Gemini' },
  { value: 'claude', label: 'Anthropic Claude' },
];

export default function Settings() {
  const [provider, setProvider] = useState('openai');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    api.get('/settings').then((r) => {
      const s = r.data;
      if (s.ai_provider) setProvider(s.ai_provider);
      if (s.ai_api_key) setApiKey(s.ai_api_key);
      if (s.ai_model) setModel(s.ai_model);
    });
  }, []);

  const handleSave = async (e) => {
    e.preventDefault();
    setSaving(true);
    setMessage('');

    const payload = { ai_provider: provider, ai_model: model };
    // Only send api_key if the user typed a new one (not the masked version)
    if (apiKey && !apiKey.startsWith('****')) {
      payload.ai_api_key = apiKey;
    }

    try {
      await api.put('/settings', payload);
      setMessage('Settings saved');
    } catch {
      setMessage('Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  const defaultModel = {
    openai: 'gpt-4o',
    gemini: 'gemini-2.0-flash',
    claude: 'claude-sonnet-4-20250514',
  };

  return (
    <div className="max-w-lg space-y-6">
      <h2 className="text-xl font-bold">Settings</h2>

      {message && (
        <div className="bg-zinc-800 border border-zinc-700 px-4 py-2 rounded text-sm">{message}</div>
      )}

      <form onSubmit={handleSave} className="bg-zinc-900 border border-zinc-800 rounded-lg p-6 space-y-4">
        <h3 className="text-sm font-medium text-zinc-400">AI Provider Configuration</h3>

        <div>
          <label className="block text-sm text-zinc-400 mb-1">Provider</label>
          <select
            value={provider}
            onChange={(e) => {
              setProvider(e.target.value);
              setModel(defaultModel[e.target.value] || '');
            }}
            className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded text-sm focus:outline-none focus:border-zinc-500"
          >
            {PROVIDERS.map((p) => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-sm text-zinc-400 mb-1">API Key</label>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="Enter API key..."
            className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded text-sm focus:outline-none focus:border-zinc-500"
          />
          <p className="text-xs text-zinc-500 mt-1">Stored encrypted. Leave unchanged to keep current key.</p>
        </div>

        <div>
          <label className="block text-sm text-zinc-400 mb-1">Model</label>
          <input
            type="text"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder={defaultModel[provider]}
            className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded text-sm focus:outline-none focus:border-zinc-500"
          />
        </div>

        <button
          type="submit"
          disabled={saving}
          className="px-6 py-2 bg-white text-black rounded text-sm font-medium hover:bg-zinc-200 disabled:opacity-50"
        >
          {saving ? 'Saving...' : 'Save Settings'}
        </button>
      </form>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add -A
git commit -m "feat: implement Settings page for AI provider configuration"
```

---

## Task 24: Build & Integration Test

- [ ] **Step 1: Run all server tests**

```bash
npx vitest run
```

Expected: All tests pass.

- [ ] **Step 2: Build client**

```bash
cd client && npm run build && cd ..
```

Expected: Build succeeds.

- [ ] **Step 3: Test full app startup**

```bash
NODE_ENV=production node server/index.js
```

Expected: Server starts on port 3001, serves React app at `/`, scheduler running.

- [ ] **Step 4: Commit any final fixes**

```bash
git add -A
git commit -m "chore: verify full build and integration"
```

---

## Task 25: Deployment Configuration

**Files:**
- Create: `bylxe/ecosystem.config.js`
- Create: `bylxe/Caddyfile`

- [ ] **Step 1: Create PM2 config**

Write `ecosystem.config.js`:
```javascript
module.exports = {
  apps: [{
    name: 'bylxe',
    script: 'server/index.js',
    env_production: {
      NODE_ENV: 'production',
      PORT: 3001,
    },
    error_file: 'logs/err.log',
    out_file: 'logs/out.log',
    time: true,
    max_restarts: 10,
    restart_delay: 5000,
  }],
};
```

- [ ] **Step 2: Create Caddyfile**

Write `Caddyfile`:
```
bylxe.co {
    @shortlink path_regexp ^/[a-zA-Z0-9]{4,8}$
    handle @shortlink {
        reverse_proxy localhost:3001
    }
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

- [ ] **Step 3: Create logs directory**

```bash
mkdir -p logs
echo "logs/*.log" >> .gitignore
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: add PM2 and Caddy deployment configuration"
```

---

## Deployment Steps (Manual — on Windows VPS)

After all tasks are complete, deploy by:

1. Clone/copy the `bylxe/` directory to the VPS
2. Copy `.env.example` to `.env` and fill in production values
3. Create PostgreSQL database: `CREATE DATABASE bylxe;`
4. Install dependencies: `npm install && cd client && npm install && cd ..`
5. Run migrations: `npx prisma migrate deploy`
6. Seed database: `node prisma/seed.js`
7. Build frontend: `cd client && npm run build && cd ..`
8. Create first admin: `curl -X POST http://localhost:3001/api/auth/register -H "Content-Type: application/json" -d '{"name":"Admin","email":"you@email.com","password":"your-password"}'`
9. Start with PM2: `pm2 start ecosystem.config.js --env production && pm2 save`
10. Copy `Caddyfile` to Caddy config location and restart Caddy
11. Configure DNS: A records for `bylxe.co` and `sms.luxesenseedit.com` pointing to VPS IP
12. Configure Twilio webhook URLs: `https://sms.luxesenseedit.com/webhook/sms` and `https://sms.luxesenseedit.com/webhook/status`
