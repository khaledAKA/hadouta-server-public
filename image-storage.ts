import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import sharp from 'sharp';

// Load environment variables
dotenv.config();

// Initialize Supabase client for storage
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl) {
  throw new Error('SUPABASE_URL environment variable is required');
}

if (!supabaseServiceKey) {
  throw new Error('SUPABASE_SERVICE_ROLE_KEY or SUPABASE_ANON_KEY environment variable is required');
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);

// Storage bucket name for illustrations
const ILLUSTRATIONS_BUCKET = 'hadouta';

// Function to compress image to minimum size while maintaining quality
export async function compressImage(base64Data: string): Promise<Buffer> {
  try {
    // Remove data URL prefix if present
    const cleanBase64 = base64Data.replace(/^data:image\/\w+;base64,/, '');
    const inputBuffer = Buffer.from(cleanBase64, 'base64');

    // Compress image with sharp
    const compressedBuffer = await sharp(inputBuffer)
      .resize(800, 600, { // Resize to reasonable dimensions
        fit: 'inside',
        withoutEnlargement: true // Don't enlarge if already smaller
      })
      .jpeg({
        quality: 80, // Good balance between quality and size
        progressive: true, // Progressive JPEG for better compression
        mozjpeg: true // Use mozjpeg for better compression
      })
      .toBuffer();

    // If compressed size is still too large, compress more aggressively
    if (compressedBuffer.length > 524288) { // 512KB
      const aggressiveBuffer = await sharp(inputBuffer)
        .resize(600, 450, { // Smaller dimensions
          fit: 'inside',
          withoutEnlargement: true
        })
        .jpeg({
          quality: 60, // Lower quality
          progressive: true,
          mozjpeg: true
        })
        .toBuffer();

      // If still too large, use very aggressive compression
      if (aggressiveBuffer.length > 524288) {
        return await sharp(inputBuffer)
          .resize(400, 300, { // Very small dimensions
            fit: 'inside',
            withoutEnlargement: true
          })
          .jpeg({
            quality: 40, // Low quality but still acceptable
            progressive: true,
            mozjpeg: true
          })
          .toBuffer();
      }

      return aggressiveBuffer;
    }

    return compressedBuffer;
  } catch (error) {
    console.error('Error compressing image:', error);
    // Fallback to original image if compression fails
    const cleanBase64 = base64Data.replace(/^data:image\/\w+;base64,/, '');
    return Buffer.from(cleanBase64, 'base64');
  }
}

export async function StoreImage(imageBase64: string, storyId: number, imageIndex: number): Promise<string> {
  try {
    // Generate filename with UUID and timestamp for uniqueness
    const filename = `${crypto.randomUUID()}_${Date.now()}.jpg`;
    const filePath = `${storyId}/${filename}`;

    // Compress image before uploading
    const compressedBuffer = await compressImage(imageBase64);

    // Log compression results
    const originalSize = Math.round(Buffer.from(imageBase64.replace(/^data:image\/\w+;base64,/, ''), 'base64').length / 1024);
    const compressedSize = Math.round(compressedBuffer.length / 1024);
    console.log(`Image compression: ${originalSize}KB → ${compressedSize}KB (${Math.round((1 - compressedSize / originalSize) * 100)}% reduction)`);

    // Upload compressed buffer to Supabase Storage
    const { data, error } = await supabase.storage
      .from(ILLUSTRATIONS_BUCKET)
      .upload(filePath, compressedBuffer, {
        contentType: 'image/jpeg',
        upsert: true,
        cacheControl: '3600'
      });

    if (error) {
      console.error('Supabase storage upload error:', error);
      throw new Error(`Failed to upload image to Supabase: ${error.message}`);
    }

    // Get public URL
    const { data: urlData } = supabase.storage
      .from(ILLUSTRATIONS_BUCKET)
      .getPublicUrl(filePath);

    if (!urlData.publicUrl) {
      throw new Error('Failed to get public URL for uploaded image');
    }

    // Return the CDN URL
    return urlData.publicUrl;
  } catch (error) {
    console.error('Error storing image:', error);
    throw error; // Re-throw to handle in calling function
  }
}

export async function downloadAndStoreImages(imageBase64s: string[], storyId: number): Promise<string[]> {
  const storedImages: string[] = [];

  for (let i = 0; i < imageBase64s.length; i++) {
    const storedUrl = await StoreImage(imageBase64s[i], storyId, i);
    storedImages.push(storedUrl);
  }

  return storedImages;
}

// Helper function to delete images from Supabase Storage
export async function deleteStoryImages(storyId: number): Promise<void> {
  try {
    // List all files in the story's folder
    const { data: files, error: listError } = await supabase.storage
      .from(ILLUSTRATIONS_BUCKET)
      .list(`${storyId}`);

    if (listError) {
      console.error('Error listing story images:', listError);
      return;
    }

    if (files && files.length > 0) {
      // Delete all files in the story's folder
      const filePaths = files.map(file => `${storyId}/${file.name}`);

      const { error: deleteError } = await supabase.storage
        .from(ILLUSTRATIONS_BUCKET)
        .remove(filePaths);

      if (deleteError) {
        console.error('Error deleting story images:', deleteError);
      } else {
        console.log(`Deleted ${filePaths.length} images for story ${storyId}`);
      }
    }
  } catch (error) {
    console.error('Error in deleteStoryImages:', error);
  }
}

// Helper function to initialize storage bucket (run once during setup)
export async function initializeStorageBucket(): Promise<void> {
  try {
    // Check if bucket exists
    const { data: buckets, error: listError } = await supabase.storage.listBuckets();

    if (listError) {
      console.error('Error listing buckets:', listError);
      return;
    }

    const bucketExists = buckets?.some(bucket => bucket.name === ILLUSTRATIONS_BUCKET);

    if (!bucketExists) {
      // Create bucket if it doesn't exist
      const { error: createError } = await supabase.storage.createBucket(ILLUSTRATIONS_BUCKET, {
        public: true, // Make bucket public for direct access
        fileSizeLimit: 10 * 1024 * 1024, // 10MB limit
        allowedMimeTypes: ['image/png', 'image/jpeg', 'image/jpg', 'image/webp'],
      });

      if (createError) {
        console.error('Error creating storage bucket:', createError);
      } else {
        console.log(`Created storage bucket: ${ILLUSTRATIONS_BUCKET}`);
      }
    } else {
      console.log(`Storage bucket ${ILLUSTRATIONS_BUCKET} already exists`);
    }
  } catch (error) {
    console.error('Error initializing storage bucket:', error);
  }
}