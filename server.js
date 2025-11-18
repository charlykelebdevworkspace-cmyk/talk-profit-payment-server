// TalkProfit Stripe Payment Server
// Optimized for Railway deployment

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
const PORT = process.env.PORT || 3001;

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

// Webhook endpoint for Stripe events (for production security)
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
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