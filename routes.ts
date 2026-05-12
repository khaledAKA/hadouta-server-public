import type { Express } from "express";
import { createServer, type Server } from "http";
import { setupAuth } from "./routes/supabaseAuth";

import { stripeConfig } from "./config";
import { registerWebhookRoutes } from "routes/stripeWebhook";
import { registerStoryRoutes } from "routes/story";
import { registerSubscriptionRoutes } from "routes/subscription";

console.log(`🔧 Using Stripe secret key: ${stripeConfig.secretKey?.substring(0, 7)}...`);
console.log(`🔧 Stripe mode: ${stripeConfig.mode}`);
console.log(`🔑 Using ${stripeConfig.mode} keys`);
console.log(`🔑 Secret key starts with: ${stripeConfig.secretKey?.substring(0, 12)}...`);

export async function registerRoutes(app: Express): Promise<Server> {
  // Auth middleware
  await setupAuth(app);

  // Register webhook routes
  registerWebhookRoutes(app);

  // Register story routes
  registerStoryRoutes(app);

  // Register subscription routes
  registerSubscriptionRoutes(app);

  // Register Subscription routes
  registerSubscriptionRoutes(app);

  const httpServer = createServer(app);
  return httpServer;
}