import {
  pgTable,
  text,
  varchar,
  timestamp,
  jsonb,
  index,
  serial,
  integer,
  boolean,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// Keep using varchar for flexibility but enforce validation in application layer

// Session storage table.
// (IMPORTANT) This table is mandatory for Replit Auth, don't drop it.
export const sessions = pgTable(
  "sessions",
  {
    sid: varchar("sid").primaryKey(),
    sess: jsonb("sess").notNull(),
    expire: timestamp("expire").notNull(),
  },
  (table) => [index("IDX_session_expire").on(table.expire)],
);

// User storage table.
// (IMPORTANT) This table is mandatory for Replit Auth, don't drop it.
export const users = pgTable("users", {
  id: varchar("id").primaryKey().notNull(),
  email: varchar("email").unique(),
  firstName: varchar("first_name"),
  lastName: varchar("last_name"),
  profileImageUrl: varchar("profile_image_url"),
  stripeCustomerId: varchar("stripe_customer_id"),
  stripeSubscriptionId: varchar("stripe_subscription_id"),
  subscriptionExpireAt: timestamp("subscription_expire_at"), // when subscription will end
  subscriptionStatus: varchar("subscription_status"), // active, canceled, past_due, etc.
  isPremium: boolean("is_premium").default(false),
  subscriptionTier: varchar("subscription_tier").default("free"), // "free", "pro", "ultimate"
  storiesGenerated: integer("stories_generated").default(0), // lifetime story count for free plan limits
  monthlyStoriesGenerated: integer("monthly_stories_generated").default(0), // monthly story count for pro plan limits
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Pending user deletions table for scheduled account deletion
export const pendingUserDeletions = pgTable("pending_user_deletions", {
  id: serial("id").primaryKey(),
  userId: varchar("user_id").notNull().unique(),
  scheduledFor: timestamp("scheduled_for").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("IDX_pending_deletions_scheduled_for").on(table.scheduledFor),
  index("IDX_pending_deletions_user_id").on(table.userId),
]);


export const stories = pgTable("stories", {
  id: serial("id").primaryKey(),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  content: text("content").notNull(),
  category: varchar("category").notNull(),
  language: varchar("language").notNull().default("en-us"), // Language code with regional dialect (en-us, ar-eg, etc.)
  ageRange: varchar("age_range").notNull().default("children"), // Target age group: children, teen, adult
  size: varchar("size").notNull().default("medium"), // Story length: short, medium, long
  fontFamily: varchar("font_family").default("serif"), // Font style for story display
  characters: jsonb("characters").notNull(), // Array of character objects with names and photos
  illustrations: jsonb("illustrations"), // Array of generated story illustration URLs
  excerpt: text("excerpt"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
  previousId: serial("previous_id"),
  coverUrl: varchar("cover_url"),
});

export const storyTemplates = pgTable("story_templates", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  content: text("content").notNull(),
  category: varchar("category").notNull(),
  language: varchar("language").notNull().default("en-us"), // Language code with regional dialect (en-us, ar-eg, etc.)
  ageRange: varchar("age_range").notNull().default("children"), // Target age group: children, teen, adult
  size: varchar("size").notNull().default("medium"), // Story length: short, medium, long
  fontFamily: varchar("font_family").default("serif"), // Font style for story display
  illustrations: jsonb("illustrations"), // Array of generated story illustration URLs
  excerpt: text("excerpt"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
  coverUrl: varchar("cover_url"),
});

export const insertUserSchema = createInsertSchema(users).omit({
  createdAt: true,
  updatedAt: true,
});

// Character type for frontend
export const characterSchema = z.object({
  name: z.string().min(1, "Character name is required").max(10, "Character name must be 10 characters or less"),
  photo: z.string().optional(),
});

export const insertStorySchema = createInsertSchema(stories).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
}).extend({
  characters: z.array(characterSchema).min(1, "At least one character is required").max(5, "Maximum 5 characters allowed"),
  category: z.enum(["adventure", "romance", "mystery", "comedy", "fantasy", "sci-fi", "drama", "thriller", "historical", "biography", "slice-of-life", "horror"]),
  size: z.enum(["short", "medium", "long"]).default("medium"),
  language: z.enum([
    "en-us", "en-gb", "en-au", "en-ca",
    "es-es", "es-mx", "es-ar", "es-co",
    "fr-fr", "fr-ca", "fr-be",
    "de-de", "de-at", "de-ch",
    "it-it", "it-ch",
    "pt-br", "pt-pt",
    "ar-eg", "ar-sa", "ar-ma", "ar-ae",
    "zh-cn", "zh-tw", "zh-hk",
    "ja-jp",
    "ko-kr",
    "hi-in",
    "ru-ru"
  ]).default("en-us"),
  ageRange: z.enum(["children", "teen", "adult"]).default("children"),
  fontFamily: z.enum(["serif", "sans-serif", "monospace", "cursive", "fantasy"]).default("serif").optional(),
  customTitle: z.string().max(50, "Title must be 50 characters or less").optional(),
  customDescription: z.string().max(100, "Description must be 100 characters or less").optional(),
  coverUrl: z.string().optional(),
});

export type User = typeof users.$inferSelect;
export type UpsertUser = typeof users.$inferInsert;

export type Story = typeof stories.$inferSelect;
export type StoryTemplate = typeof storyTemplates.$inferSelect;
export type InsertStory = typeof stories.$inferInsert;

export type PendingUserDeletion = typeof pendingUserDeletions.$inferSelect;
export type InsertPendingUserDeletion = typeof pendingUserDeletions.$inferInsert;

export type Character = z.infer<typeof characterSchema>;

export type Category = "adventure" | "romance" | "mystery" | "comedy" | "fantasy" | "sci-fi" | "drama" | "thriller" | "historical" | "biography" | "slice-of-life" | "horror";
export type AgeRange = "children" | "teen" | "adult";
export type Language = "en-us" | "en-gb" | "en-au" | "en-ca" |
  "es-es" | "es-mx" | "es-ar" | "es-co" |
  "fr-fr" | "fr-ca" | "fr-be" |
  "de-de" | "de-at" | "de-ch" |
  "it-it" | "it-ch" |
  "pt-br" | "pt-pt" |
  "ar-eg" | "ar-sa" | "ar-ma" | "ar-ae" |
  "zh-cn" | "zh-tw" | "zh-hk" |
  "ja-jp" |
  "ko-kr" |
  "hi-in" |
  "ru-ru";
export type Size = "short" | "medium" | "long";
export type FontFamily = "serif" | "sans-serif" | "monospace" | "cursive" | "fantasy";
