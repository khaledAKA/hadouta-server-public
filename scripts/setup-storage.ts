import { initializeStorageBucket } from '../image-storage.js';

async function setupStorage() {
    try {
        console.log('Setting up Supabase storage bucket...');
        await initializeStorageBucket();
        console.log('Storage setup completed successfully!');
        process.exit(0);
    } catch (error) {
        console.error('Storage setup failed:', error);
        process.exit(1);
    }
}

setupStorage(); 