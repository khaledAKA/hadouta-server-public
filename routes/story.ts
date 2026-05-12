import type { Express } from "express";
import rateLimit from 'express-rate-limit';
import { generalLimiter, supabaseAdmin } from "./supabaseAuth";
import { storage } from "../storage";
import { generateStory } from "../openaiAPI";
import { downloadAndStoreImages, deleteStoryImages, compressImage } from "../image-storage";
import { z } from "zod";
import { AgeRange, Category, Character, FontFamily, Language, Size, Story, StoryTemplate } from "@shared/schema";

// Rate limiting for story generation (more restrictive)
const storyGenerationLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 50, // limit each IP to 50 story generation attempts per windowMs
    message: { error: 'Too many story generation attempts, please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
});

// Function to validate photo size (512KB = 512 * 1024 = 524,288 bytes)
const validatePhotoSize = (photoUrl: string): boolean => {
    try {
        // For base64 images, calculate size from the string
        if (photoUrl.startsWith('data:image')) {
            const base64Data = photoUrl.split(',')[1];
            if (base64Data) {
                const sizeInBytes = Math.ceil((base64Data.length * 3) / 4);
                // Allow up to 2MB for base64 since we'll compress it
                return sizeInBytes <= 2097152; // 2MB
            }
        }

        // For URLs, we can't easily check size without downloading
        // So we'll assume URLs are valid and let the image storage handle it
        if (photoUrl.startsWith('http')) {
            return true;
        }

        return false;
    } catch (error) {
        console.error('Photo size validation error:', error);
        return false;
    }
};

// Custom validator for character photos
const photoValidator = z.string().refine((photo) => {
    if (!photo) return true; // Allow empty/undefined photos
    return validatePhotoSize(photo);
}, {
    message: "Character photo must not exceed 2MB (will be automatically compressed)"
});

// Story generation schema
const storyGenerationSchema = z.object({
    customTitle: z.string().min(0).max(50).optional(),
    customDescription: z.string().min(0).max(100).optional(),
    characters: z.array(z.object({
        name: z.string().min(1).max(10),
        photo: photoValidator.optional()
    })).min(1).max(5),
    category: z.enum([
        "adventure", "romance", "mystery", "comedy", "fantasy",
        "sci-fi", "drama", "thriller", "historical", "biography",
        "slice-of-life", "horror"
    ]),
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
    addIllustrations: z.boolean().default(false)
});

export function registerStoryRoutes(app: Express) {
    // Check user's story limits
    app.get("/api/story-limits", async (req: any, res) => {
        try {
            const authHeader = req.headers.authorization;

            if (!authHeader || !authHeader.startsWith('Bearer ')) {
                return res.status(401).json({ error: "No token provided" });
            }

            const token = authHeader.split(' ')[1];

            const { data: userData, error } = await supabaseAdmin.auth.getUser(token);

            if (error || !userData.user) {
                return res.status(401).json({ error: "Invalid token" });
            }

            const limits = await storage.checkUserStoryLimit(userData.user.id);
            res.json(limits);
        } catch (error: any) {
            console.error("Error checking story limits:", error);
            res.status(500).json({ message: "Failed to check story limits" });
        }
    });


    // Story generation route
    app.post("/api/generate-story", storyGenerationLimiter, async (req: any, res) => {
        try {
            const authHeader = req.headers.authorization;

            if (!authHeader || !authHeader.startsWith('Bearer ')) {
                return res.status(401).json({ error: "No token provided" });
            }

            const token = authHeader.split(' ')[1];

            const { data: userData, error } = await supabaseAdmin.auth.getUser(token);

            if (error || !userData.user) {
                return res.status(401).json({ error: "Invalid token" });
            }

            const userId = userData.user.id;
            const user = await storage.getUser(userId);
            if (!user) {
                return res.status(404).json({ message: "User not found" });
            }

            // Check story limits for all users
            const limits = await storage.checkUserStoryLimit(userId);
            if (!limits.canCreate) {
                const message = limits.isPremium
                    ? `Monthly story limit reached (${limits.limit} per month). Your limit will reset next month.`
                    : `Story limit reached (${limits.limit} lifetime stories). Upgrade to Pro for 50 stories per month.`;

                return res.status(403).json({
                    message,
                    requiresUpgrade: !limits.isPremium,
                    limits
                });
            }

            const validatedData = storyGenerationSchema.parse(req.body);

            // Additional validation for character photos
            for (const character of validatedData.characters) {
                if (character.photo && !validatePhotoSize(character.photo)) {
                    return res.status(400).json({
                        message: `Character "${character.name}" photo exceeds 2MB limit (will be automatically compressed). Please use a smaller image.`,
                        requiresUpgrade: false
                    });
                }
            }

            // Enforce plan restrictions
            if (!user.isPremium) {
                // Free users can only use short stories
                if (validatedData.size !== 'short') {
                    return res.status(403).json({
                        message: "Medium and long stories are Pro features. Upgrade to access all story lengths.",
                        requiresUpgrade: true
                    });
                }

                // Free users can only use English languages
                if (!validatedData.language.startsWith('en-')) {
                    return res.status(403).json({
                        message: "Multiple languages are a Pro feature. Upgrade to access 30+ languages and dialects.",
                        requiresUpgrade: true
                    });
                }

                // Free users can only use 1 character
                if (validatedData.characters.length > 1) {
                    return res.status(403).json({
                        message: "Multiple characters are a Pro feature. Upgrade to add up to 5 characters.",
                        requiresUpgrade: true
                    });
                }

                if (validatedData.characters.length === 0) {
                    return res.status(400).json({
                        message: "at least one character is required",
                        requiresUpgrade: false
                    });
                }

                if (validatedData.characters[0].photo != undefined && validatedData.characters[0].photo != '') {
                    return res.status(400).json({
                        message: "photo is not allowed for free users",
                        requiresUpgrade: false
                    });
                }

                // Free users can only use first 5 categories
                const freeCategories = ['adventure', 'romance', 'mystery', 'comedy', 'fantasy'];
                if (!freeCategories.includes(validatedData.category)) {
                    return res.status(403).json({
                        message: "This story theme is a Pro feature. Upgrade to access all story themes.",
                        requiresUpgrade: true
                    });
                }

                // Free users cannot customize fonts (default to serif)
                if (validatedData.fontFamily && validatedData.fontFamily !== 'serif') {
                    return res.status(403).json({
                        message: "Font customization is a Pro feature. Upgrade to access different font styles.",
                        requiresUpgrade: true
                    });
                }

                // Ensure free users get serif font
                validatedData.fontFamily = 'serif';
            } else {
                // Pro users limited to 5 characters maximum
                if (validatedData.characters.length > 5) {
                    return res.status(400).json({
                        message: "Maximum of 5 characters allowed per story.",
                    });
                }
                if (user.subscriptionTier === 'pro') {
                    console.log("validatedData.characters", validatedData.characters);
                    if (validatedData.characters.some(character => (character.photo != null && character.photo != ''))) {
                        return res.status(400).json({
                            message: "photo is not allowed for pro users",
                            requiresUpgrade: false
                        });
                    }
                }
            }


            if (validatedData.addIllustrations && user.subscriptionTier !== 'ultimate') {
                return res.status(400).json({
                    message: "Only Ultimate tier users can add illustrations to their stories",
                    requiresUpgrade: false
                });
            }

            // increment user story count
            await storage.incrementUserStoryCount(user.id);
            // Save story to database first to get the story ID
            const compressedCharacters = await Promise.all(validatedData.characters.map(async character => {
                if (character.photo) {
                    const imageBase64 = character.photo;
                    // Compress image before uploading
                    const compressedBuffer = (await compressImage(imageBase64)).toString('base64');
                    return {
                        ...character,
                        photo: compressedBuffer
                    };
                }
                return character;
            }));
            const story = await storage.createStory({
                userId,
                title: "Your story is being generated...",
                content: "Come back later to see your story",
                category: validatedData.category,
                language: validatedData.language,
                ageRange: validatedData.ageRange,
                size: validatedData.size,
                fontFamily: validatedData.fontFamily || 'serif',
                characters: compressedCharacters,
                illustrations: [], // Will be updated after images are stored
                excerpt: "",
            });

            generateStoryAsync(story, validatedData);
            res.json(story);
        } catch (error: any) {
            console.error("Error generating story:", error);

            if (error.name === "ZodError") {
                return res.status(400).json({ message: "Invalid request data", errors: error.errors });
            }

            // Provide specific error messages based on error type
            let errorMessage = "Failed to generate story. Please try again.";
            let statusCode = 500;

            if (error.message?.includes("timeout") || error.message?.includes("TIMEOUT")) {
                errorMessage = "Story generation timed out. Please try with shorter content or try again later.";
                statusCode = 408;
            } else if (error.message?.includes("quota") || error.message?.includes("rate limit")) {
                errorMessage = "AI service is temporarily busy. Please try again in a few minutes.";
                statusCode = 429;
            } else if (error.message?.includes("invalid") || error.message?.includes("validation")) {
                errorMessage = "Invalid story parameters. Please check your inputs and try again.";
                statusCode = 400;
            } else if (error.message?.includes("network") || error.message?.includes("fetch")) {
                errorMessage = "Network connection error. Please check your connection and try again.";
                statusCode = 503;
            } else if (error.message?.includes("limit")) {
                errorMessage = "You've reached your story limit. Please upgrade your plan to create more stories.";
                statusCode = 403;
            }

            res.status(statusCode).json({
                message: errorMessage,
                error: process.env.NODE_ENV === 'development' ? error.message : undefined
            });
        }
    });

    async function generateStoryAsync(story: { id: number; createdAt: Date | null; updatedAt: Date | null; userId: string; title: string; content: string; category: string; language: string; ageRange: string; size: string; fontFamily: string | null; characters: unknown; illustrations: unknown; excerpt: string | null; previousId: number; } | undefined, validatedData: { characters: { name: string; photo?: string | undefined; }[]; category: string; ageRange: string; language: string; size: string; addIllustrations: any; }) {
        // Generate story using OpenAI
        let storyResult;
        try {
            storyResult = await generateStory(
                validatedData.characters,
                validatedData.category,
                validatedData.ageRange,
                validatedData.language,
                validatedData.size,
                (validatedData as any).customTitle,
                (validatedData as any).customDescription,
                validatedData.addIllustrations || false
            );
        } catch (error) {
            // delete the story and decrese the count
            await storage.deleteStory(story?.id as number, story?.userId as string);
            return;
        }

        try {
            // Download and store images locally if any were generated
            let storedIllustrations: string[] = [];
            if (storyResult?.illustrations && storyResult.illustrations.length > 0) {
                console.log(`Downloading and storing ${storyResult.illustrations.length} illustrations for story ${story?.id}`);
                storedIllustrations = await downloadAndStoreImages(storyResult.illustrations, story?.id as number);
            }
            let coverUrl: string | undefined;
            if (storyResult?.coverImage) {
                console.log(`Downloading and storing cover image for story ${story?.id}`);
                const coverImage = await downloadAndStoreImages([storyResult.coverImage], story?.id as number);
                coverUrl = coverImage[0];
            }

            story = await storage.updateStoryAfterGenerated(story?.id as number, storyResult?.title as string,
                storyResult?.content as string,
                storedIllustrations ?? [],
                coverUrl
            );
        } catch (error) {
            await storage.deleteStory(story?.id as number, story?.userId as string);
            // delete the story and decrese the count
            return;
        }



    }

    // Story generation route
    app.post("/api/generate-from-template/:id", storyGenerationLimiter, async (req: any, res) => {
        try {
            const authHeader = req.headers.authorization;

            if (!authHeader || !authHeader.startsWith('Bearer ')) {
                return res.status(401).json({ error: "No token provided" });
            }

            const token = authHeader.split(' ')[1];

            const { data: userData, error } = await supabaseAdmin.auth.getUser(token);

            if (error || !userData.user) {
                return res.status(401).json({ error: "Invalid token" });
            }

            const userId = userData.user.id;
            const user = await storage.getUser(userId);
            if (!user) {
                return res.status(404).json({ message: "User not found" });
            }

            // Check story limits for all users
            const limits = await storage.checkUserStoryLimit(userId);
            if (!limits.canCreate) {
                const message = limits.isPremium
                    ? `Monthly story limit reached (${limits.limit} per month). Your limit will reset next month.`
                    : `Story limit reached (${limits.limit} lifetime stories). Upgrade to Pro for 50 stories per month.`;

                return res.status(403).json({
                    message,
                    requiresUpgrade: !limits.isPremium,
                    limits
                });
            }

            if (user.subscriptionTier !== 'ultimate') {
                return res.status(400).json({
                    message: "Only Ultimate tier users can generate sequels",
                    requiresUpgrade: false
                });
            }

            // Validate that the ID is a valid number
            const storyTemplateId = parseInt(req.params.id);
            if (isNaN(storyTemplateId)) {
                return res.status(400).json({ message: "Invalid story ID - must be a number" });
            }

            const originalStoryTemplate = await storage.getStoryTemplate(parseInt(req.params.id)) as StoryTemplate | null;

            if (!originalStoryTemplate) {
                return res.status(404).json({ message: "Story template not found" });
            }

            const validatedData = req.body;

            // Additional validation for character photos
            for (const character of validatedData.characters) {
                if (character.photo && !validatePhotoSize(character.photo)) {
                    return res.status(400).json({
                        message: `Character "${character.name}" photo exceeds 2MB limit (will be automatically compressed). Please use a smaller image.`,
                        requiresUpgrade: false
                    });
                }
            }

            // Free users can only use 1 character
            if (validatedData.characters.length > 1) {
                return res.status(403).json({
                    message: "Multiple characters are a Pro feature. Upgrade to add up to 5 characters.",
                    requiresUpgrade: true
                });
            }

            const compressedCharacters = await Promise.all(validatedData.characters.map(async character => {
                if (character.photo) {
                    const imageBase64 = character.photo;
                    // Compress image before uploading
                    const compressedBuffer = (await compressImage(imageBase64)).toString('base64');
                    return {
                        ...character,
                        photo: compressedBuffer
                    };
                }
                return character;
            }));

            // increment user story count
            await storage.incrementUserStoryCount(user.id);
            const story = await storage.createStory({
                userId,
                title: originalStoryTemplate.title.replaceAll("[name]", compressedCharacters[0].name),
                content: originalStoryTemplate.content.replaceAll("[name]", compressedCharacters[0].name),
                category: originalStoryTemplate.category as Category,
                language: originalStoryTemplate.language as Language,
                ageRange: originalStoryTemplate.ageRange as AgeRange,
                size: originalStoryTemplate.size as Size,
                fontFamily: originalStoryTemplate.fontFamily as FontFamily || 'serif',
                characters: compressedCharacters as Character[],
                coverUrl: originalStoryTemplate.coverUrl as string || undefined,
                illustrations: originalStoryTemplate.illustrations as string[] || [], // Will be updated after images are stored
                excerpt: "",
                previousId: undefined
            });

            // TODO: check if the character provided photo and replace the images with AI images

            res.json(story);
        } catch (error: any) {
            console.error("Error generating story:", error);

            if (error.name === "ZodError") {
                return res.status(400).json({ message: "Invalid request data", errors: error.errors });
            }

            // Provide specific error messages based on error type
            let errorMessage = "Failed to generate story. Please try again.";
            let statusCode = 500;

            if (error.message?.includes("timeout") || error.message?.includes("TIMEOUT")) {
                errorMessage = "Story generation timed out. Please try with shorter content or try again later.";
                statusCode = 408;
            } else if (error.message?.includes("quota") || error.message?.includes("rate limit")) {
                errorMessage = "AI service is temporarily busy. Please try again in a few minutes.";
                statusCode = 429;
            } else if (error.message?.includes("invalid") || error.message?.includes("validation")) {
                errorMessage = "Invalid story parameters. Please check your inputs and try again.";
                statusCode = 400;
            } else if (error.message?.includes("network") || error.message?.includes("fetch")) {
                errorMessage = "Network connection error. Please check your connection and try again.";
                statusCode = 503;
            } else if (error.message?.includes("limit")) {
                errorMessage = "You've reached your story limit. Please upgrade your plan to create more stories.";
                statusCode = 403;
            }

            res.status(statusCode).json({
                message: errorMessage,
                error: process.env.NODE_ENV === 'development' ? error.message : undefined
            });
        }
    });

    // Story generation route
    app.post("/api/generate-story-sequel/:id", storyGenerationLimiter, async (req: any, res) => {
        try {
            const authHeader = req.headers.authorization;

            if (!authHeader || !authHeader.startsWith('Bearer ')) {
                return res.status(401).json({ error: "No token provided" });
            }

            const token = authHeader.split(' ')[1];

            const { data: userData, error } = await supabaseAdmin.auth.getUser(token);

            if (error || !userData.user) {
                return res.status(401).json({ error: "Invalid token" });
            }

            const userId = userData.user.id;
            const user = await storage.getUser(userId);
            if (!user) {
                return res.status(404).json({ message: "User not found" });
            }

            // Check story limits for all users
            const limits = await storage.checkUserStoryLimit(userId);
            if (!limits.canCreate) {
                const message = limits.isPremium
                    ? `Monthly story limit reached (${limits.limit} per month). Your limit will reset next month.`
                    : `Story limit reached (${limits.limit} lifetime stories). Upgrade to Pro for 50 stories per month.`;

                return res.status(403).json({
                    message,
                    requiresUpgrade: !limits.isPremium,
                    limits
                });
            }

            if (user.subscriptionTier !== 'ultimate') {
                return res.status(400).json({
                    message: "Only Ultimate tier users can generate sequels",
                    requiresUpgrade: false
                });
            }

            // Validate that the ID is a valid number
            const storyId = parseInt(req.params.id);
            if (isNaN(storyId)) {
                return res.status(400).json({ message: "Invalid story ID - must be a number" });
            }

            const originalStory = await storage.getStory(parseInt(req.params.id), userId) as Story | null;

            if (!originalStory) {
                return res.status(404).json({ message: "Story not found" });
            }

            // increment user story count
            await storage.incrementUserStoryCount(user.id);
            const story = await storage.createStory({
                userId,
                title: "Your story is being generated...",
                content: "Come back later to see your story",
                category: originalStory.category as Category,
                language: originalStory.language as Language,
                ageRange: originalStory.ageRange as AgeRange,
                size: originalStory.size as Size,
                fontFamily: originalStory.fontFamily as FontFamily || 'serif',
                characters: originalStory.characters as Character[],
                illustrations: [], // Will be updated after images are stored
                excerpt: "",
                previousId: originalStory.id
            });

            generateStorySequelAsync(originalStory, story);
            res.json(story);
        } catch (error: any) {
            console.error("Error generating story:", error);

            if (error.name === "ZodError") {
                return res.status(400).json({ message: "Invalid request data", errors: error.errors });
            }

            // Provide specific error messages based on error type
            let errorMessage = "Failed to generate story. Please try again.";
            let statusCode = 500;

            if (error.message?.includes("timeout") || error.message?.includes("TIMEOUT")) {
                errorMessage = "Story generation timed out. Please try with shorter content or try again later.";
                statusCode = 408;
            } else if (error.message?.includes("quota") || error.message?.includes("rate limit")) {
                errorMessage = "AI service is temporarily busy. Please try again in a few minutes.";
                statusCode = 429;
            } else if (error.message?.includes("invalid") || error.message?.includes("validation")) {
                errorMessage = "Invalid story parameters. Please check your inputs and try again.";
                statusCode = 400;
            } else if (error.message?.includes("network") || error.message?.includes("fetch")) {
                errorMessage = "Network connection error. Please check your connection and try again.";
                statusCode = 503;
            } else if (error.message?.includes("limit")) {
                errorMessage = "You've reached your story limit. Please upgrade your plan to create more stories.";
                statusCode = 403;
            }

            res.status(statusCode).json({
                message: errorMessage,
                error: process.env.NODE_ENV === 'development' ? error.message : undefined
            });
        }
    });

    async function generateStorySequelAsync(originalStory: Story, story: Story) {
        const illustrations = originalStory.illustrations as Array<string> | null;
        // Generate story using OpenAI
        let storyResult;
        try {
            storyResult = await generateStory(
                originalStory.characters as Character[],
                originalStory.category,
                originalStory.ageRange,
                originalStory.language,
                originalStory.size,
                "",
                "",
                (illustrations && illustrations?.length !== 0) ?? false,
                originalStory
            );
        } catch (error) {
            console.error('Error generating story:', error);
            await storage.deleteStory(story?.id as number, story?.userId as string);
            return;
        }

        try {
            // Download and store images locally if any were generated
            let storedIllustrations: string[] = [];
            if (storyResult?.illustrations && storyResult.illustrations.length > 0) {
                console.log(`Downloading and storing ${storyResult.illustrations.length} illustrations for story ${story?.id}`);
                storedIllustrations = await downloadAndStoreImages(storyResult.illustrations, story?.id as number);
            }
            let coverUrl: string | undefined;
            if (storyResult?.coverImage) {
                console.log(`Downloading and storing cover image for story ${story?.id}`);
                const coverImage = await downloadAndStoreImages([storyResult.coverImage], story?.id as number);
                coverUrl = coverImage[0];
            }
            await storage.updateStoryAfterGenerated(story?.id as number, storyResult?.title as string,
                storyResult?.content as string,
                storedIllustrations ?? [],
                coverUrl
            );
        } catch (error) {
            console.error('Error saving story to database:', error);
            await storage.deleteStory(story?.id as number, story?.userId as string);
            return;
        }

    }

    // Get user stories with pagination
    app.get("/api/stories", generalLimiter, async (req: any, res) => {
        try {
            const authHeader = req.headers.authorization;

            if (!authHeader || !authHeader.startsWith('Bearer ')) {
                return res.status(401).json({ error: "No token provided" });
            }

            const token = authHeader.split(' ')[1];

            const { data: userData, error } = await supabaseAdmin.auth.getUser(token);

            if (error || !userData.user) {
                return res.status(401).json({ error: "Invalid token" });
            }

            const userId = userData.user.id;

            const page = parseInt(req.query.page as string) || 1;
            const limit = parseInt(req.query.limit as string) || 9;
            const category = req.query.category as string || 'all';

            // Validate page number
            if (isNaN(page) || page < 1) {
                return res.status(400).json({ message: "Invalid page number. Must be a positive integer." });
            }

            // Validate limit number
            if (isNaN(limit) || limit < 1 || limit > 100) {
                return res.status(400).json({ message: "Invalid limit. Must be between 1 and 100." });
            }

            // Validate category if provided
            if (category !== 'all') {
                const validCategories = [
                    "adventure", "romance", "mystery", "comedy", "fantasy",
                    "sci-fi", "drama", "thriller", "historical", "biography",
                    "slice-of-life", "horror"
                ];
                if (!validCategories.includes(category)) {
                    return res.status(400).json({
                        message: "Invalid category. Must be one of: " + validCategories.join(", ")
                    });
                }
            }

            const offset = (page - 1) * limit;

            const result = await storage.getUserStoriesWithPagination(userId, {
                page,
                limit,
                offset,
                category: category === 'all' ? undefined : category
            });

            res.json({
                stories: result.stories,
                total: result.total,
                page,
                limit,
                totalPages: Math.ceil(result.total / limit),
                hasNext: page * limit < result.total,
                hasPrev: page > 1
            });
        } catch (error) {
            console.error("Error fetching stories:", error);
            res.status(500).json({ message: "Failed to fetch stories" });
        }
    });

    // Get single story
    app.get("/api/stories/:id", generalLimiter, async (req: any, res) => {
        try {
            const authHeader = req.headers.authorization;

            if (!authHeader || !authHeader.startsWith('Bearer ')) {
                return res.status(401).json({ error: "No token provided" });
            }

            const token = authHeader.split(' ')[1];

            const { data: userData, error } = await supabaseAdmin.auth.getUser(token);

            if (error || !userData.user) {
                return res.status(401).json({ error: "Invalid token" });
            }

            const userId = userData.user.id;

            const storyId = parseInt(req.params.id);

            if (isNaN(storyId)) {
                return res.status(400).json({ message: "Invalid story ID" });
            }

            const story = await storage.getStory(storyId, userId);

            if (!story) {
                return res.status(404).json({ message: "Story not found" });
            }

            res.json(story);
        } catch (error) {
            console.error("Error fetching story:", error);
            res.status(500).json({ message: "Failed to fetch story" });
        }
    });

    // Get single story template
    app.get("/api/story-templates/:id", generalLimiter, async (req: any, res) => {
        try {
            const authHeader = req.headers.authorization;

            if (!authHeader || !authHeader.startsWith('Bearer ')) {
                return res.status(401).json({ error: "No token provided" });
            }

            const token = authHeader.split(' ')[1];

            const { data: userData, error } = await supabaseAdmin.auth.getUser(token);

            if (error || !userData.user) {
                return res.status(401).json({ error: "Invalid token" });
            }
            const storyId = parseInt(req.params.id);

            if (isNaN(storyId)) {
                return res.status(400).json({ message: "Invalid story ID" });
            }

            const story = await storage.getStoryTemplate(storyId);

            if (!story) {
                return res.status(404).json({ message: "Story template not found" });
            }

            res.json(story);
        } catch (error) {
            console.error("Error fetching story template:", error);
            res.status(500).json({ message: "Failed to fetch story template" });
        }
    });
    // Delete story
    app.delete("/api/stories/:id", generalLimiter, async (req: any, res) => {
        try {
            const authHeader = req.headers.authorization;

            if (!authHeader || !authHeader.startsWith('Bearer ')) {
                return res.status(401).json({ error: "No token provided" });
            }

            const token = authHeader.split(' ')[1];

            const { data: userData, error } = await supabaseAdmin.auth.getUser(token);

            if (error || !userData.user) {
                return res.status(401).json({ error: "Invalid token" });
            }

            const userId = userData.user.id;

            const storyId = parseInt(req.params.id);

            if (isNaN(storyId)) {
                return res.status(400).json({ message: "Invalid story ID" });
            }

            const deleted = await storage.deleteStory(storyId, userId);

            if (!deleted) {
                return res.status(404).json({ message: "Story not found" });
            }

            // Delete associated images from Supabase Storage
            await deleteStoryImages(storyId);

            res.json({ message: "Story deleted successfully" });
        } catch (error) {
            console.error("Error deleting story:", error);
            res.status(500).json({ message: "Failed to delete story" });
        }
    });

    // Delete story
    app.get("/api/story-templates", generalLimiter, async (req: any, res) => {
        try {
            const authHeader = req.headers.authorization;

            if (!authHeader || !authHeader.startsWith('Bearer ')) {
                return res.status(401).json({ error: "No token provided" });
            }

            const token = authHeader.split(' ')[1];

            const { data: userData, error } = await supabaseAdmin.auth.getUser(token);

            if (error || !userData.user) {
                return res.status(401).json({ error: "Invalid token" });
            }

            const page = parseInt(req.query.page as string) || 1;
            const limit = parseInt(req.query.limit as string) || 9;
            const category = req.query.category as string || 'all';

            // Validate page number
            if (isNaN(page) || page < 1) {
                return res.status(400).json({ message: "Invalid page number. Must be a positive integer." });
            }

            // Validate limit number
            if (isNaN(limit) || limit < 1 || limit > 100) {
                return res.status(400).json({ message: "Invalid limit. Must be between 1 and 100." });
            }

            // Validate category if provided
            if (category !== 'all') {
                const validCategories = [
                    "adventure", "romance", "mystery", "comedy", "fantasy",
                    "sci-fi", "drama", "thriller", "historical", "biography",
                    "slice-of-life", "horror"
                ];
                if (!validCategories.includes(category)) {
                    return res.status(400).json({
                        message: "Invalid category. Must be one of: " + validCategories.join(", ")
                    });
                }
            }

            const offset = (page - 1) * limit;

            const result = await storage.getStoryTemplates({
                page,
                limit,
                offset,
                category: category === 'all' ? undefined : category
            });

            res.json({
                storyTemplates: result.storyTemplates,
                total: result.total,
                page,
                limit,
                totalPages: Math.ceil(result.total / limit),
                hasNext: page * limit < result.total,
                hasPrev: page > 1
            });
        } catch (error) {
            console.error("Error fetching stories:", error);
            res.status(500).json({ message: "Failed to fetch stories" });
        }
    });
} 