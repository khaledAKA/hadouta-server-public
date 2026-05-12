import { createClient, SupabaseClient, User } from '@supabase/supabase-js';
import type { Express, RequestHandler } from "express";
import session from "express-session";
import connectPg from "connect-pg-simple";
import rateLimit from 'express-rate-limit';
import { storage } from "../storage";
import { scheduledDeletionService } from "../services/scheduledDeletionService";
import { z } from 'zod';



// Environment variable validation
const envSchema = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(1),
  DATABASE_URL: z.string().min(1),
  SESSION_SECRET: z.string().min(1),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  TURNSTILE_SECRET_KEY: z.string().min(1).optional(),
});

const env = envSchema.parse(process.env);


interface UserData {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  profileImageUrl: string;
}

// Initialize Supabase client
export const supabaseAdmin: SupabaseClient = createClient(
  env.SUPABASE_URL,
  env.SUPABASE_ANON_KEY
);

// Session configuration
const SESSION_TTL = 7 * 24 * 60 * 60 * 1000; // 1 week

// Rate limiting configurations
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 7, // limit each IP to 5 login attempts per windowMs
  message: { error: 'Too many login attempts, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10, // limit each IP to 3 signup attempts per windowMs
  message: { error: 'Too many signup attempts, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

export const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: { error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

export const resetPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // limit each IP to 100 requests per windowMs
  message: { error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

export function getSession() {
  const pgStore = connectPg(session);
  const sessionStore = new pgStore({
    conString: env.DATABASE_URL,
    createTableIfMissing: true,
    ttl: SESSION_TTL,
    tableName: "sessions",
  });

  return session({
    secret: env.SESSION_SECRET,
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: env.NODE_ENV === 'production',
      maxAge: SESSION_TTL,
      sameSite: false,
    },
  });
}

// User management functions
async function upsertUser(user: User): Promise<void> {
  const userData: UserData = {
    id: user.id,
    email: user.email || '',
    firstName: user.user_metadata?.first_name ||
      user.user_metadata?.full_name?.split(' ')[0] || '',
    lastName: user.user_metadata?.last_name ||
      user.user_metadata?.full_name?.split(' ').slice(1).join(' ') || '',
    profileImageUrl: user.user_metadata?.avatar_url ||
      user.user_metadata?.picture || '',
  };

  await storage.upsertUser(userData);
}

// Cloudflare Turnstile verification function
const verifyTurnstileToken = async (token: string, ip: string): Promise<boolean> => {
  try {
    const formData = new URLSearchParams();
    formData.append('secret', process.env.TURNSTILE_SECRET_KEY || '');
    formData.append('response', token);
    formData.append('remoteip', ip);

    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: formData,
    });

    const result = await response.json() as { success: boolean };
    return result.success === true;
  } catch (error) {
    console.error('Turnstile verification error:', error);
    return false;
  }
};

// Auth setup function
export async function setupAuth(app: Express): Promise<void> {
  app.set("trust proxy", 1);
  app.use(getSession());

  // Login endpoint
  app.post("/api/login", loginLimiter, async (req, res) => {
    try {
      const { email, password, captchaToken } = req.body;

      if (!email || !password) {
        return res.status(400).json({ error: 'Email and password required' });
      }

      // Check email format
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email)) {
        return res.status(400).json({ error: 'Invalid email format' });
      }

      if (!captchaToken) {
        return res.status(400).json({ error: 'Captcha verification required' });
      }

      const forwardedFor = req.headers['x-forwarded-for'];
      const clientIp = req.ip || (Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor) || req.socket.remoteAddress || '';
      const isCaptchaValid = await verifyTurnstileToken(captchaToken, clientIp);

      if (!isCaptchaValid) {
        return res.status(400).json({ error: 'Captcha verification failed. Please try again.' });
      }

      const { data, error } = await supabaseAdmin.auth.signInWithPassword({
        email,
        password,
      });

      if (error) {
        return res.status(401).json({ error: error.message });
      }

      if (!data.session || !data.user) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      // Check if user has a pending deletion and cancel it
      const hasPendingDeletion = await scheduledDeletionService.hasPendingDeletion(data.user.id);
      if (hasPendingDeletion) {
        await scheduledDeletionService.cancelUserDeletion(data.user.id);
        console.log(`Cancelled pending deletion for user ${data.user.id}`);
      }

      return res.status(200).json({
        success: true,
        token: data.session.access_token,
        user: data.user,
        refreshToken: data.session.refresh_token,
        deletionCancelled: hasPendingDeletion
      });
    } catch (error) {
      console.error('Login error:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Sign up endpoint
  app.post("/api/signup", signupLimiter, async (req, res) => {
    try {
      const { email, password, firstName, lastName, captchaToken } = req.body;

      if (!email || !password) {
        return res.status(400).json({ error: 'Email and password required' });
      }
      // Validate field lengths
      if (!firstName || !lastName) {
        return res.status(400).json({ error: 'First name and last name are required' });
      }

      if (firstName.length > 20) {
        return res.status(400).json({ error: 'First name must be 20 characters or less' });
      }

      if (lastName.length > 20) {
        return res.status(400).json({ error: 'Last name must be 20 characters or less' });
      }

      if (email.length > 255) {
        return res.status(400).json({ error: 'Email must be 255 characters or less' });
      }

      // Check email format
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email)) {
        return res.status(400).json({ error: 'Invalid email format' });
      }

      if (password.length < 6) {
        return res.status(400).json({ error: 'Password must be at least 6 characters' });
      }

      if (password.length > 72) {
        return res.status(400).json({ error: 'Password must be 72 characters or less' });
      }

      // Validate password complexity
      const hasUpperCase = /[A-Z]/.test(password);
      const hasLowerCase = /[a-z]/.test(password);
      const hasNumbers = /[0-9]/.test(password);

      if (!hasUpperCase || !hasLowerCase || !hasNumbers) {
        return res.status(400).json({
          error: 'Password must contain at least one uppercase letter, one lowercase letter, and one number'
        });
      }
      // Verify captcha token
      if (!captchaToken) {
        return res.status(400).json({ error: 'Captcha verification required' });
      }

      const forwardedFor = req.headers['x-forwarded-for'];
      const clientIp = req.ip || (Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor) || req.socket.remoteAddress || '';
      const isCaptchaValid = await verifyTurnstileToken(captchaToken, clientIp);

      if (!isCaptchaValid) {
        return res.status(400).json({ error: 'Captcha verification failed. Please try again.' });
      }

      // Check if user already exists and has a pending deletion
      try {
        const { data: existingUser } = await supabaseAdmin.auth.admin.listUsers();
        const userWithEmail = existingUser.users.find(user => user.email === email);

        if (userWithEmail) {
          // Check if this user has a pending deletion
          const hasPendingDeletion = await scheduledDeletionService.hasPendingDeletion(userWithEmail.id);

          if (hasPendingDeletion) {
            return res.status(400).json({
              error: 'An account with this email was recently deleted. Please wait 14 days before creating a new account with this email, or contact support if you need immediate access.'
            });
          }
        }
      } catch (error) {
        // If we can't check existing users, continue with signup
        console.warn('Could not check existing users:', error);
      }

      const { data, error } = await supabaseAdmin.auth.signUp({
        email,
        password,
        options: {
          data: {
            first_name: firstName,
            last_name: lastName,
          }
        }
      });

      if (error) {
        return res.status(400).json({ error: error.message });
      }

      if (!data.user) {
        return res.status(400).json({ error: 'User creation failed' });
      }

      await upsertUser(data.user);

      return res.status(200).json({ success: true });
    } catch (error) {
      console.error('Signup error:', error);
      return res.status(500).json({ error: 'Failed to sign up, check your email and password and try again.' });
    }
  });

  // Logout endpoint
  app.get("/api/logout", generalLimiter, async (req, res) => {
    try {
      const authHeader = req.headers.authorization;

      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ message: "No token provided" });
      }

      const token = authHeader.split(' ')[1];
      const { data: userData, error } = await supabaseAdmin.auth.getUser(token);

      if (error || !userData.user) {
        return res.status(401).json({ message: "Invalid token" });
      }

      await supabaseAdmin.auth.admin.signOut(token);

      req.session.destroy((err) => {
        if (err) {
          console.error('Session destruction error:', err);
          return res.status(500).json({ error: 'Failed to destroy session' });
        }
      });

      return res.status(200).json({ message: "Logged out successfully" });
    } catch (error) {
      console.error('Logout error:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Get current user endpoint
  app.get("/api/user/:refresh_token?", generalLimiter, async (req, res) => {
    try {
      const authHeader = req.headers.authorization;

      const refreshToken = req.query.refresh_token as string;
      if (!authHeader || !authHeader.startsWith('Bearer ') || !refreshToken) {
        return res.status(401).json({ error: "No token provided" });
      }

      // Refresh the session token
      const { data: sessionData, error: sessionError } = await supabaseAdmin.auth.refreshSession({
        refresh_token: refreshToken
      });


      const token = sessionData.session?.access_token;

      const { data: userData, error } = await supabaseAdmin.auth.getUser(token);

      if (error || !userData.user) {
        return res.status(401).json({ error: "Invalid token" });
      }

      if (sessionError) {
        return res.status(401).json({ error: "Failed to refresh token" });
      }

      const user = await storage.getUser(userData.user.id);
      return res.json({ user, token });
    } catch (error) {
      console.error('Get user error:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.put("/api/update-user", generalLimiter, async (req, res) => {
    try {
      const { firstName, lastName } = req.body;
      const authHeader = req.headers.authorization;

      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: "No token provided" });
      }

      const token = authHeader.split(' ')[1];

      const { data: userData, error } = await supabaseAdmin.auth.getUser(token);

      if (error || !userData.user) {
        return res.status(401).json({ error: "Invalid token" });
      }

      if (!firstName || !lastName) {
        return res.status(400).json({ error: "First name and last name are required" });
      }

      if (firstName.length > 20 || lastName.length > 20) {
        return res.status(400).json({ error: "First name and last name must be less than 20 characters" });
      }

      await storage.updateUser({
        id: userData.user.id,
        firstName: firstName,
        lastName: lastName,
      });
      return res.status(200).json({ message: "User updated successfully" });
    } catch (error) {
      console.error('Update user error:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Password reset request endpoint
  app.post("/api/request-password-reset", generalLimiter, async (req, res) => {
    try {
      const { email, captchaToken } = req.body;
      if (!email) {
        return res.status(400).json({ error: 'Email is required' });
      }
      // Verify captcha token
      if (!captchaToken) {
        return res.status(400).json({ error: 'Captcha verification required' });
      }

      const forwardedFor = req.headers['x-forwarded-for'];
      const clientIp = req.ip || (Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor) || req.socket.remoteAddress || '';
      const isCaptchaValid = await verifyTurnstileToken(captchaToken, clientIp);

      if (!isCaptchaValid) {
        return res.status(400).json({ error: 'Captcha verification failed. Please try again.' });
      }
      // Check email format
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email)) {
        return res.status(400).json({ error: 'Invalid email format' });
      }

      if (email.length > 255) {
        return res.status(400).json({ error: 'Email must be 255 characters or less' });
      }
      // Always return success for security
      await supabaseAdmin.auth.resetPasswordForEmail(email, {
        redirectTo: process.env.PASSWORD_RESET_REDIRECT_URL || 'http://localhost:3000/reset-password',
      });
      return res.status(200).json({ message: 'If the email exists, a password reset link has been sent.' });
    } catch (error) {
      console.error('Request password reset error:', error);
      // Always return success for security
      return res.status(200).json({ message: 'If the email exists, a password reset link has been sent.' });
    }
  });

  // Password reset endpoint
  app.post("/api/reset-password", resetPasswordLimiter, async (req, res) => {
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

      const { newPassword, captchaToken } = req.body;

      if (!newPassword || !captchaToken) {
        return res.status(400).json({ error: 'New password, and captcha are required' });
      }

      // Verify captcha token
      const forwardedFor = req.headers['x-forwarded-for'];
      const clientIp = req.ip || (Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor) || req.socket.remoteAddress || '';
      const isCaptchaValid = await verifyTurnstileToken(captchaToken, clientIp);

      if (!isCaptchaValid) {
        return res.status(400).json({ error: 'Captcha verification failed. Please try again.' });
      }

      // Validate password
      if (newPassword.length < 6) {
        return res.status(400).json({ error: 'Password must be at least 6 characters' });
      }
      if (newPassword.length > 72) {
        return res.status(400).json({ error: 'Password must be 72 characters or less' });
      }
      const hasUpperCase = /[A-Z]/.test(newPassword);
      const hasLowerCase = /[a-z]/.test(newPassword);
      const hasNumbers = /[0-9]/.test(newPassword);
      if (!hasUpperCase || !hasLowerCase || !hasNumbers) {
        return res.status(400).json({
          error: 'Password must contain at least one uppercase letter, one lowercase letter, and one number'
        });
      }

      const superAdmin = createClient(
        process.env.SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!,
      );

      // 2. Update the user's password by user ID (Admin privilege)
      const { error: updateError } = await superAdmin.auth.admin.updateUserById(userData.user.id, {
        password: newPassword,
      });
      if (updateError) {
        return res.status(400).json({ error: updateError.message });
      }

      return res.status(200).json({ message: 'Password has been reset successfully.' });
    } catch (error) {
      console.error('Reset password error:', error);
      return res.status(500).json({ error: 'Failed to reset password.' });
    }
  });


  // Account deletion route
  app.delete('/api/delete-account', generalLimiter, async (req: any, res) => {
    try {
      const authHeader = req.headers.authorization;

      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: "No token provided" });
      }

      const token = authHeader.split(' ')[1];

      // Verify the user's token
      const { data: userData, error } = await supabaseAdmin.auth.getUser(token);

      if (error || !userData.user) {
        return res.status(401).json({ error: "Invalid token" });
      }

      // Schedule deletion for 14 days from now
      const scheduledFor = new Date();
      scheduledFor.setDate(scheduledFor.getDate() + 14);

      await storage.scheduleUserDeletion(userData.user.id, scheduledFor);

      // Clear user session
      req.session.destroy((err: any) => {
        if (err) {
          console.error('Error destroying session:', err);
        }
      });

      return res.status(200).json({
        message: 'Account scheduled for deletion. You can log in again within 14 days to cancel this action.',
        scheduledFor: scheduledFor.toISOString()
      });

    } catch (error) {
      console.error('Delete account error:', error);
      return res.status(500).json({ error: 'Failed to schedule account deletion' });
    }
  });
}