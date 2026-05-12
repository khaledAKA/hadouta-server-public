import type { Express } from "express";
import { stripeConfig } from "../config";
import { storage } from "../storage";
import Stripe from "stripe";

const stripe = new Stripe(stripeConfig.secretKey!);
const webhookSecret = stripeConfig.webhookSecret!;

export function registerWebhookRoutes(app: Express) {
    // Handle Stripe webhook events
    app.post("/api/stripe-webhook", async (req, res) => {
        const sig = req.headers['stripe-signature'];

        if (!sig) {
            return res.status(400).json({ message: "No signature found" });
        }

        let event: Stripe.Event;

        try {
            event = stripe.webhooks.constructEvent(
                req.body,
                sig,
                webhookSecret
            );
        } catch (err: any) {
            console.error(`Webhook signature verification failed: ${err.message}`);
            return res.status(400).json({ message: `Webhook Error: ${err.message}` });
        }
        try {
            console.log("Khaaaaaaaled", event);
            switch (event.type) {
                // updating the existing subscriptions
                case 'invoice.paid': {
                    const invoice = event.data.object as Stripe.Invoice;
                    const expireAt = invoice.created + (30 * 24 * 60 * 60);
                    const customerId = invoice.customer as string;
                    const user = await storage.getUserByStripeCustomerId(customerId);
                    const userId = user?.id;
                    let plan = "free";
                    if (invoice.status === "paid") {
                        if (invoice.subtotal === 1499) {
                            plan = "ultimate";
                        }
                        if (invoice.subtotal === 699) {
                            plan = "pro";
                        }
                    }
                    if (!userId || !plan) {
                        console.error('Missing userId or plan in session metadata');
                        return res.status(400).json({ message: "Missing required metadata" });
                    }

                    // Update user subscription status
                    await storage.updateUserSubscriptionInfoAfterPaymentSucceeded(userId, plan, expireAt);
                    console.log(`Updated subscription for user ${userId} to ${plan}`);
                    break;

                }
                // creating new subscriptions
                case 'checkout.session.async_payment_succeeded': {
                    const session = event.data.object as Stripe.Checkout.Session;
                    const stripeSubscriptionId = session.subscription as string;
                    const expireAt = session.created + (30 * 24 * 60 * 60);
                    const userId = session.client_reference_id;
                    const plan = session.metadata?.plan;
                    const paid = session.payment_status === "paid";

                    if (!userId || !plan || !stripeSubscriptionId || !paid) {
                        console.error('Missing userId or plan in session metadata');
                        return res.status(400).json({ message: "Missing required metadata" });
                    }

                    // Update user subscription status
                    await storage.updateUserSubscriptionInfoAfterCheckoutCompleted(userId, plan, stripeSubscriptionId, expireAt);
                    console.log(`Updated subscription for user ${userId} to ${plan}`);
                    break;
                }

                // creating new subscriptions
                case 'checkout.session.completed': {
                    const session = event.data.object as Stripe.Checkout.Session;
                    const stripeSubscriptionId = session.subscription as string;
                    const expireAt = session.created + (30 * 24 * 60 * 60);
                    const userId = session.client_reference_id;
                    const plan = session.metadata?.plan;
                    const paid = session.payment_status === "paid";
                    console.log("Khaaaaaaaled", session);

                    if (!userId || !plan || !stripeSubscriptionId || !paid) {
                        console.error('Missing userId or plan in session metadata');
                        return res.status(400).json({ message: "Missing required metadata" });
                    }

                    // Update user subscription status
                    await storage.updateUserSubscriptionInfoAfterCheckoutCompleted(userId, plan, stripeSubscriptionId, expireAt);
                    console.log(`Updated subscription for user ${userId} to ${plan}`);
                    break;
                }

                case 'customer.subscription.updated': {
                    const subscription = event.data.object as Stripe.Subscription;
                    const customerId = subscription.customer as string;
                    const isCanceled = subscription.cancel_at_period_end;

                    // Get user by Stripe customer ID
                    const user = await storage.getUserByStripeCustomerId(customerId);
                    if (!user) {
                        console.error(`No user found for Stripe customer ${customerId}`);
                        return res.status(404).json({ message: "User not found" });
                    }

                    // Update subscription status based on Stripe status
                    if (subscription.status === 'active' && isCanceled) {
                        await storage.updateUserSubscriptionStatusAfterCanceled(user.id);
                        console.log(`Updated subscription status for user ${user.id} to canceled`);
                    }
                    break;
                }

                case 'customer.subscription.deleted': {
                    const subscription = event.data.object as Stripe.Subscription;
                    const customerId = subscription.customer as string;

                    // Get user by Stripe customer ID
                    const user = await storage.getUserByStripeCustomerId(customerId);
                    if (!user) {
                        console.error(`No user found for Stripe customer ${customerId}`);
                        return res.status(404).json({ message: "User not found" });
                    }

                    // Downgrade user to free plan
                    await storage.updateUserSubscriptionInfoDeletingSubscription(user.id);
                    console.log(`Downgraded user ${user.id} to free plan after subscription deletion`);
                    break;
                }

                case 'invoice.overdue': {
                    const invoice = event.data.object as Stripe.Invoice;
                    const customerId = invoice.customer as string;

                    // Get user by Stripe customer ID
                    const user = await storage.getUserByStripeCustomerId(customerId);
                    if (!user) {
                        console.error(`No user found for Stripe customer ${customerId}`);
                        return res.status(404).json({ message: "User not found" });
                    }

                    if (user.stripeCustomerId) {
                        const subscriptions = await stripe.subscriptions.list({
                            customer: user.stripeCustomerId,
                            status: 'active'
                        });

                        for (const subscription of subscriptions.data) {
                            await stripe.subscriptions.cancel(subscription.id);
                        }
                    }
                    break;
                }

                default:
                    console.log(`Unhandled event type: ${event.type}`);
            }

            res.json({ received: true });
        } catch (error: any) {
            console.error('Error processing webhook:', error);
            res.status(500).json({ message: `Webhook processing failed: ${error.message}` });
        }
    });
} 