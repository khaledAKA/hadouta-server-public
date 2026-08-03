---
name: hadouta-audible-stories
description: Guide for adding audible / TTS listen-to-story feature to hadouta-server. Covers schema extension, audio storage, OpenAI TTS integration, async generation pipeline, tier gating, and player endpoints matching current architecture (Express + Drizzle + Supabase + OpenAI). Use when adding audio, TTS, voice, listen, narration, speech features.
allowed-tools: Read, Grep, Glob, Bash, Edit, Write
---

# Hadouta Audible Stories - Feature Implementation Skill

This skill describes how to add **"Listen to Story"** - TTS audio generation after story creation, so users can listen instead of reading.

It aligns with existing patterns: `openaiAPI.ts` async generation, `image-storage.ts` Supabase bucket pattern, `routes/story.ts` tier checks & pagination, `storage.ts` interface, `shared/schema.ts` jsonb fields, and `pdf-generator.ts` output extension pattern.

## Current Story Flow (To Extend)

```
POST /api/generate-story
  -> auth + checkUserStoryLimit + plan enforcement
  -> compress characters photos (sharp)
  -> storage.createStory({title: "Your story is being generated...", content: "Come back later..."})
  -> generateStoryAsync(story, validatedData) [fire-and-forget, no await]
       -> generateStory() [openai gpt-4o]
       -> downloadAndStoreImages()
       -> storage.updateStoryAfterGenerated()

GET /api/stories/:id returns Story with content
```

**Goal Audible Flow:**

```
After story content ready, also allow:
POST /api/stories/:id/audio (generate)
  -> creates audioStatus = generating, job fire-and-forget
  -> splits content into chunks, calls OpenAI TTS (or ElevenLabs), concatenates mp3, uploads to Supabase Storage
  -> updates story.audioUrl + audioStatus = ready + audioDuration + audioVoice

GET /api/stories/:id/audio (stream or redirect to public URL)
DELETE /api/stories/:id/audio
Auto-generation option: after generateStoryAsync completes, auto-trigger audio if user preference or query param ?withAudio=true
```

## 1. Schema Changes (`shared/schema.ts`)

### Option A: Add columns to `stories` (simplest, matches pdf-generator pattern no table change)

```ts
export const stories = pgTable("stories", {
  // ... existing
  audioUrl: varchar("audio_url"), // public Supabase URL
  audioStatus: varchar("audio_status").default("none"), // none | generating | ready | failed
  audioDuration: integer("audio_duration"), // seconds
  audioVoice: varchar("audio_voice"), // alloy, nova, etc.
  audioLanguage: varchar("audio_language"), // denormalized from story.language for faster filter
  audioGeneratedAt: timestamp("audio_generated_at"),
});
```

### Option B: Separate table for multiple narrations (if you want multiple voices per story later)

```ts
export const storyAudios = pgTable("story_audios", {
  id: serial("id").primaryKey(),
  storyId: integer("story_id").notNull().references(() => stories.id, {onDelete: "cascade"}),
  userId: varchar("user_id").notNull().references(() => users.id, {onDelete: "cascade"}),
  audioUrl: varchar("audio_url").notNull(),
  status: varchar("status").notNull().default("generating"), // generating | ready | failed
  voice: varchar("voice").notNull().default("alloy"),
  duration: integer("duration"),
  language: varchar("language").notNull(),
  fileSize: integer("file_size"), // bytes
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  index("IDX_story_audios_story_id").on(table.storyId),
  index("IDX_story_audios_user_id").on(table.userId),
  index("IDX_story_audios_status").on(table.status),
]);

export type StoryAudio = typeof storyAudios.$inferSelect;
export type InsertStoryAudio = typeof storyAudios.$inferInsert;
```

**Recommendation:** Start with Option A for MVP, migrate to B if you need voice variants. This skill documents both; pick one.

Add to Zod if needed:
```ts
export const audioVoiceSchema = z.enum(["alloy","echo","fable","onyx","nova","shimmer"]);
```

Update `Language` handling: keep same enum as story.

## 2. Storage Bucket (`image-storage.ts` -> `audio-storage.ts`)

Create new file `audio-storage.ts` mirroring `image-storage.ts` pattern but for audio/mp3.

**Bucket strategy:**
- Create new bucket `hadouta-audio` (separate from `hadouta` images) for policies/lifecycle, or reuse same bucket with `audio/` prefix. Separate is cleaner.
- Supabase storage limits: set fileSizeLimit 50MB (audio), allowedMimeTypes audio/mpeg, audio/mp3, audio/wav

**Implement:**

```ts
// audio-storage.ts
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();
const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY!;
const supabase = createClient(supabaseUrl, supabaseServiceKey);
const AUDIO_BUCKET = 'hadouta-audio';

export async function storeAudioBuffer(buffer: Buffer, storyId: number, voice: string): Promise<string> {
  const filename = `${crypto.randomUUID()}_${Date.now()}.mp3`;
  const filePath = `${storyId}/${filename}`;
  const { error } = await supabase.storage.from(AUDIO_BUCKET).upload(filePath, buffer, {
    contentType: 'audio/mpeg',
    upsert: true,
    cacheControl: '3600'
  });
  if (error) throw new Error(`Audio upload failed: ${error.message}`);
  const { data } = supabase.storage.from(AUDIO_BUCKET).getPublicUrl(filePath);
  return data.publicUrl;
}

export async function deleteStoryAudio(storyId: number): Promise<void> {
  const { data: files, error: listError } = await supabase.storage.from(AUDIO_BUCKET).list(`${storyId}`);
  if (listError) { console.error('list audio error', listError); return; }
  if (files?.length) {
    const paths = files.map(f => `${storyId}/${f.name}`);
    const { error } = await supabase.storage.from(AUDIO_BUCKET).remove(paths);
    if (!error) console.log(`Deleted ${paths.length} audio for story ${storyId}`);
  }
}

export async function initializeAudioBucket(): Promise<void> {
  const { data: buckets } = await supabase.storage.listBuckets();
  if (!buckets?.some(b => b.name === AUDIO_BUCKET)) {
    const { error } = await supabase.storage.createBucket(AUDIO_BUCKET, {
      public: true,
      fileSizeLimit: 50*1024*1024,
      allowedMimeTypes: ['audio/mpeg','audio/mp3','audio/wav','audio/x-mpeg'],
    });
    if (error) console.error('create audio bucket error', error);
    else console.log(`Created bucket ${AUDIO_BUCKET}`);
  }
}

export function estimateDurationFromText(text: string, wordsPerMinute = 150): number {
  const words = text.split(/\s+/).length;
  return Math.ceil((words / wordsPerMinute) * 60);
}
```

Add script `scripts/setup-audio-storage.ts` calling `initializeAudioBucket()` like existing setup-storage.

## 3. TTS Service (`services/ttsService.ts` or `openai/tts.ts`)

Create dedicated service to isolate OpenAI TTS details.

**OpenAI TTS specs:**
- Model: `tts-1` (fast, low cost) or `tts-1-hd` (higher quality, use for ultimate tier)
- Voices: alloy, echo, fable, onyx, nova, shimmer. Recommend mapping by language/age:
  - children -> nova/shimmer (warm female), fable (storyteller)
  - teen -> alloy/echo (neutral)
  - adult -> onyx (deep male) / alloy
  - For RTL/CJK: alloy/nova generally best cross-lingual, but allow override via voice param
- Limit: 4096 chars per request. Must chunk story content.
- Output: mp3 buffer via `response.arrayBuffer()` or stream

**Chunking strategy (critical):**
Story content can be 2500-4000 words (long) ~ 15000 chars. Split by paragraphs, respect sentence boundaries.

```ts
// services/ttsService.ts
import OpenAI from "openai";
import { Language, AgeRange } from "@shared/schema";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const VOICE_BY_AGE: Record<string, string> = {
  children: "nova",
  teen: "alloy",
  adult: "onyx",
};

const VOICE_BY_LANGUAGE: Partial<Record<string, string>> = {
  "ar-eg": "alloy",
  "ja-jp": "alloy",
  "zh-cn": "alloy",
  // add as you test, default alloy works for 30+ locales
};

export function selectVoice(ageRange: AgeRange, language: Language, requestedVoice?: string): string {
  return requestedVoice || VOICE_BY_LANGUAGE[language] || VOICE_BY_AGE[ageRange] || "alloy";
}

export function chunkText(text: string, maxChars = 3500): string[] {
  // Split by paragraphs first, then sentences, to stay under limit and avoid mid-sentence cut
  const paragraphs = text.split(/\n+/).filter(p => p.trim());
  const chunks: string[] = [];
  let current = "";
  for (const para of paragraphs) {
    if ((current + "\n" + para).length <= maxChars) {
      current = current ? `${current}\n${para}` : para;
    } else {
      if (current) chunks.push(current);
      if (para.length <= maxChars) {
        current = para;
      } else {
        // Hard split long paragraph by sentences
        const sentences = para.split(/(?<=[.!?。؟!؟])\s+/);
        current = "";
        for (const s of sentences) {
          if ((current + " " + s).length <= maxChars) {
            current = current ? `${current} ${s}` : s;
          } else {
            if (current) chunks.push(current);
            if (s.length <= maxChars) current = s;
            else {
              // fallback: hard cut
              for (let i=0;i<s.length;i+=maxChars) chunks.push(s.slice(i,i+maxChars));
              current = "";
            }
          }
        }
      }
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

export async function textToSpeech(text: string, voice: string, model: "tts-1" | "tts-1-hd" = "tts-1"): Promise<Buffer> {
  const mp3 = await openai.audio.speech.create({
    model,
    voice: voice as any,
    input: text,
    response_format: "mp3",
    speed: 1.0, // 0.25-4.0, keep 1.0 for kids, maybe 1.05 for adult
  });
  const buffer = Buffer.from(await mp3.arrayBuffer());
  return buffer;
}

export async function generateStoryAudioBuffer(fullText: string, voice: string, model: "tts-1" | "tts-1-hd"): Promise<{buffer: Buffer, duration: number}> {
  const chunks = chunkText(fullText);
  console.log(`TTS: story split into ${chunks.length} chunks`);
  const buffers: Buffer[] = [];
  for (let i=0;i<chunks.length;i++) {
    console.log(`TTS chunk ${i+1}/${chunks.length} len=${chunks[i].length}`);
    const buf = await textToSpeech(chunks[i], voice, model);
    buffers.push(buf);
    // Small delay to avoid rate limit  (optional)
    if (i < chunks.length-1) await new Promise(r=>setTimeout(r, 200));
  }
  // Concatenate mp3 buffers - naive concat works for OpenAI mp3 but better use proper concat; for MVP Buffer.concat
  // For production, consider fluent-ffmpeg or mp3-concat lib
  const combined = Buffer.concat(buffers);
  // Estimate duration: OpenAI doesn't return, use word count heuristic
  const durationSec = Math.ceil(fullText.split(/\s+/).length / 150 * 60);
  return { buffer: combined, duration: durationSec };
}
```

**Future providers:** Abstract behind interface `ITTSProvider` so ElevenLabs `elevenlabs.io` can be swapped for more emotional voices. For now OpenAI TTS keeps cost low and matches existing `openaiAPI.ts` client.

**Cost note:** tts-1 $15/1M chars, tts-1-hd $30/1M chars. Long story ~15k chars => $0.225 / $0.45. Track usage.

## 4. Storage Layer Extensions (`storage.ts`)

Add to `IStorage`:

```ts
// For Option A (columns on stories)
updateStoryAudioStatus(storyId: number, status: string, audioUrl?: string, duration?: number, voice?: string, language?: string): Promise<Story | undefined>;
getStoryWithAudio(id: number, userId: string): Promise<Story | undefined>;

// For Option B (separate table)
createStoryAudio(audio: InsertStoryAudio): Promise<StoryAudio>;
getStoryAudioByStoryId(storyId: number, userId: string): Promise<StoryAudio | undefined>;
updateStoryAudioStatus(audioId: number, status: string, audioUrl?: string, duration?: number): Promise<StoryAudio | undefined>;
deleteStoryAudioByStoryId(storyId: number, userId: string): Promise<boolean>;
```

Impl:

```ts
async updateStoryAudioStatus(storyId, status, audioUrl, duration, voice, language) {
  const [updated] = await db.update(stories).set({
    audioStatus: status,
    audioUrl: audioUrl ?? undefined,
    audioDuration: duration,
    audioVoice: voice,
    audioLanguage: language,
    audioGeneratedAt: status==='ready' ? new Date() : undefined,
    updatedAt: new Date(),
  }).where(eq(stories.id, storyId)).returning();
  return updated;
}
```

Also extend `getStory` to include audio columns (already returns select *).

## 5. Route Design (`routes/story.ts` extension OR new `routes/audio.ts`)

**Preferred:** Create `routes/audio.ts` to keep story.ts from growing beyond 900 lines, but mirror pattern. Or add methods inside `registerStoryRoutes` if you want co-located.

**Endpoints:**

| Method | Path | Tier | Description |
|--------|------|------|-------------|
| POST | `/api/stories/:id/audio` | Pro/Ultimate (free NO) | Generate audio for existing story |
| GET | `/api/stories/:id/audio` | Owner only | Get audio status + URL, or stream? Returns {status, audioUrl, duration, voice} - frontend can use HTML5 <audio> |
| DELETE | `/api/stories/:id/audio` | Owner | Delete audio, reset status |
| POST | `/api/generate-story?withAudio=true` | Ultimate only? | Auto-generate audio after story creation - modify existing generate-story to accept query flag and schedule audio after content ready |
| GET | `/api/stories/:id/audio/stream` (optional) | Owner | Proxy stream from Supabase to hide URL or add auth header check |

**Implementation for POST /api/stories/:id/audio:**

```ts
// routes/audio.ts
import type { Express } from "express";
import rateLimit from 'express-rate-limit';
import { generalLimiter, supabaseAdmin } from "./supabaseAuth";
import { storage } from "../storage";
import { generateStoryAudioBuffer, selectVoice } from "../services/ttsService";
import { storeAudioBuffer, deleteStoryAudio } from "../audio-storage";
import { z } from "zod";

const audioGenerationLimiter = rateLimit({
  windowMs: 15*60*1000,
  max: 20, // expensive, stricter than story gen (50)
  message: { error: 'Too many audio generations, try later' },
});

const audioSchema = z.object({
  voice: z.enum(["alloy","echo","fable","onyx","nova","shimmer"]).optional(),
  model: z.enum(["tts-1","tts-1-hd"]).optional().default("tts-1"),
});

export function registerAudioRoutes(app: Express) {
  app.post("/api/stories/:id/audio", audioGenerationLimiter, async (req:any,res)=>{
    try{
      const authHeader=req.headers.authorization;
      if(!authHeader?.startsWith('Bearer ')) return res.status(401).json({error:"No token"});
      const token=authHeader.split(' ')[1];
      const {data:userData, error}=await supabaseAdmin.auth.getUser(token);
      if(error||!userData.user) return res.status(401).json({error:"Invalid token"});
      const userId=userData.user.id;
      const user=await storage.getUser(userId);
      if(!user) return res.status(404).json({message:"User not found"});

      // Tier gating: decide your strategy
      // Pro can generate audio tts-1 only, Ultimate tts-1-hd, Free blocked
      if(!user.isPremium) {
        return res.status(403).json({message:"Audio narration is Pro feature", requiresUpgrade:true});
      }

      const storyId=parseInt(req.params.id);
      if(isNaN(storyId)) return res.status(400).json({message:"Invalid story ID"});
      const story=await storage.getStory(storyId, userId);
      if(!story) return res.status(404).json({message:"Story not found"});
      if(story.content.includes("being generated")) {
        return res.status(400).json({message:"Story still generating"});
      }

      const {voice: requestedVoice, model} = audioSchema.parse(req.body);

      // Pro can't use hd
      if(model==='tts-1-hd' && user.subscriptionTier!=='ultimate'){
        return res.status(403).json({message:"HD audio is Ultimate only", requiresUpgrade:true});
      }

      // Set status generating immediately (optimistic)
      await storage.updateStoryAudioStatus(storyId, "generating");

      // Fire-and-forget like story generation
      generateAudioAsync(story, userId, requestedVoice, model);

      res.json({message:"Audio generation started", status:"generating", storyId});
    } catch(e:any){
      if(e.name==="ZodError") return res.status(400).json({message:"Invalid data", errors:e.errors});
      console.error("audio gen error", e);
      res.status(500).json({message:"Failed to generate audio"});
    }
  });

  app.get("/api/stories/:id/audio", generalLimiter, async (req:any,res)=>{
    const authHeader=req.headers.authorization;
    if(!authHeader?.startsWith('Bearer ')) return res.status(401).json({error:"No token"});
    const token=authHeader.split(' ')[1];
    const {data:userData, error}=await supabaseAdmin.auth.getUser(token);
    if(error||!userData.user) return res.status(401).json({error:"Invalid token"});
    const storyId=parseInt(req.params.id);
    if(isNaN(storyId)) return res.status(400).json({message:"Invalid story ID"});
    const story=await storage.getStory(storyId, userData.user.id);
    if(!story) return res.status(404).json({message:"Story not found"});
    res.json({
      status: (story as any).audioStatus || "none",
      audioUrl: (story as any).audioUrl,
      duration: (story as any).audioDuration,
      voice: (story as any).audioVoice,
      language: story.language,
    });
  });

  app.delete("/api/stories/:id/audio", generalLimiter, async (req:any,res)=>{
    // auth + owner check same as above
    const authHeader=req.headers.authorization;
    if(!authHeader?.startsWith('Bearer ')) return res.status(401).json({error:"No token"});
    const token=authHeader.split(' ')[1];
    const {data:userData, error}=await supabaseAdmin.auth.getUser(token);
    if(error||!userData.user) return res.status(401).json({error:"Invalid token"});
    const storyId=parseInt(req.params.id);
    const story=await storage.getStory(storyId, userData.user.id);
    if(!story) return res.status(404).json({message:"Story not found"});
    await deleteStoryAudio(storyId);
    await storage.updateStoryAudioStatus(storyId, "none", undefined, undefined);
    res.json({message:"Audio deleted"});
  });

  async function generateAudioAsync(story: any, userId: string, requestedVoice?: string, model: "tts-1"|"tts-1-hd" = "tts-1") {
    try{
      const voice = selectVoice(story.ageRange, story.language, requestedVoice);
      // Include title + content for narration
      const fullText = `${story.title}. ${story.content}`;
      const {buffer, duration} = await generateStoryAudioBuffer(fullText, voice, model);
      const audioUrl = await storeAudioBuffer(buffer, story.id, voice);
      await storage.updateStoryAudioStatus(story.id, "ready", audioUrl, duration, voice, story.language);
      console.log(`Audio ready story ${story.id} voice=${voice} duration=${duration}s url=${audioUrl}`);
    } catch(err){
      console.error(`Audio failed story ${story.id}`, err);
      await storage.updateStoryAudioStatus(story.id, "failed");
    }
  }
}
```

**Register in `routes.ts`:**
```ts
import { registerAudioRoutes } from "./routes/audio";
registerAudioRoutes(app);
```

**Auto-generation hook in `routes/story.ts`:**
In `generateStoryAsync` after `updateStoryAfterGenerated` succeeds, check if request had `withAudio` flag or user preference `autoAudio`:

```ts
// in generateStoryAsync after story updated
if (validatedData.withAudio || userPrefAutoAudio) {
  // trigger audio generation without blocking
  const { generateAudioAfterStory } = await import("../services/ttsService");
  generateAudioAfterStory(story.id);
}
```

Or simpler: call new service method inside same file.

## 6. Client Integration Notes (for skill consumer)

Frontend will need:
- After story ready, show "Listen" button if audioStatus ready, else "Generate Audio" button
- Poll GET /api/stories/:id/audio every 3s while status===generating
- Use HTML5 `<audio controls src={audioUrl} />`
- Show duration: format `audioDuration` seconds to mm:ss
- Handle 30+ languages: display note "Audio may have accent for this language"
- Tier upsell: free users see locked icon, Pro = standard voice, Ultimate = HD choice

## 7. Tier & Limit Strategy

Mirror existing `checkUserStoryLimit`:

- Free: No audio, return 403 requiresUpgrade
- Pro: tts-1, 50 audio generations per month (reuse same monthly limit or new counter `monthlyAudioGenerated`)
- Ultimate: tts-1 + tts-1-hd, 100 audio per month, auto-generation option

Add to `users` table if separate counter needed:
```ts
monthlyAudioGenerated: integer("monthly_audio_generated").default(0)
```

Add method `checkUserAudioLimit` similar to story limit.

## 8. Other File Updates

- `db.ts`: no change (drizzle)
- `config.ts`: no change, but add `AUDIO_BUCKET` env optional `AUDIO_STORAGE_BUCKET=hadouta-audio`
- `image-storage.ts`: keep separate, don't mix
- `pdf-generator.ts`: consider future "PDF + Audio QR code" page linking to audio URL
- `services/scheduledDeletionService.ts`: when deleting user stories, also call `deleteStoryAudio(storyId)` and `deleteStoryImages(storyId)`
- `storage.ts deleteStories(userId)`: loop stories and delete both images and audio (or call service)
- `render.yaml`: add `OPENAI_API_KEY` already exists, ensure Supabase storage bucket creation in deploy hook

## 9. Migration & Setup Scripts

Create scripts like existing:
- `scripts/setup-audio-storage.ts`:
```ts
import { initializeAudioBucket } from "../audio-storage";
initializeAudioBucket().then(()=>{console.log("done"); process.exit(0)});
```
Add to package.json scripts: `"setup-audio-storage": "tsx scripts/setup-audio-storage.ts"`

Migration: `npm run db:push` after schema change.

## 10. Testing

- Unit: `chunkText` splits correctly under 3500 chars, respects sentence boundaries
- `selectVoice` age->voice mapping
- Storage mock for updateStoryAudioStatus
- Integration: mock OpenAI audio.speech.create returning dummy Buffer, verify storeAudioBuffer called
- Limit: Pro cannot request tts-1-hd -> 403
- Edge: story content with emojis/RTL/CJK -> ensure NFC normalization before TTS (like story generation)

Add test file `tests/audio.test.ts`

## 11. Cost & Performance Considerations

- TTS is expensive: cache audioUrl, never regenerate same story+voice unless user requests
- Use tts-1 for Pro (fast), tts-1-hd only Ultimate
- Chunk delay 200ms avoids rate limit
- Buffer concat is MVP; for long stories >10 chunks consider ffmpeg mp3 concat for proper headers (add `fluent-ffmpeg` dep)
- Estimate duration vs real: OpenAI doesn't return duration, use heuristic or `mp3-duration` lib to compute from buffer
- Add cleanup cron for failed statuses older than 1 day

## 12. Step-by-Step Implementation Order

1. Schema change `shared/schema.ts` + `npm run db:push`
2. Create `audio-storage.ts` + setup script, create bucket
3. Create `services/ttsService.ts` with chunking + voice selection
4. Extend `storage.ts` IStorage + DatabaseStorage
5. Create `routes/audio.ts` with POST/GET/DELETE + limiter
6. Register in `routes.ts`
7. Update `scheduledDeletionService` to delete audio
8. Modify `routes/story.ts` `generateStoryAsync` to optionally auto-trigger audio if query param
9. Test locally: create story -> POST audio -> GET status -> listen URL
10. Frontend player (outside server scope, but document API)

## 13. Verification Checklist

- [ ] New columns/table in `shared/schema.ts` + types exported
- [ ] `npm run check` passes (tsc)
- [ ] `audio-storage.ts` mirrors `image-storage.ts` error handling + public URL
- [ ] `ttsService.ts` chunking keeps <4096 chars, sentence-aware, NFC normalized
- [ ] Storage methods use `eq`/`returning` pattern
- [ ] `routes/audio.ts` follows auth header extraction + supabase getUser + isNaN id check + ZodError catch
- [ ] Rate limiter 20/15m for generation, generalLimiter for GET/DELETE
- [ ] Tier checks: free 403, pro blocked from hd, all checks use `requiresUpgrade` flag like story routes
- [ ] Fire-and-forget `generateAudioAsync` with try/catch -> set status failed on error
- [ ] Registered in `routes.ts`
- [ ] Deletion cascades audio on story delete and user delete
- [ ] Manual test: curl with Bearer token generates audio, returns URL, <audio> plays

## Example cURL

```bash
# Generate audio for story 123
curl -X POST http://localhost:5001/api/stories/123/audio \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"voice":"nova","model":"tts-1"}'

# Check status
curl http://localhost:5001/api/stories/123/audio -H "Authorization: Bearer $TOKEN"

# Delete
curl -X DELETE http://localhost:5001/api/stories/123/audio -H "Authorization: Bearer $TOKEN"
```

## Future Enhancements (Document for later)

- Multiple voices per story (separate table Option B)
- Background music mixing (ffmpeg)
- Speed/pitch controls (speed param in TTS)
- Chapter markers by splitting on section placeholders like illustrations
- WebSocket progress streaming vs polling
- ElevenLabs integration for more expressive kids voices
- Audio preview endpoint generating first paragraph only (cheaper)
- Signed URL instead of public for privacy (Supabase createSignedUrl)
- GDPR deletion includes audio bucket

