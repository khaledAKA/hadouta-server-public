---
name: hadouta-dev
description: Development guide for hadouta-server-public - Node/Express/TypeScript story generation platform. Use when adding features, creating routes, modifying schema, adding storage methods, integrating AI, handling subscriptions, or extending PDF/image generation. Covers architecture, patterns, and checklist matching current codebase conventions.
allowed-tools: Read, Grep, Glob, Bash, Edit, Write
---

# Hadouta Server - Feature Development Guide

## Overview
Hadouta is a multilingual AI story-generation SaaS with tiered subscriptions (free/pro/ultimate). Stack: **Express + TypeScript (ESM) + Drizzle ORM (PG) + Supabase (Auth + Storage) + OpenAI (gpt-4o, gpt-image-1) + Stripe + Puppeteer**.

Entry point `index.ts`:
- CORS enabled (`CLIENT_URL` or localhost:3000)
- Raw body only for `/api/stripe-webhook`, JSON 10mb elsewhere
- Request logging middleware truncates at 80 chars
- Calls `registerRoutes()` then `scheduledDeletionService.start()`
- Prod: builds client via spawn npm, proxies non-/api to localhost:3000

## Core Architecture

### 1. Route Aggregation (`routes.ts`)
```ts
export async function registerRoutes(app): Promise<Server> {
  await setupAuth(app);           // supabaseAuth.ts - adds session + auth endpoints
  registerWebhookRoutes(app);     // Stripe webhooks
  registerStoryRoutes(app);       // Story CRUD + generation
  registerSubscriptionRoutes(app); // Stripe checkout
}
```
**BUG NOTE:** `registerSubscriptionRoutes` is called twice — keep idempotency in new route registrars.

To add new domain: create `routes/<domain>.ts` with `export function registerXRoutes(app: Express)` and add call in `routes.ts`.

### 2. Folder Structure
```
index.ts                # Express app + server start
routes.ts               # Route aggregator
config.ts               # Stripe keys + env mode (test/live)
db.ts                   # PG Pool + drizzle instance
drizzle.config.ts       # Drizzle kit config
storage.ts              # DatabaseStorage class + IStorage interface (app DB)
shared/schema.ts        # Drizzle tables + Zod types
openaiAPI.ts            # generateStory() + illustration generation
openai/openai-helper.ts # CATEGORY_SYSTEMS by ageRange (children/teen/adult)
image-storage.ts        # Supabase Storage bucket 'hadouta' + sharp compression
pdf-generator.ts        # Puppeteer PDF export, RTL/CJK font handling
routes/
  supabaseAuth.ts       # Auth, session, rate limiters, user deletion scheduling
  story.ts              # Main story logic
  subscription.ts       # Pro/Ultimate checkout + manage
  stripeWebhook.ts      # invoice.paid, checkout.session.completed, etc.
services/
  scheduledDeletionService.ts # cron daily at midnight, deletes after 14 days
scripts/                # setup-storage, setup-pending-deletions-table, etc.
migrations/
tests/
```

### 3. Database Schema (`shared/schema.ts`)
Tables:
- `sessions` (Replit Auth compat, even though Supabase used)
- `users`: id PK (supabase auth id), email, firstName/lastName, stripeCustomerId, stripeSubscriptionId, subscriptionExpireAt, subscriptionStatus, isPremium bool, subscriptionTier enum free/pro/ultimate, storiesGenerated (lifetime), monthlyStoriesGenerated, timestamps
- `pendingUserDeletions`: id serial, userId unique, scheduledFor, createdAt + indexes
- `stories`: id serial PK, userId FK cascade, title, content, category varchar, language varchar default en-us (30+ locales), ageRange children/teen/adult, size short/medium/long, fontFamily serif/sans-serif/monospace/cursive/fantasy, characters jsonb, illustrations jsonb URLs, excerpt, coverUrl, previousId serial (for sequels), timestamps
- `storyTemplates`: same as stories but no userId, for template library

Zod extensions:
- `characterSchema`: name 1-10 chars, photo optional string (base64)
- `insertStorySchema`: extends drizzle-zod, overrides characters array min1 max5, category enum 12 values, size, language enum (must keep sync with routes), ageRange, fontFamily optional, customTitle max50, customDescription max100, coverUrl optional
- Exported Types: User, UpsertUser, Story, StoryTemplate, InsertStory, Character, Category, AgeRange, Language, Size, FontFamily

### 4. Storage Layer (`storage.ts`)
Interface `IStorage` + `DatabaseStorage` singleton `storage`.

Pattern for new entity:
1. Add type definitions for pagination if needed:
```ts
export interface XxxPaginationOptions { page, limit, offset, category? }
export interface XxxPaginationResult { xxx, total }
```
2. Add to IStorage interface: `getX(id): Promise<X | undefined>`, `createX`, `deleteX`, etc.
3. Implement in DatabaseStorage using `db.select().from(table).where(eq(...))`, `and()`, `desc()`, `sql<number>count(*)`.
4. Use `returning()` for insert/update/delete check (length >0).
5. For limits: see `checkUserStoryLimit()` - free 3 lifetime, pro 50 monthly, ultimate 100 monthly.
6. For counter increments: `storiesGenerated: sql\`\${users.storiesGenerated} + 1\``.

### 5. Auth Pattern (`routes/supabaseAuth.ts`)
- Supabase client: `createClient(SUPABASE_URL, SUPABASE_ANON_KEY)` exported as `supabaseAdmin`
- Session store: `connect-pg-simple` with `sessions` table, TTL 1 week, httpOnly, secure if prod
- Env validation via Zod (SUPABASE_URL url, ANON_KEY, DATABASE_URL, SESSION_SECRET, TURNSTILE_SECRET optional)
- Rate limiters: login 7/15m, signup 10/1h, general 100/15m, resetPassword 5/15m
- Turnstile verification: POST to cloudflare challenges.siteverify
- Endpoints all follow:
```ts
const authHeader = req.headers.authorization;
if (!authHeader?.startsWith('Bearer ')) return 401;
const token = authHeader.split(' ')[1];
const { data: userData, error } = await supabaseAdmin.auth.getUser(token);
if (error || !userData.user) return 401;
const userId = userData.user.id;
```
- Upsert user after signup via `storage.upsertUser()`
- Deletion scheduling: DELETE /api/delete-account schedules +14 days via `storage.scheduleUserDeletion()`, login cancels pending deletion

**When adding protected route:** copy auth header extraction + supabase getUser pattern, use `generalLimiter` or custom limiter.

### 6. Story Route Pattern (`routes/story.ts`)
Critical patterns to replicate:

**Rate limiting:**
```ts
const storyGenerationLimiter = rateLimit({ windowMs: 15*60*1000, max: 50, message: {...} });
```

**Zod validation + custom photo validator:**
- `validatePhotoSize`: checks base64 size <=2MB, http URLs pass (deferred to storage)
- `photoValidator = z.string().refine(validatePhotoSize, {message})`
- Main schema `storyGenerationSchema` parses body, then manual loop validates each photo again returning 400 if fails.

**Plan enforcement (copy this structure for any tiered feature):**
- Check `storage.checkUserStoryLimit(userId)` first, return 403 with `requiresUpgrade`
- Free tier enforcements: size short only, language en-*, characters.length 1 max, no photo, freeCategories = first 5, fontFamily serif only -> override `validatedData.fontFamily='serif'`
- Pro tier: characters max 5, but `subscriptionTier === 'pro'` photo NOT allowed
- Ultimate only: `addIllustrations` requires ultimate, also `generate-from-template` and `generate-story-sequel` require ultimate.

**Async generation pattern (fire-and-forget):**
- Create placeholder story with "Your story is being generated..." + increment count
- Call async function without await: `generateStoryAsync(story, validatedData)` or `generateStorySequelAsync(orig, story)`
- In async: try `generateStory()` from openaiAPI.ts, catch -> `deleteStory()` and return
- Second try: `downloadAndStoreImages(result.illustrations, story.id)`, cover image, then `updateStoryAfterGenerated(id, title, content, illustrations, coverUrl)`, catch -> deleteStory

**Pagination pattern:**
```ts
const page = parseInt(req.query.page) || 1;
const limit = parseInt(req.query.limit) || 9;
const category = req.query.category as string || 'all';
if (isNaN(page) || page<1) return 400;
if (isNaN(limit) || limit<1 || limit>100) return 400;
if (category!=='all') validate against validCategories list;
const offset = (page-1)*limit;
const result = await storage.getUserStoriesWithPagination(userId, {page, limit, offset, category: category==='all'?undefined:category});
res.json({stories: result.stories, total, page, limit, totalPages: ceil(total/limit), hasNext: page*limit < total, hasPrev: page>1});
```

**Delete pattern:** Delete DB then `await deleteStoryImages(storyId)` from image-storage.

### 7. OpenAI Integration (`openaiAPI.ts`)
- `generateStory(characters, category, ageRange, language, size, customTitle?, customDescription?, addIllustrations, originalStory?)`
- Builds system prompt from: `getCategorySystemPrompts(ageRange)` (random pick from CATEGORIES array) + `AGE_SYSTEMS[ageRange]` + `LANGUAGE_CONTEXTS[language]` + `STORY_LENGTHS[size]` (short 300-500 words 3 sections, medium 1000-1500 5 sections, long 2500-4000 7 sections)
- IMAGE_PLACEHOLDER logic: if addIllustrations, inject "(image_placeholder)" instruction in system message
- Uses `gpt-4o`, json_object response_format, temperature 0.8, max_tokens size-dependent
- Normalizes Unicode NFC for names/title
- Post-generation: if addIllustrations, calls `generateIllustrations(content, characters, ageRange)` -> splits by "(image_placeholder)", loops scenes, builds prompt with `AGE_RANGE_IMAGE_STYLES[ageRange]` + character names, calls `gpt-image-1` size 1024x1024 quality low, returns b64_json array
- Cover: `generateCoverImage(title, content, ageRange)` similar

**Adding new AI feature:** follow same prompt composition pattern, use helper file for system prompts by age/category.

### 8. Image Storage (`image-storage.ts`)
- Supabase Storage bucket `hadouta`
- `compressImage(base64)`: strip data URL prefix, sharp resize 800x600 inside withoutEnlargement, jpeg quality 80 progressive mozjpeg, if >512KB retry 600x450 q60, if still >512KB 400x300 q40, fallback original buffer on error
- `StoreImage(base64, storyId, index)`: filename `crypto.randomUUID()_Date.now().jpg`, path `${storyId}/${filename}`, compress then `supabase.storage.from(bucket).upload(path, buffer, {contentType:'image/jpeg', upsert:true})`, get publicUrl
- `downloadAndStoreImages(b64Array, storyId)`: sequential loop calling StoreImage
- `deleteStoryImages(storyId)`: list `${storyId}` folder, remove all paths
- `initializeStorageBucket()`: create bucket if not exists public true 10MB limit

**Adding new storage type:** duplicate compress + upload pattern, keep sequential for large batches to avoid rate limits.

### 9. PDF Generator (`pdf-generator.ts` - NEW)
- Constants: RTL_LANGUAGES = ar-*, CJK = zh-*, ja-*, ko-*
- `FONT_FAMILY_MAP`: maps serif/sans-serif/monospace/cursive/fantasy to Noto families
- `isRtlLanguage()`, `isCjkLanguage()`, `getFontStack(fontFamily, language)`: adds Noto Naskh Arabic for RTL, Noto Serif CJK variants for CJK
- `escapeHtml(text)` -> basic entity encode
- `buildStoryHtml(story)`: dir ltr/rtl, fontStack, langAttr split('-')[0], title escaped, content escaped + \n-><br>, @page margin 2cm A4, body styles direction/text-align based on RTL
- `generateStoryPdf(story)`: `puppeteer.launch({headless:true, args:['--no-sandbox','--disable-setuid-sandbox']})`, newPage setContent html waitUntil networkidle0, `page.pdf({format:'A4', printBackground:true, margin 2cm})`, Buffer.from, finally browser.close()

**When extending PDF:** keep RTL/CJK handling, add TOC/cover pages in HTML template, ensure escaping.

### 10. Subscription & Stripe (`routes/subscription.ts` + `routes/stripeWebhook.ts` + `config.ts`)
- `config.ts`: loads STRIPE_MODE test/live, `getStripeKeys()` returns public/secret/webhookSecret based on mode, validates secret exists, exports `stripeConfig` with proPriceId & ultimatePriceId from env
- Rate limiter: subscriptionLimiter 20/15m
- Endpoints:
  - POST `/api/create-pro-subscription`: auth, get user, create Stripe customer if !stripeCustomerId (email + metadata userId), store via `updateUserStripeInfo`, create checkout.session customer:customerId client_reference_id:userId payment_method_types card allow_promotion_codes line_items price_data currency usd product_data name/description unit_amount 699 recurring month, mode subscription, success/cancel urls hadouta.app, metadata userId plan, return url
  - POST `/api/create-ultimate-subscription`: same 1499 amount
  - POST `/api/manage-subscription`: body action downgrade/cancel, if downgrade list customer active subscriptions and cancel each, if cancel update specific subscription cancel_at_period_end true
- Webhook `POST /api/stripe-webhook`: raw body required (handled in index.ts), verify sig `stripe.webhooks.constructEvent(req.body, sig, webhookSecret)`, cases:
  - invoice.paid: customer, expireAt = created+30days, subtotal check 1499=>ultimate 699=>pro => `updateUserSubscriptionInfoAfterPaymentSucceeded`
  - checkout.session.async_payment_succeeded & checkout.session.completed: client_reference_id, plan metadata, subscription, paid check => `updateUserSubscriptionInfoAfterCheckoutCompleted`
  - customer.subscription.updated: if active && cancel_at_period_end => `updateUserSubscriptionStatusAfterCanceled`
  - customer.subscription.deleted: => `updateUserSubscriptionInfoDeletingSubscription` (free)
  - invoice.overdue: list active subs and cancel

**Adding new monetized feature:** add tier check in route (like `if (user.subscriptionTier !== 'ultimate') return 400`), add webhook handling if new price, add env price IDs.

### 11. Services (`services/scheduledDeletionService.ts`)
- Uses `node-cron`, schedule `'0 0 * * *'` (midnight daily) + immediate on start
- `processPendingDeletions()`: getPendingDeletions(), if scheduledFor <= now => deleteUser()
- `deleteUser(userId)`: storage.deleteStories, storage.deleteUser, storage.deletePendingDeletion, supabase admin deleteUser
- Methods: `hasPendingDeletion()`, `cancelUserDeletion()`
- Started in `index.ts` via `scheduledDeletionService.start()`

**Adding new cron job:** either extend this service or create new service file with same pattern, import & start in index.ts.

### 12. Config & Env
Required env (see db.ts, supabaseAuth.ts, openaiAPI.ts):
- DATABASE_URL, SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, SESSION_SECRET, OPENAI_API_KEY, TURNSTILE_SECRET_KEY optional, STRIPE_* keys (TEST/LIVE), CLIENT_URL, PORT
Load via dotenv in db.ts and image-storage.ts.

### 13. Testing & Scripts
- `npm run dev`: NODE_ENV=development tsx index.ts
- `npm run build`: esbuild index.ts platform node external bundle esm outdir dist
- `npm test`: vitest run
- Scripts: `setup-storage.ts` -> initializeStorageBucket(), `setup-pending-deletions-table`, `create-sessions-table`
- Tests in `tests/`

## How to Add a New Feature - Step-by-Step Checklist

### Example: Adding "Favorites" or "Collections"

1. **Schema First (`shared/schema.ts`)**
   ```ts
   export const favorites = pgTable("favorites", {
     id: serial("id").primaryKey(),
     userId: varchar("user_id").notNull().references(() => users.id, {onDelete:"cascade"}),
     storyId: integer("story_id").notNull().references(() => stories.id, {onDelete:"cascade"}),
     createdAt: timestamp("created_at").defaultNow(),
   });
   export type Favorite = typeof favorites.$inferSelect;
   ```
   Add zod validation if needed, export types.

2. **DB Migration**
   - `npm run db:push` (drizzle-kit) OR create SQL in `migrations/`
   - Run setup script if needed.

3. **Storage Layer (`storage.ts`)**
   ```ts
   // Types
   export interface FavoriteResult { favorites: Favorite[]; total: number }
   // Interface
   addFavorite(userId: string, storyId: number): Promise<Favorite>;
   removeFavorite(userId: string, storyId: number): Promise<boolean>;
   getUserFavorites(userId: string, options: StoriesPaginationOptions): Promise<FavoriteResult>;
   // Implementation
   async addFavorite(...) { const [fav]=await db.insert(favorites).values({userId, storyId}).returning(); return fav; }
   ```

4. **Service (if complex logic, else skip)**
   Create `services/favoriteService.ts` for business rules (e.g., limit per tier).

5. **Route (`routes/favorite.ts`)**
   ```ts
   import type { Express } from "express";
   import rateLimit from 'express-rate-limit';
   import { generalLimiter, supabaseAdmin } from "./supabaseAuth";
   import { storage } from "../storage";
   import { z } from "zod";

   const favoriteLimiter = rateLimit({windowMs:15*60*1000, max:50, message:{error:'Too many fav...'}});
   const favoriteSchema = z.object({storyId: z.number()});

   export function registerFavoriteRoutes(app: Express) {
     app.post("/api/favorites", favoriteLimiter, async (req:any,res)=>{
       // 1. Auth check (copy pattern)
       const authHeader=req.headers.authorization;
       if(!authHeader?.startsWith('Bearer ')) return res.status(401).json({error:"No token"});
       const token=authHeader.split(' ')[1];
       const {data:userData, error}=await supabaseAdmin.auth.getUser(token);
       if(error||!userData.user) return res.status(401).json({error:"Invalid token"});
       const userId=userData.user.id;
       // 2. Tier check if needed
       // const user=await storage.getUser(userId); if(!user.isPremium) return 403...
       // 3. Zod parse
       try{
         const {storyId}=favoriteSchema.parse(req.body);
         // 4. Business logic via storage
         const fav=await storage.addFavorite(userId, storyId);
         res.json(fav);
       } catch(e:any){
         if(e.name==="ZodError") return res.status(400).json({message:"Invalid data", errors:e.errors});
         console.error("Add favorite error:", e);
         res.status(500).json({message:"Failed..."});
       }
     });

     app.get("/api/favorites", generalLimiter, async (req,res)=>{ /* pagination pattern */ });
     app.delete("/api/favorites/:id", generalLimiter, async (req,res)=>{ /* id parse NaN check, storage call */ });
   }
   ```

6. **Register in `routes.ts`**
   ```ts
   import { registerFavoriteRoutes } from "./routes/favorite";
   export async function registerRoutes(app){
     await setupAuth(app);
     registerWebhookRoutes(app);
     registerStoryRoutes(app);
     registerSubscriptionRoutes(app);
     registerFavoriteRoutes(app); // NEW
     ...
   }
   ```

7. **Plan Enforcement (if premium feature)**
   Mirror story.ts:
   - Free check: `if(!user.isPremium) return 403 with requiresUpgrade:true`
   - Tier specifics: `if(user.subscriptionTier!=='ultimate') return 400`
   - Limits: use `checkUserStoryLimit` style method

8. **Validation & Error Handling**
   - Always Zod schema for body/query
   - Specific error messages for timeout/quota/validation/network/limit like story.ts does
   - Log via console.error with context
   - Return dev error details only if `NODE_ENV==='development'`

9. **Rate Limiting**
   - Define limiter per feature (story:50/15m, subscriptions:20/15m, general:100/15m)
   - Choose appropriate max based on cost (AI=low max, read=high max)

10. **If Feature Needs Images/PDF**
    - Images: use `compressImage` + `StoreImage` + `deleteStoryImages` pattern
    - PDF: extend `pdf-generator.ts` - keep RTL/CJK, escapeHtml, Puppeteer pattern

11. **If Async Processing Needed**
    Use fire-and-forget like story generation:
    ```ts
    const job = await storage.createJob({status:'pending'});
    processJobAsync(job); // no await
    res.json(job);
    async function processJobAsync(job){ try{ /* openai */ await storage.updateJob(...) } catch{ await storage.deleteJob(...) } }
    ```

12. **Tests**
    - Add in `tests/` using vitest
    - Mock storage/openai where needed

13. **Env & Docs**
    - Add new env keys to `supabaseAuth.ts` envSchema or config.ts validation
    - Update render.yaml if needed
    - Document endpoint in skill's changelog

## Conventions & Gotchas

- **Auth**: Never trust req.user, always extract Bearer token and verify via supabaseAdmin.auth.getUser
- **ID Parsing**: Always `parseInt(req.params.id)` + `isNaN` check -> 400
- **Zod**: Parse, catch ZodError -> 400 with errors array
- **Premium Flow**: isPremium bool + subscriptionTier string; check both; tier free/pro/ultimate
- **Idempotency**: Route registrars should be safe to call twice (current bug in routes.ts) - avoid app.post duplicate registration without guard
- **Image Photos**: base64 up to 2MB, compressed to ~512KB via sharp, http URLs allowed but storage handles compression
- **Language Codes**: Use full locale (en-us not en), 30+ locales in schema enum; when adding new language update: shared/schema.ts enum, LANGUAGE_CONTEXTS in openaiAPI.ts, storyGenerationSchema in routes/story.ts, validCategories if needed, getFontStack in pdf-generator.ts if RTL/CJK
- **Category**: 12 values; free users only first 5
- **CORS**: origin from env CLIENT_URL
- **Stripe**: Always store customerId immediately, use client_reference_id for userId recovery, webhook needs raw body
- **Timestamps**: Use `defaultNow()` in schema, `desc(createdAt)` for ordering
- **Error Codes**: 401 auth, 403 limits/tier, 400 validation, 408 timeout, 429 quota, 503 network, 500 generic
- **Logging**: Short log line (80 chars truncated) for API routes via middleware in index.ts
- **Module System**: `"type":"module"` in package.json, use `import` + `.js` extensions not needed because tsx, but `fileURLToPath` for __dirname

## Common Extension Ideas Mapping

- **PDF enhancements**: Edit `pdf-generator.ts` buildStoryHtml - keep existing RTL/CJK, add sections for TOC, illustrations `<img src="${escapeHtml(url)}">`, cover page
- **New story type / sequel logic**: Extend `openaiAPI.ts` generateStory with new param, add new system prompt in `openai-helper.ts` per ageRange
- **Sharing / public stories**: Add `isPublic` bool to stories table, new endpoint GET `/api/public-stories` with no auth but rate limit, storage method with where `isPublic`
- **Collections/Folders**: New table `collections` + `collection_stories` join, CRUD routes
- **User preferences**: Add columns to users table (e.g., preferredLanguage, fontFamily)
- **Admin endpoints**: Check user email list or new `isAdmin` column, add middleware
- **Webhooks**: New table `webhook_events` for idempotency if adding more Stripe events

## Verification Checklist Before PR

- [ ] Schema enum updates synced across schema.ts + route zod + openai LANGUAGE_CONTEXTS + pdf font map
- [ ] Storage interface + impl added, uses eq/and/desc/sql patterns
- [ ] Route file exports registerXRoutes, auth + rate limiter + zod + tier checks present
- [ ] Registered in routes.ts
- [ ] Handles isNaN id, ZodError, try/catch with specific status codes
- [ ] No secrets logged, error details only in dev
- [ ] `npm run check` (tsc --noEmit) passes
- [ ] `npm test` passes
- [ ] Manual test: login -> get token -> call new endpoint with Bearer token

## Path References (absolute for edits)

- Core aggregator: `routes.ts`
- Auth + limiters: `routes/supabaseAuth.ts`
- Story logic reference: `routes/story.ts`
- Subscription reference: `routes/subscription.ts`
- Webhook reference: `routes/stripeWebhook.ts`
- Storage: `storage.ts`
- Schema: `shared/schema.ts`
- OpenAI: `openaiAPI.ts` + `openai/openai-helper.ts`
- Images: `image-storage.ts`
- PDF: `pdf-generator.ts`
- Config: `config.ts`
- Services: `services/scheduledDeletionService.ts`
- Entry: `index.ts`
