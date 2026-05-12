import {
  users,
  stories,
  pendingUserDeletions,
  type User,
  type UpsertUser,
  type Story,
  type StoryTemplate,
  type InsertStory,
  type PendingUserDeletion,
  storyTemplates,
} from "./shared/schema";
import { db } from "./db";
import { eq, desc, and, sql } from "drizzle-orm";

// ===== TYPE DEFINITIONS =====

export interface UserStoryLimits {
  canCreate: boolean;
  remaining: number;
  limit: number;
  isPremium: boolean;
  storiesCreated: number;
}

export interface StoriesPaginationOptions {
  page: number;
  limit: number;
  offset: number;
  category?: string;
}

export interface StoriesPaginationResult {
  stories: Story[];
  total: number;
}

export interface StoryTemplatesPaginationResult {
  storyTemplates: StoryTemplate[];
  total: number;
}

// ===== STORAGE INTERFACE =====

export interface IStorage {
  // User operations (required for Replit Auth)
  getUser(id: string): Promise<User | undefined>;
  upsertUser(user: UpsertUser): Promise<User>;
  getUserByStripeCustomerId(customerId: string): Promise<User | undefined>;

  // User subscription management
  updateUserStripeInfo(userId: string, stripeCustomerId: string, stripeSubscriptionId: string): Promise<User>;
  updateUserSubscriptionInfoAfterCheckoutCompleted(
    userId: string,
    tier: string,
    stripeSubscriptionId: string,
    expireAt: number,
  ): Promise<User>;
  updateUserSubscriptionStatusAfterCanceled(userId: string): Promise<User>;

  // User story management
  incrementUserStoryCount(userId: string): Promise<User>;
  checkUserStoryLimit(userId: string): Promise<UserStoryLimits>;

  // Pending user deletion management
  scheduleUserDeletion(userId: string, scheduledFor: Date): Promise<PendingUserDeletion>;
  cancelUserDeletion(userId: string): Promise<boolean>;
  getPendingDeletions(): Promise<PendingUserDeletion[]>;
  deletePendingDeletion(userId: string): Promise<boolean>;

  // Story operations
  createStory(story: InsertStory): Promise<Story>;
  getUserStories(userId: string): Promise<Story[]>;
  getUserStoriesWithPagination(userId: string, options: StoriesPaginationOptions): Promise<StoriesPaginationResult>;
  getStoryTemplates(options: StoriesPaginationOptions): Promise<StoryTemplatesPaginationResult>;
  getStory(id: number, userId: string): Promise<Story | undefined>;
  deleteStory(id: number, userId: string): Promise<boolean>;
  getStoryTemplate(id: number): Promise<StoryTemplate | undefined>;
}

// ===== STORAGE IMPLEMENTATION =====

export class DatabaseStorage implements IStorage {

  // ===== CORE USER OPERATIONS (Required for Replit Auth) =====

  async getUser(id: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user;
  }

  async upsertUser(userData: UpsertUser): Promise<User> {
    const [user] = await db
      .insert(users)
      .values(userData)
      .onConflictDoUpdate({
        target: users.id,
        set: {
          ...userData,
          updatedAt: new Date(),
        },
      })
      .returning();
    return user;
  }

  async updateUser(userData: UpsertUser): Promise<User> {
    const [user] = await db
      .update(users)
      .set(userData)
      .where(eq(users.id, userData.id))
      .returning();
    return user;
  }

  async getUserByStripeCustomerId(customerId: string): Promise<User | undefined> {
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.stripeCustomerId, customerId));
    return user;
  }

  // ===== USER SUBSCRIPTION MANAGEMENT =====

  async updateUserStripeInfo(userId: string, stripeCustomerId: string, stripeSubscriptionId: string): Promise<User> {
    const updateData: any = {
      stripeCustomerId,
      updatedAt: new Date(),
    };

    // Only update subscription ID if provided
    if (stripeSubscriptionId) {
      updateData.stripeSubscriptionId = stripeSubscriptionId;
      updateData.isPremium = true;
    }

    const [user] = await db
      .update(users)
      .set(updateData)
      .where(eq(users.id, userId))
      .returning();
    return user;
  }

  async updateUserSubscriptionInfoAfterCheckoutCompleted(userId: string, tier: string, stripeSubscriptionId: string, expireAt: number): Promise<User> {
    const [user] = await db
      .update(users)
      .set({
        subscriptionTier: tier,
        monthlyStoriesGenerated: 0,
        isPremium: true,
        updatedAt: new Date(),
        subscriptionStatus: 'active',
        stripeSubscriptionId: stripeSubscriptionId,
        subscriptionExpireAt: new Date(expireAt * 1000),
      })
      .where(eq(users.id, userId))
      .returning();
    return user;
  }

  async updateUserSubscriptionInfoAfterPaymentSucceeded(userId: string, tier: string, expireAt: number): Promise<User> {
    const [user] = await db
      .update(users)
      .set({
        subscriptionTier: tier,
        monthlyStoriesGenerated: 0,
        isPremium: tier === "free" ? false : true,
        updatedAt: new Date(),
        subscriptionStatus: 'active',
        subscriptionExpireAt: new Date(expireAt * 1000),
      })
      .where(eq(users.id, userId))
      .returning();
    return user;
  }


  async updateUserSubscriptionInfoDeletingSubscription(userId: string): Promise<User> {
    const [user] = await db
      .update(users)
      .set({
        subscriptionTier: "free",
        monthlyStoriesGenerated: 0,
        isPremium: false,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId))
      .returning();
    return user;
  }

  async updateUserSubscriptionStatusAfterCanceled(userId: string): Promise<User> {
    const [user] = await db
      .update(users)
      .set({
        subscriptionStatus: 'canceled',
        updatedAt: new Date()
      })
      .where(eq(users.id, userId))
      .returning();
    return user;
  }

  // ===== USER STORY MANAGEMENT =====

  async incrementUserStoryCount(userId: string): Promise<User> {
    const [user] = await db
      .update(users)
      .set({
        storiesGenerated: sql`${users.storiesGenerated} + 1`,
        monthlyStoriesGenerated: sql`${users.monthlyStoriesGenerated} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId))
      .returning();
    return user;
  }

  async checkUserStoryLimit(userId: string): Promise<UserStoryLimits> {
    let user = await db.select().from(users).where(eq(users.id, userId)).then(rows => rows[0]);
    if (!user) {
      throw new Error("User not found");
    }

    const storiesCreated = user.storiesGenerated;

    if (user.isPremium) {
      // Determine limit based on subscription tier
      let limit = 50; // Default Pro limit
      if (user.subscriptionTier === 'ultimate') {
        limit = 100; // Ultimate tier limit
      }


      const used = user.monthlyStoriesGenerated || 0;
      const remaining = Math.max(0, limit - used);
      return {
        canCreate: used < limit,
        remaining,
        limit,
        isPremium: true,
        storiesCreated: storiesCreated || 0,
      };
    } else {
      // Free users: 3 lifetime stories
      const limit = 3;

      const used = storiesCreated == null ? 3 : storiesCreated;
      const remaining = Math.max(0, limit - used);

      return {
        canCreate: used < limit,
        remaining,
        limit,
        isPremium: false,
        storiesCreated: storiesCreated || 0,
      };
    }
  }

  // ===== STORY OPERATIONS =====

  async createStory(story: InsertStory): Promise<Story> {
    const [newStory] = await db
      .insert(stories)
      .values(story)
      .returning();
    return newStory;
  }

  async getUserStories(userId: string): Promise<Story[]> {
    return await db
      .select()
      .from(stories)
      .where(eq(stories.userId, userId))
      .orderBy(desc(stories.createdAt));
  }

  async getUserStoriesWithPagination(userId: string, options: StoriesPaginationOptions): Promise<StoriesPaginationResult> {
    // Build where conditions
    const conditions = [eq(stories.userId, userId)];
    if (options.category) {
      conditions.push(eq(stories.category, options.category));
    }

    // Get total count
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(stories)
      .where(and(...conditions));

    // Get paginated stories
    const userStories = await db
      .select()
      .from(stories)
      .where(and(...conditions))
      .orderBy(desc(stories.createdAt))
      .limit(options.limit)
      .offset(options.offset);

    return {
      stories: userStories,
      total: count
    };
  }

  async getStoryTemplates(options: StoriesPaginationOptions): Promise<StoryTemplatesPaginationResult> {
    // Build where conditions
    const conditions = [];
    if (options.category) {
      conditions.push(eq(storyTemplates.category, options.category));
    }

    // Get total count
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(storyTemplates)
      .where(and(...conditions));

    // Get paginated stories
    const templateStories = await db
      .select()
      .from(storyTemplates)
      .where(and(...conditions))
      .orderBy(desc(storyTemplates.createdAt))
      .limit(options.limit)
      .offset(options.offset);

    return {
      storyTemplates: templateStories,
      total: count
    };
  }


  async getStory(id: number, userId: string): Promise<Story | undefined> {
    const [story] = await db
      .select()
      .from(stories)
      .where(and(eq(stories.id, id), eq(stories.userId, userId)));
    return story;
  }

  async getStoryTemplate(id: number): Promise<StoryTemplate | undefined> {
    const [storyTemplate] = await db
      .select()
      .from(storyTemplates)
      .where(and(eq(storyTemplates.id, id)));
    return storyTemplate;
  }

  async deleteStory(id: number, userId: string): Promise<boolean> {
    const result = await db
      .delete(stories)
      .where(and(eq(stories.id, id), eq(stories.userId, userId)))
      .returning();
    return result.length > 0;
  }

  async updateStoryAfterGenerated(storyId: number, title: string, content: string, illustrations: string[], coverUrl: string | undefined): Promise<Story | undefined> {
    const [updatedStory] = await db
      .update(stories)
      .set({ title, content, illustrations, excerpt: content.substring(0, 150) + "...", coverUrl })
      .where(eq(stories.id, storyId))
      .returning();
    return updatedStory;
  }

  async deleteStories(userId: string): Promise<void> {
    await db
      .delete(stories)
      .where(eq(stories.userId, userId));
  }

  async deleteUser(userId: string): Promise<void> {
    await db
      .delete(users)
      .where(eq(users.id, userId));
  }

  // ===== PENDING USER DELETION MANAGEMENT =====

  async scheduleUserDeletion(userId: string, scheduledFor: Date): Promise<PendingUserDeletion> {
    const [pendingDeletion] = await db
      .insert(pendingUserDeletions)
      .values({ userId, scheduledFor })
      .returning();
    return pendingDeletion;
  }

  async cancelUserDeletion(userId: string): Promise<boolean> {
    const result = await db
      .delete(pendingUserDeletions)
      .where(eq(pendingUserDeletions.userId, userId))
      .returning();
    return result.length > 0;
  }

  async getPendingDeletions(): Promise<PendingUserDeletion[]> {
    return await db
      .select()
      .from(pendingUserDeletions);
  }

  async deletePendingDeletion(userId: string): Promise<boolean> {
    const result = await db
      .delete(pendingUserDeletions)
      .where(eq(pendingUserDeletions.userId, userId))
      .returning();
    return result.length > 0;
  }
}

export const storage = new DatabaseStorage();
