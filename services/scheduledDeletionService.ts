import cron from 'node-cron';
import { storage } from '../storage';
import { createClient } from '@supabase/supabase-js';

export class ScheduledDeletionService {
    private supabaseAdmin: any;

    constructor() {
        this.supabaseAdmin = createClient(
            process.env.SUPABASE_URL!,
            process.env.SUPABASE_ANON_KEY!
        );
    }

    // Start the scheduled deletion service
    start() {
        console.log('Starting scheduled deletion service...');

        // Run every hour to check for users to delete
        cron.schedule('0 0 * * *', async () => {
            await this.processPendingDeletions();
        });

        // Also run immediately on startup
        this.processPendingDeletions();
    }

    // Process pending deletions
    private async processPendingDeletions() {
        try {
            console.log('Processing pending user deletions...');

            const pendingDeletions = await storage.getPendingDeletions();
            const now = new Date();

            for (const deletion of pendingDeletions) {
                if (deletion.scheduledFor <= now) {
                    await this.deleteUser(deletion.userId);
                }
            }

            console.log(`Processed ${pendingDeletions.length} pending deletions`);
        } catch (error) {
            console.error('Error processing pending deletions:', error);
        }
    }

    // Delete a user and all their data
    private async deleteUser(userId: string) {
        try {
            console.log(`Deleting user ${userId}...`);

            // Delete user stories first
            await storage.deleteStories(userId);

            // Delete user from our database
            await storage.deleteUser(userId);

            // Delete pending deletion record
            await storage.deletePendingDeletion(userId);

            // Delete user from Supabase Auth
            const superAdmin = createClient(
                process.env.SUPABASE_URL!,
                process.env.SUPABASE_SERVICE_ROLE_KEY!
            );

            const { error } = await superAdmin.auth.admin.deleteUser(userId);

            if (error) {
                console.error(`Error deleting user ${userId} from Supabase Auth:`, error);
            } else {
                console.log(`Successfully deleted user ${userId}`);
            }
        } catch (error) {
            console.error(`Error deleting user ${userId}:`, error);
        }
    }

    // Check if a user has a pending deletion
    async hasPendingDeletion(userId: string): Promise<boolean> {
        try {
            const pendingDeletions = await storage.getPendingDeletions();
            return pendingDeletions.some(deletion => deletion.userId === userId);
        } catch (error) {
            console.error('Error checking pending deletion:', error);
            return false;
        }
    }

    // Cancel a user's pending deletion
    async cancelUserDeletion(userId: string): Promise<boolean> {
        try {
            return await storage.cancelUserDeletion(userId);
        } catch (error) {
            console.error('Error canceling user deletion:', error);
            return false;
        }
    }
}

export const scheduledDeletionService = new ScheduledDeletionService(); 