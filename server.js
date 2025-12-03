// TalkProfit Stripe Payment Server
// Optimized for Railway deployment

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// Initialize Supabase client
const supabaseUrl = process.env.VITE_SUPABASE_URL || 'https://jivutwbpnbphxyfwzyua.supabase.co';
const supabaseKey = process.env.VITE_SUPABASE_PUBLISHABLE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImppdnV0d2JwbmJwaHh5Znd6eXVhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjIyNzkzMDIsImV4cCI6MjA3Nzg1NTMwMn0.w00O4oiS-hrlznCOW5R6s9x-pn2fk4dCvtFAGT3OQtU';
const supabase = createClient(supabaseUrl, supabaseKey);

// Trust proxy for rate limiting (Railway, Heroku, etc.)
app.set('trust proxy', 1);

// Security middleware
app.use(helmet());

// Rate limiting - prevent abuse
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: { error: 'Too many requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

// Payment-specific rate limiting
const paymentLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 5, // Max 5 payment attempts per minute per IP
  message: { error: 'Too many payment attempts, please wait before trying again' },
});

// CORS configuration for production
const corsOptions = {
  origin: [
    'http://localhost:5173',
    'http://localhost:3000',
    'http://localhost:8080',  // Added for your current dev setup
    'https://talk-profit-link.vercel.app', // Add your production frontend URL
    process.env.FRONTEND_URL,
    process.env.ALLOWED_ORIGIN
  ].filter(Boolean),
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: false
};

app.use(cors(corsOptions));

// Webhook endpoint needs raw body, other endpoints need JSON
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '10mb' }));

// Health check endpoint for Railway
app.get('/', (req, res) => {
  res.json({ 
    status: 'TalkProfit Payment Server Running',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development'
  });
});

// Health check specifically for Railway
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'healthy' });
});

// Create Payment Intent endpoint
app.post('/create-payment-intent', paymentLimiter, async (req, res) => {
  try {
    const { amount, currency = 'usd', userId } = req.body;

    // Comprehensive validation
    if (!process.env.STRIPE_SECRET_KEY) {
      console.error('❌ STRIPE_SECRET_KEY not configured');
      return res.status(500).json({ error: 'Payment service not configured' });
    }

    if (!amount || typeof amount !== 'number') {
      return res.status(400).json({ error: 'Invalid amount format' });
    }

    if (amount < 100) { // Minimum $1.00
      return res.status(400).json({ error: 'Minimum amount is $1.00' });
    }

    if (amount > 100000) { // Maximum $1000.00
      return res.status(400).json({ error: 'Maximum amount is $1000.00' });
    }

    if (!userId || typeof userId !== 'string') {
      return res.status(400).json({ error: 'Valid user ID required' });
    }

    console.log(`🔄 Creating payment intent: $${amount/100} for user ${userId}`);

    // Create PaymentIntent with Stripe
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amount, // Amount in cents
      currency: currency,
      metadata: {
        userId: userId,
        type: 'credit_topup',
        timestamp: new Date().toISOString(),
        source: 'talkprofit_web'
      },
      automatic_payment_methods: {
        enabled: true,
      },
      description: `TalkProfit Credit Top-up: $${(amount/100).toFixed(2)}`,
    });

    console.log(`✅ Payment intent created: ${paymentIntent.id}`);

    res.json({
      client_secret: paymentIntent.client_secret,
      payment_intent_id: paymentIntent.id,
    });
  } catch (error) {
    console.error('❌ Error creating payment intent:', error);
    
    // Handle specific Stripe errors
    if (error.code === 'api_key_invalid') {
      return res.status(500).json({ error: 'Payment service configuration error' });
    }
    
    if (error.code === 'rate_limit') {
      return res.status(429).json({ error: 'Service temporarily busy, please try again' });
    }

    res.status(500).json({ 
      error: 'Unable to process payment request',
      message: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Create Stripe Connect Express account
app.post('/stripe/create-express-account', paymentLimiter, async (req, res) => {
  try {
    const { email } = req.body;

    if (!email || typeof email !== 'string') {
      return res.status(400).json({ error: 'Valid email required' });
    }

    console.log(`🔄 Creating Stripe Express account for email: ${email}`);

    // Create Stripe Express account
    const account = await stripe.accounts.create({
      type: 'express',
      email: email,
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true },
      },
      business_type: 'individual',
    });

    console.log(`✅ Stripe Express account created: ${account.id}`);

    res.json({
      accountId: account.id,
      message: 'Express account created successfully'
    });
  } catch (error) {
    console.error('❌ Error creating Express account:', error);
    res.status(500).json({ 
      error: 'Failed to create Express account',
      message: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Create account onboarding link
app.post('/stripe/create-account-link', paymentLimiter, async (req, res) => {
  try {
    const { accountId, returnUrl, refreshUrl } = req.body;

    if (!accountId || typeof accountId !== 'string') {
      return res.status(400).json({ error: 'Valid account ID required' });
    }

    console.log(`🔄 Creating account link for: ${accountId}`);

    // First, check if the account still exists and is valid
    try {
      const account = await stripe.accounts.retrieve(accountId);
      console.log(`📊 Account retrieved: ${account.id}, type: ${account.type}`);
    } catch (accountError) {
      console.error('❌ Account not found or invalid:', accountError);
      return res.status(400).json({ 
        error: 'Invalid Stripe Connect account',
        message: 'The account ID provided is not valid or no longer exists'
      });
    }

    // Create account link for onboarding
    const accountLink = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: refreshUrl || `${process.env.FRONTEND_URL || 'http://localhost:5173'}/settings?stripe_refresh=true`,
      return_url: returnUrl || `${process.env.FRONTEND_URL || 'http://localhost:5173'}/settings?stripe_return=true`,
      type: 'account_onboarding',
    });

    console.log(`✅ Account link created for: ${accountId}`);
    console.log(`🔗 Onboarding URL: ${accountLink.url}`);

    res.json({
      onboardingUrl: accountLink.url,
      message: 'Account link created successfully'
    });
  } catch (error) {
    console.error('❌ Error creating account link:', error);
    
    // Handle specific Stripe errors
    if (error.code === 'account_invalid') {
      return res.status(400).json({ 
        error: 'Invalid account',
        message: 'The Stripe Connect account is not valid for onboarding'
      });
    }
    
    res.status(500).json({ 
      error: 'Failed to create account link',
      message: process.env.NODE_ENV === 'development' ? error.message : 'Unable to create onboarding link'
    });
  }
});

// Get account status
app.post('/stripe/account-status', async (req, res) => {
  try {
    const { accountId } = req.body;

    if (!accountId || typeof accountId !== 'string') {
      return res.status(400).json({ error: 'Valid account ID required' });
    }

    console.log(`🔄 Getting account status for: ${accountId}`);

    const account = await stripe.accounts.retrieve(accountId);
    
    const isOnboarded = account.details_submitted && 
                       account.charges_enabled && 
                       account.payouts_enabled;
    
    const isEnabled = account.charges_enabled && account.payouts_enabled;

    let onboardingUrl = null;
    if (!isOnboarded) {
      try {
        console.log(`🔗 Creating onboarding link for account: ${accountId}`);
        const accountLink = await stripe.accountLinks.create({
          account: accountId,
          refresh_url: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/settings?stripe_refresh=true`,
          return_url: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/settings?stripe_return=true`,
          type: 'account_onboarding',
        });
        onboardingUrl = accountLink.url;
        console.log(`✅ Onboarding link created: ${onboardingUrl}`);
      } catch (linkError) {
        console.error('❌ Error creating account link:', linkError);
        // Don't fail the entire request, just don't provide onboarding URL
        onboardingUrl = null;
      }
    }

    console.log(`✅ Account status retrieved for: ${accountId}, onboarded: ${isOnboarded}`);

    res.json({
      isOnboarded,
      isEnabled,
      onboardingUrl,
      requiresAction: account.requirements.currently_due.length > 0,
      currentlyDue: account.requirements.currently_due,
      message: 'Account status retrieved successfully'
    });
  } catch (error) {
    console.error('❌ Error getting account status:', error);
    res.status(500).json({ 
      error: 'Failed to get account status',
      message: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Process withdrawal (Stripe transfer only)
app.post('/stripe/process-withdrawal', paymentLimiter, async (req, res) => {
  try {
    const { accountId, amount, transferGroup } = req.body;

    if (!accountId || typeof accountId !== 'string') {
      return res.status(400).json({ error: 'Valid account ID required' });
    }

    if (!amount || typeof amount !== 'number' || amount <= 0) {
      return res.status(400).json({ error: 'Valid amount required' });
    }

    // Convert amount to cents for Stripe
    const amountInCents = Math.round(amount * 100);

    if (amountInCents < 100) { // Minimum $1.00
      return res.status(400).json({ error: 'Minimum withdrawal amount is $1.00' });
    }

    console.log(`🔄 Processing Stripe transfer: $${amount} to ${accountId}`);

    // Create Stripe transfer
    const transfer = await stripe.transfers.create({
      amount: amountInCents,
      currency: 'usd',
      destination: accountId,
      transfer_group: transferGroup,
      metadata: {
        type: 'withdrawal',
        amount_dollars: amount.toFixed(2)
      }
    });

    console.log(`✅ Stripe transfer completed: ${transfer.id}`);

    res.json({
      success: true,
      transferId: transfer.id,
      amount: amount,
      message: 'Withdrawal processed successfully'
    });

  } catch (error) {
    console.error('❌ Error processing withdrawal:', error);
    
    // Handle specific Stripe errors
    if (error.code === 'insufficient_funds') {
      return res.status(400).json({ error: 'Insufficient funds in Stripe account' });
    }
    
    if (error.code === 'account_invalid') {
      return res.status(400).json({ error: 'Invalid Stripe Connect account' });
    }

    res.status(500).json({ 
      error: 'Failed to process withdrawal',
      message: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Helper functions for webhook handling
async function handleTransferPaid(transfer) {
  try {
    console.log(`🔄 Processing transfer.paid for: ${transfer.id}`);
    
    // Find the withdrawal request by transfer ID
    const { data: withdrawalRequest, error: findError } = await supabase
      .from('withdrawal_requests')
      .select('*')
      .eq('stripe_transfer_id', transfer.id)
      .single();

    if (findError || !withdrawalRequest) {
      console.error('❌ Could not find withdrawal request for transfer:', transfer.id);
      return;
    }

    console.log(`📋 Found withdrawal request: ${withdrawalRequest.id} for user: ${withdrawalRequest.user_id}`);

    // Get user's current earnings
    const { data: wallet, error: walletError } = await supabase
      .from('wallets')
      .select('earnings')
      .eq('user_id', withdrawalRequest.user_id)
      .single();

    if (walletError || !wallet) {
      console.error('❌ Could not find wallet for user:', withdrawalRequest.user_id);
      return;
    }

    // Update withdrawal status to completed (earnings already deducted)
    const { error: updateError } = await supabase
      .from('withdrawal_requests')
      .update({
        status: 'completed',
        processed_at: new Date().toISOString()
      })
      .eq('id', withdrawalRequest.id);

    if (updateError) {
      console.error('❌ Failed to update withdrawal request:', updateError);
      return;
    }

    // Update transaction record to show completion
    const { error: transactionError } = await supabase
      .from('transactions')
      .update({
        description: `Withdrawal completed: $${withdrawalRequest.amount.toFixed(2)} (${transfer.id})`
      })
      .eq('from_user_id', withdrawalRequest.user_id)
      .eq('amount', -withdrawalRequest.amount)
      .eq('transaction_type', 'withdrawal');

    if (transactionError) {
      console.error('❌ Failed to create transaction record:', transactionError);
    }

    console.log(`✅ Transfer completed successfully: $${withdrawalRequest.amount} for user ${withdrawalRequest.user_id}`);
  } catch (error) {
    console.error('❌ Error handling transfer.paid:', error);
  }
}

async function handleTransferFailed(transfer) {
  try {
    console.log(`🔄 Processing transfer.failed for: ${transfer.id}`);
    
    // Find the withdrawal request by transfer ID
    const { data: withdrawalRequest, error: findError } = await supabase
      .from('withdrawal_requests')
      .select('*')
      .eq('stripe_transfer_id', transfer.id)
      .single();

    if (findError || !withdrawalRequest) {
      console.error('❌ Could not find withdrawal request for transfer:', transfer.id);
      return;
    }

    console.log(`📋 Found failed withdrawal request: ${withdrawalRequest.id} for user: ${withdrawalRequest.user_id}`);

    // Get user's current earnings to refund the amount
    const { data: wallet, error: walletError } = await supabase
      .from('wallets')
      .select('earnings')
      .eq('user_id', withdrawalRequest.user_id)
      .single();

    if (walletError || !wallet) {
      console.error('❌ Could not find wallet for refund:', withdrawalRequest.user_id);
      return;
    }

    // Refund the withdrawal amount back to earnings
    const refundedEarnings = wallet.earnings + withdrawalRequest.amount;
    const { error: refundError } = await supabase
      .from('wallets')
      .update({ earnings: refundedEarnings })
      .eq('user_id', withdrawalRequest.user_id);

    if (refundError) {
      console.error('❌ Failed to refund earnings:', refundError);
      return;
    }

    // Update withdrawal status to failed
    const { error: updateError } = await supabase
      .from('withdrawal_requests')
      .update({
        status: 'failed',
        failure_reason: transfer.failure_message || 'Transfer failed',
        processed_at: new Date().toISOString()
      })
      .eq('id', withdrawalRequest.id);

    if (updateError) {
      console.error('❌ Failed to update withdrawal request:', updateError);
      return;
    }

    // Update transaction record to show refund
    const { error: transactionError } = await supabase
      .from('transactions')
      .update({
        description: `Withdrawal failed - refunded: $${withdrawalRequest.amount.toFixed(2)} (${transfer.id})`
      })
      .eq('from_user_id', withdrawalRequest.user_id)
      .eq('amount', -withdrawalRequest.amount)
      .eq('transaction_type', 'withdrawal');

    if (transactionError) {
      console.error('❌ Failed to update transaction record:', transactionError);
    }

    console.log(`✅ Transfer failure handled: ${withdrawalRequest.id}, $${withdrawalRequest.amount} refunded to earnings`);
  } catch (error) {
    console.error('❌ Error handling transfer.failed:', error);
  }
}

// Webhook endpoint for Stripe events (for production security)
app.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!webhookSecret) {
    console.warn('⚠️ Webhook secret not configured - skipping verification');
    return res.status(200).json({ received: true });
  }

  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    console.log(`📥 Webhook received: ${event.type}`);
  } catch (err) {
    console.error('❌ Webhook signature verification failed:', err.message);
    return res.status(400).json({ error: 'Invalid webhook signature' });
  }

  // Handle important events
  switch (event.type) {
    case 'payment_intent.succeeded':
      const paymentIntent = event.data.object;
      console.log(`✅ Payment succeeded via webhook: ${paymentIntent.id}`);
      // Additional verification/logging can be added here
      break;
    case 'payment_intent.payment_failed':
      const failedPayment = event.data.object;
      console.log(`❌ Payment failed via webhook: ${failedPayment.id}`);
      break;
    case 'payment_intent.requires_action':
      const actionRequired = event.data.object;
      console.log(`⚠️ Payment requires action: ${actionRequired.id}`);
      break;
    case 'transfer.created':
      const transfer = event.data.object;
      console.log(`🔄 Transfer created via webhook: ${transfer.id}`);
      // Transfer initiated, but not yet completed
      break;
    case 'transfer.updated':
      const updatedTransfer = event.data.object;
      console.log(`🔄 Transfer updated via webhook: ${updatedTransfer.id}, status: ${updatedTransfer.status}`);
      if (updatedTransfer.status === 'paid') {
        await handleTransferPaid(updatedTransfer);
      } else if (updatedTransfer.status === 'failed') {
        await handleTransferFailed(updatedTransfer);
      }
      break;
    case 'payout.paid':
      const payout = event.data.object;
      console.log(`✅ Payout paid via webhook: ${payout.id}`);
      // This might be when money actually hits the bank
      break;
    case 'payout.failed':
      const failedPayout = event.data.object;
      console.log(`❌ Payout failed via webhook: ${failedPayout.id}`);
      break;
    default:
      console.log(`ℹ️ Unhandled webhook event: ${event.type}`);
  }

  res.json({ received: true });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({ 
    error: 'Endpoint not found',
    available_endpoints: [
      'GET /',
      'GET /health', 
      'POST /create-payment-intent',
      'POST /stripe/create-express-account',
      'POST /stripe/create-account-link', 
      'POST /stripe/account-status',
      'POST /stripe/process-withdrawal',
      'POST /webhook'
    ]
  });
});

// Global error handler
app.use((error, req, res, next) => {
  console.error('❌ Server error:', error);
  res.status(500).json({ 
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong'
  });
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('🔄 Received SIGTERM, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('🔄 Received SIGINT, shutting down gracefully...');
  process.exit(0);
});

// Start server
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 TalkProfit Payment Server running on port ${PORT}`);
  console.log(`📋 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🔑 Stripe configured: ${process.env.STRIPE_SECRET_KEY ? '✅' : '❌'}`);
  console.log(`🎯 CORS origins: ${corsOptions.origin.length} configured`);
});

// Handle server errors
server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`❌ Port ${PORT} is already in use`);
    process.exit(1);
  } else {
    console.error('❌ Server error:', error);
    throw error;
  }
});

module.exports = app;