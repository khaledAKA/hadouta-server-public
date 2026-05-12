import type { Express } from "express";
import rateLimit from 'express-rate-limit';
import { supabaseAdmin } from "./supabaseAuth";
import { storage } from "../storage";
import { stripeConfig } from "../config";
import Stripe from "stripe";

const stripe = new Stripe(stripeConfig.secretKey!);

// Rate limiting for subscription operations
const subscriptionLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 20, // limit each IP to 10 subscription operations per windowMs
    message: { error: 'Too many subscription operations, please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
});

export function registerSubscriptionRoutes(app: Express) {
    // Create Stripe checkout session for Pro subscription
    app.post("/api/create-pro-subscription", subscriptionLimiter, async (req: any, res) => {
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

            if (!user?.email) {
                return res.status(400).json({ message: "User email required" });
            }
            // Create or get existing Stripe customer
            let customerId = user.stripeCustomerId;
            if (!customerId) {
                const customer = await stripe.customers.create({
                    email: user.email,
                    metadata: {
                        userId: userId
                    }
                });
                customerId = customer.id;

                // Store the customer ID immediately
                await storage.updateUserStripeInfo(userId, customerId, '');
                console.log(`Created Stripe customer ${customerId} for user ${userId}`);
            }

            const session = await stripe.checkout.sessions.create({
                customer: customerId, // Use customer ID instead of email
                client_reference_id: userId, // This is crucial for webhook processing
                payment_method_types: ['card'],
                allow_promotion_codes: true,
                line_items: [
                    {
                        price_data: {
                            currency: 'usd',
                            product_data: {
                                name: 'Hadouta Pro Plan',
                                description: '50 stories per month, all premium features except AI illustrations',
                            },
                            unit_amount: 699, // $6.99
                            recurring: {
                                interval: 'month',
                            },
                        },
                        quantity: 1,
                    },
                ],
                mode: 'subscription',
                success_url: `https://hadouta.app/subscription?payment_success=true`,
                cancel_url: `https://hadouta.app/subscription?payment_cancelled=true`,
                metadata: {
                    userId: userId,
                    plan: 'pro'
                },
            });

            res.json({ url: session.url });
        } catch (error: any) {
            console.error("Error creating Pro subscription:", error);
            res.status(500).json({ message: "Failed to create subscription" });
        }
    });

    // Create Stripe checkout session for Ultimate subscription
    app.post("/api/create-ultimate-subscription", subscriptionLimiter, async (req: any, res) => {
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

            if (!user?.email) {
                return res.status(400).json({ message: "User email required" });
            }

            // Create or get existing Stripe customer
            let customerId = user.stripeCustomerId;
            if (!customerId) {
                const customer = await stripe.customers.create({
                    email: user.email,
                    metadata: {
                        userId: userId
                    }
                });
                customerId = customer.id;

                // Store the customer ID immediately
                await storage.updateUserStripeInfo(userId, customerId, '');
                console.log(`Created Stripe customer ${customerId} for user ${userId}`);
            }

            const session = await stripe.checkout.sessions.create({
                customer: customerId, // Use customer ID instead of email
                client_reference_id: userId, // This is crucial for webhook processing
                payment_method_types: ['card'],
                allow_promotion_codes: true,
                line_items: [
                    {
                        price_data: {
                            currency: 'usd',
                            product_data: {
                                name: 'Hadouta Ultimate Plan',
                                description: '100 stories per month, all premium features + exclusive AI illustrations',
                            },
                            unit_amount: 1499, // $14.99
                            recurring: {
                                interval: 'month',
                            },
                        },
                        quantity: 1,
                    },
                ],
                mode: 'subscription',
                success_url: `https://hadouta.app/subscription?payment_success=true`,
                cancel_url: `https://hadouta.app/subscription?payment_cancelled=true`,
                metadata: {
                    userId: userId,
                    plan: 'ultimate'
                },
            });

            res.json({ url: session.url });
        } catch (error: any) {
            console.error("Error creating Ultimate subscription:", error);
            res.status(500).json({ message: "Failed to create subscription" });
        }
    });

    // Subscription management route
    app.post('/api/manage-subscription', subscriptionLimiter, async (req: any, res) => {
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

            const { action } = req.body; // action:  'downgrade', 'cancel'

            if (action !== 'downgrade' && action !== 'cancel') {
                return res.status(400).json({ message: "Invalid action" });
            }

            if (!user) {
                return res.status(404).json({ message: "User not found" });
            }

            switch (action) {
                case 'downgrade':
                    try {
                        // Cancel all active Stripe subscriptions
                        if (user.stripeCustomerId) {
                            const subscriptions = await stripe.subscriptions.list({
                                customer: user.stripeCustomerId,
                                status: 'active'
                            });

                            for (const subscription of subscriptions.data) {
                                await stripe.subscriptions.cancel(subscription.id);
                                console.log(`Cancelled Stripe subscription ${subscription.id} for user ${userId}`);
                            }
                        }
                        res.json({
                            success: true,
                            message: "Successfully downgraded to Free plan and cancelled Stripe subscriptions",
                            redirectUrl: '/subscription'
                        });
                    } catch (error: any) {
                        console.error("Error during downgrade:", error);
                        res.json({
                            success: true,
                            message: "Downgraded to Free plan (please check Stripe for subscription status)",
                            redirectUrl: '/subscription'
                        });
                    }
                    break;

                case 'cancel':
                    try {
                        if (user.stripeSubscriptionId) {
                            // Cancel the subscription at period end in Stripe
                            console.log("user.stripeSubscriptionId", user.stripeSubscriptionId);
                            await stripe.subscriptions.update(user.stripeSubscriptionId, {
                                cancel_at_period_end: true
                            });

                            res.json({
                                success: true,
                                message: `Subscription cancelled.`,
                                redirectUrl: '/subscription'
                            });
                        } else {
                            // User doesn't have a Stripe subscription, just downgrade
                            await storage.updateUserSubscriptionInfoDeletingSubscription(userId);

                            res.json({
                                success: true,
                                message: "Subscription cancelled successfully.",
                                redirectUrl: '/subscription'
                            });
                        }
                    } catch (error: any) {
                        console.error("Stripe cancellation error:", error);
                        res.status(500).json({ message: "Failed to cancel subscription with Stripe" });
                    }
                    break;

                default:
                    res.status(400).json({ message: "Invalid action" });
            }
        } catch (error: any) {
            console.error("Subscription management error:", error);
            return res.status(500).json({ error: { message: error.message } });
        }
    });
} 