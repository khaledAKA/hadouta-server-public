// Environment and Stripe configuration
export const config = {
  // Environment mode
  NODE_ENV: process.env.NODE_ENV || 'development',
  STRIPE_MODE: process.env.STRIPE_MODE || 'test',

  // Get the appropriate Stripe keys based on mode
  getStripeKeys() {
    const isTestMode = this.STRIPE_MODE === 'test';

    return {
      publicKey: isTestMode
        ? process.env.STRIPE_TEST_PUBLIC_KEY
        : process.env.STRIPE_LIVE_PUBLIC_KEY,
      secretKey: isTestMode
        ? process.env.STRIPE_TEST_SECRET_KEY || process.env.STRIPE_SECRET_KEY
        : process.env.STRIPE_LIVE_SECRET_KEY,
      webhookSecret: isTestMode
        ? process.env.STRIPE_TEST_WEBHOOK_SECRET
        : process.env.STRIPE_LIVE_WEBHOOK_SECRET,
      mode: isTestMode ? 'test' : 'live'
    };
  },

  // Check if we're in test mode
  isTestMode() {
    return this.STRIPE_MODE === 'test';
  }
};

// Validate Stripe configuration on startup
const stripeKeys = config.getStripeKeys();
if (!stripeKeys.secretKey) {
  throw new Error(`Missing Stripe secret key for ${config.STRIPE_MODE} mode`);
}

// Ensure we have a valid secret key
export const stripeConfig = {
  ...stripeKeys,
  secretKey: stripeKeys.secretKey!,
  webhookSecret: stripeKeys.webhookSecret!,
  // Price IDs for different plans (these would be set in production)
  proPriceId: config.isTestMode()
    ? process.env.STRIPE_TEST_PRO_PRICE_ID || 'price_test_pro'
    : process.env.STRIPE_LIVE_PRO_PRICE_ID,
  ultimatePriceId: config.isTestMode()
    ? process.env.STRIPE_TEST_ULTIMATE_PRICE_ID || 'price_test_ultimate'
    : process.env.STRIPE_LIVE_ULTIMATE_PRICE_ID
};