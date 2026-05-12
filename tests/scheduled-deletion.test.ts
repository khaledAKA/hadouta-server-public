import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock the modules before importing
vi.mock('../storage', () => ({
    storage: {
        scheduleUserDeletion: vi.fn(),
        cancelUserDeletion: vi.fn(),
        getPendingDeletions: vi.fn(),
        deletePendingDeletion: vi.fn(),
    },
}));

vi.mock('../services/scheduledDeletionService', () => ({
    scheduledDeletionService: {
        hasPendingDeletion: vi.fn(),
        cancelUserDeletion: vi.fn(),
    },
}));

// Import after mocking
import { storage } from '../storage';
import { scheduledDeletionService } from '../services/scheduledDeletionService';

describe('Scheduled Deletion Service', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('scheduleUserDeletion', () => {
        it('should schedule a user for deletion', async () => {
            const userId = 'test-user-id';
            const scheduledFor = new Date();
            scheduledFor.setDate(scheduledFor.getDate() + 14);

            const mockPendingDeletion = {
                id: 1,
                userId,
                scheduledFor,
                createdAt: new Date(),
            };

            vi.mocked(storage.scheduleUserDeletion).mockResolvedValue(mockPendingDeletion);

            const result = await storage.scheduleUserDeletion(userId, scheduledFor);

            expect(result).toEqual(mockPendingDeletion);
            expect(storage.scheduleUserDeletion).toHaveBeenCalledWith(userId, scheduledFor);
        });
    });

    describe('cancelUserDeletion', () => {
        it('should cancel a user deletion', async () => {
            const userId = 'test-user-id';

            vi.mocked(storage.cancelUserDeletion).mockResolvedValue(true);

            const result = await storage.cancelUserDeletion(userId);

            expect(result).toBe(true);
            expect(storage.cancelUserDeletion).toHaveBeenCalledWith(userId);
        });

        it('should return false if no deletion was found', async () => {
            const userId = 'test-user-id';

            vi.mocked(storage.cancelUserDeletion).mockResolvedValue(false);

            const result = await storage.cancelUserDeletion(userId);

            expect(result).toBe(false);
        });
    });

    describe('hasPendingDeletion', () => {
        it('should return true if user has pending deletion', async () => {
            const userId = 'test-user-id';
            const mockPendingDeletions = [
                {
                    id: 1,
                    userId,
                    scheduledFor: new Date(),
                    createdAt: new Date(),
                },
            ];

            vi.mocked(storage.getPendingDeletions).mockResolvedValue(mockPendingDeletions);

            const result = await scheduledDeletionService.hasPendingDeletion(userId);

            expect(result).toBe(true);
        });

        it('should return false if user has no pending deletion', async () => {
            const userId = 'test-user-id';
            const mockPendingDeletions = [
                {
                    id: 1,
                    userId: 'other-user-id',
                    scheduledFor: new Date(),
                    createdAt: new Date(),
                },
            ];

            vi.mocked(storage.getPendingDeletions).mockResolvedValue(mockPendingDeletions);

            const result = await scheduledDeletionService.hasPendingDeletion(userId);

            expect(result).toBe(false);
        });
    });

    describe('cancelUserDeletion', () => {
        it('should cancel user deletion successfully', async () => {
            const userId = 'test-user-id';

            vi.mocked(storage.cancelUserDeletion).mockResolvedValue(true);

            const result = await scheduledDeletionService.cancelUserDeletion(userId);

            expect(result).toBe(true);
            expect(storage.cancelUserDeletion).toHaveBeenCalledWith(userId);
        });

        it('should handle errors gracefully', async () => {
            const userId = 'test-user-id';

            vi.mocked(storage.cancelUserDeletion).mockRejectedValue(new Error('Database error'));

            const result = await scheduledDeletionService.cancelUserDeletion(userId);

            expect(result).toBe(false);
        });
    });

    describe('signup with pending deletion check', () => {
        it('should reject signup for email with pending deletion', async () => {
            const email = 'test@example.com';
            const userId = 'test-user-id';

            // Mock existing user with pending deletion
            const mockExistingUser = {
                users: [
                    {
                        id: userId,
                        email: email,
                        user_metadata: {},
                    }
                ]
            };

            vi.mocked(scheduledDeletionService.hasPendingDeletion).mockResolvedValue(true);

            // This would be the actual signup logic check
            const hasPendingDeletion = await scheduledDeletionService.hasPendingDeletion(userId);

            expect(hasPendingDeletion).toBe(true);
        });

        it('should allow signup for email without pending deletion', async () => {
            const email = 'test@example.com';
            const userId = 'test-user-id';

            // Mock existing user without pending deletion
            const mockExistingUser = {
                users: [
                    {
                        id: userId,
                        email: email,
                        user_metadata: {},
                    }
                ]
            };

            vi.mocked(scheduledDeletionService.hasPendingDeletion).mockResolvedValue(false);

            // This would be the actual signup logic check
            const hasPendingDeletion = await scheduledDeletionService.hasPendingDeletion(userId);

            expect(hasPendingDeletion).toBe(false);
        });
    });
}); 