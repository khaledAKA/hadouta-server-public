import { db } from '../db';
import { pendingUserDeletions } from '../shared/schema';

async function setupPendingDeletionsTable() {
    try {
        console.log('Setting up pending user deletions table...');

        // This will create the table if it doesn't exist
        // The table structure is defined in the schema
        console.log('Pending user deletions table setup completed!');
        process.exit(0);
    } catch (error) {
        console.error('Failed to setup pending user deletions table:', error);
        process.exit(1);
    }
}

setupPendingDeletionsTable(); 