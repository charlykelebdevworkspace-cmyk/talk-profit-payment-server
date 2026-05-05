const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const dotenv = require('dotenv');
const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');
const twilio = require('twilio');
const fetch = require('node-fetch');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const twilioClient = twilio(
  process.env.TWILIO_API_KEY,
  process.env.TWILIO_API_SECRET,
  { accountSid: process.env.TWILIO_ACCOUNT_SID }
);

const STRIPE_RECORDING_PRICE_ID = process.env.STRIPE_RECORDING_PRICE_ID;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const STRIPE_WEBHOOK_SECRET_RECORDING = process.env.STRIPE_WEBHOOK_SECRET_RECORDING;

app.set('trust proxy', 1);

app.use(helmet());

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

const paymentLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: { error: 'Too many payment attempts, please wait before trying again' },
});

const isLovablePreview = (origin) => {
  if (!origin) return false;
  try {
    const url = new URL(origin);
    const host = url.hostname;
    return (
      host.endsWith('.lovable.app') ||
      host.endsWith('.lovableproject.com') ||
      host === 'lovable.app' ||
      host === 'lovableproject.com'
    );
  } catch {
    return false;
  }
};

const corsOptions = {
  origin: function (origin, callback) {
    const allowedOrigins = [
      'http://localhost:5173',
      'http://localhost:3000',
      'http://localhost:8080',
      'https://talk-profit-link.vercel.app',
      'https://yapski.com',
      process.env.FRONTEND_URL,
      process.env.PREVIEW_ORIGIN,
      process.env.ALLOWED_ORIGIN,
    ].filter(Boolean);

    if (!origin || allowedOrigins.includes(origin) || isLovablePreview(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
  optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));

// Webhook routes must be before express.json() to get raw body for signature verification
app.post(
  '/stripe/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        req.headers['stripe-signature'],
        STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error('Stripe webhook signature failed:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
      await handleStripeEvent(event);
      res.json({ received: true });
    } catch (err) {
      console.error('Stripe webhook handler error:', err);
      res.status(500).json({ error: 'webhook handler failed' });
    }
  }
);

app.post(
  '/stripe/webhook/recording',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    if (!STRIPE_WEBHOOK_SECRET_RECORDING) {
      console.error('STRIPE_WEBHOOK_SECRET_RECORDING not configured');
      return res.status(500).send('Webhook secret not configured');
    }

    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        req.headers['stripe-signature'],
        STRIPE_WEBHOOK_SECRET_RECORDING
      );
    } catch (err) {
      console.error('Stripe recording webhook signature failed:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
      await handleRecordingSubscriptionEvent(event);
      res.json({ received: true });
    } catch (err) {
      console.error('Stripe recording webhook handler error:', err);
      res.status(500).json({ error: 'webhook handler failed' });
    }
  }
);

// Legacy webhook path for backwards compatibility
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  if (!STRIPE_WEBHOOK_SECRET) {
    console.warn('Webhook secret not configured - skipping verification');
    return res.status(200).json({ received: true });
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).json({ error: 'Invalid webhook signature' });
  }

  try {
    await handleStripeEvent(event);
    res.json({ received: true });
  } catch (err) {
    console.error('Webhook handler error:', err);
    res.status(500).json({ error: 'webhook handler failed' });
  }
});

app.post(
  '/twilio/recording-webhook',
  express.urlencoded({ extended: false }),
  async (req, res) => {
    try {
      await handleTwilioRecordingEvent(req.body);
      res.status(200).send('ok');
    } catch (err) {
      console.error('Twilio recording webhook error:', err);
      res.status(500).send('error');
    }
  }
);

app.use(express.json({ limit: '10mb' }));
app.options('*', cors(corsOptions));

const verifyToken = async (req, res, next) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token provided' });

  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return res.status(401).json({ error: 'Invalid token' });
    req.user = user;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Token verification failed' });
  }
};

// Health check
app.get('/', (req, res) => {
  res.json({
    status: 'TalkProfit Payment Server Running',
    version: '2.0.0',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
  });
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'healthy', service: 'talk-profit-payment-server' });
});

// Create Payment Intent (credit top-up)
app.post('/create-payment-intent', paymentLimiter, async (req, res) => {
  try {
    const { amount, currency = 'usd', userId } = req.body;

    if (!process.env.STRIPE_SECRET_KEY) {
      return res.status(500).json({ error: 'Payment service not configured' });
    }
    if (!amount || typeof amount !== 'number') {
      return res.status(400).json({ error: 'Invalid amount format' });
    }
    if (amount < 100) return res.status(400).json({ error: 'Minimum amount is $1.00' });
    if (amount > 100000) return res.status(400).json({ error: 'Maximum amount is $1000.00' });
    if (!userId || typeof userId !== 'string') {
      return res.status(400).json({ error: 'Valid user ID required' });
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount,
      currency,
      metadata: {
        userId,
        type: 'credit_topup',
        timestamp: new Date().toISOString(),
        source: 'talkprofit_web',
      },
      automatic_payment_methods: { enabled: true },
      description: `TalkProfit Credit Top-up: $${(amount / 100).toFixed(2)}`,
    });

    res.json({
      client_secret: paymentIntent.client_secret,
      payment_intent_id: paymentIntent.id,
    });
  } catch (error) {
    console.error('Error creating payment intent:', error);
    if (error.code === 'api_key_invalid') {
      return res.status(500).json({ error: 'Payment service configuration error' });
    }
    if (error.code === 'rate_limit') {
      return res.status(429).json({ error: 'Service temporarily busy, please try again' });
    }
    res.status(500).json({
      error: 'Unable to process payment request',
      message: process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
});

// Create Stripe Connect Express account
app.post('/stripe/create-express-account', paymentLimiter, async (req, res) => {
  try {
    const { userId, email, returnUrl, refreshUrl } = req.body;

    if (!email || typeof email !== 'string') {
      return res.status(400).json({ error: 'Valid email required' });
    }

    const account = await stripe.accounts.create({
      type: 'express',
      email,
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true },
      },
      business_type: 'individual',
      metadata: { userId: userId || '' },
    });

    // If returnUrl provided, also create the onboarding link in one call
    if (returnUrl) {
      const accountLink = await stripe.accountLinks.create({
        account: account.id,
        refresh_url: refreshUrl || `${process.env.FRONTEND_URL || 'http://localhost:5173'}/settings?stripe_refresh=true`,
        return_url: returnUrl,
        type: 'account_onboarding',
      });
      return res.json({ accountId: account.id, onboardingUrl: accountLink.url });
    }

    res.json({ accountId: account.id, message: 'Express account created successfully' });
  } catch (error) {
    console.error('Error creating Express account:', error);
    res.status(500).json({
      error: 'Failed to create Express account',
      message: process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
});

// Create account onboarding link (separate step)
app.post('/stripe/create-account-link', paymentLimiter, async (req, res) => {
  try {
    const { accountId, returnUrl, refreshUrl } = req.body;

    if (!accountId || typeof accountId !== 'string') {
      return res.status(400).json({ error: 'Valid account ID required' });
    }

    try {
      await stripe.accounts.retrieve(accountId);
    } catch (accountError) {
      return res.status(400).json({
        error: 'Invalid Stripe Connect account',
        message: 'The account ID provided is not valid or no longer exists',
      });
    }

    const accountLink = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: refreshUrl || `${process.env.FRONTEND_URL || 'http://localhost:5173'}/settings?stripe_refresh=true`,
      return_url: returnUrl || `${process.env.FRONTEND_URL || 'http://localhost:5173'}/settings?stripe_return=true`,
      type: 'account_onboarding',
    });

    res.json({ onboardingUrl: accountLink.url, message: 'Account link created successfully' });
  } catch (error) {
    console.error('Error creating account link:', error);
    if (error.code === 'account_invalid') {
      return res.status(400).json({ error: 'Invalid account' });
    }
    res.status(500).json({
      error: 'Failed to create account link',
      message: process.env.NODE_ENV === 'development' ? error.message : 'Unable to create onboarding link',
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

    const account = await stripe.accounts.retrieve(accountId);
    const isOnboarded = account.details_submitted && account.charges_enabled && account.payouts_enabled;
    const isEnabled = account.charges_enabled && account.payouts_enabled;

    let onboardingUrl = null;
    if (!isOnboarded) {
      try {
        const accountLink = await stripe.accountLinks.create({
          account: accountId,
          refresh_url: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/settings?stripe_refresh=true`,
          return_url: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/settings?stripe_return=true`,
          type: 'account_onboarding',
        });
        onboardingUrl = accountLink.url;
      } catch (linkError) {
        console.error('Error creating account link:', linkError);
      }
    }

    res.json({
      isOnboarded,
      isEnabled,
      onboardingUrl,
      requiresAction: account.requirements.currently_due.length > 0,
      currentlyDue: account.requirements.currently_due,
      message: 'Account status retrieved successfully',
    });
  } catch (error) {
    console.error('Error getting account status:', error);
    res.status(500).json({
      error: 'Failed to get account status',
      message: process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
});

// Get Stripe platform balance
app.get('/stripe/balance', async (req, res) => {
  try {
    const balance = await stripe.balance.retrieve();

    const available = balance.available.map(b => ({
      amount: b.amount / 100,
      currency: b.currency.toUpperCase(),
    }));
    const pending = balance.pending.map(b => ({
      amount: b.amount / 100,
      currency: b.currency.toUpperCase(),
    }));

    res.json({ available, pending, message: 'Balance retrieved successfully' });
  } catch (error) {
    console.error('Error fetching balance:', error);
    res.status(500).json({
      error: 'Failed to fetch balance',
      message: process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
});

// Process withdrawal
app.post('/stripe/process-withdrawal', paymentLimiter, async (req, res) => {
  try {
    const { withdrawalRequestId, accountId, amount, transferGroup } = req.body;

    if (!accountId || typeof accountId !== 'string') {
      return res.status(400).json({ error: 'Valid account ID required' });
    }
    if (!amount || typeof amount !== 'number' || amount <= 0) {
      return res.status(400).json({ error: 'Valid amount required' });
    }

    const amountInCents = Math.round(amount * 100);
    if (amountInCents < 100) {
      return res.status(400).json({ error: 'Minimum withdrawal amount is $1.00' });
    }

    // New flow: withdrawalRequestId provided — manage DB state in backend
    if (withdrawalRequestId) {
      const token = req.headers.authorization?.replace('Bearer ', '');
      let userId = null;
      if (token) {
        const { data: { user } } = await supabase.auth.getUser(token);
        userId = user?.id;
      }

      try {
        const { data: withdrawalRequest, error: fetchError } = await supabase
          .from('withdrawal_requests')
          .select('*')
          .eq('id', withdrawalRequestId)
          .eq('status', 'pending')
          .single();

        if (fetchError || !withdrawalRequest) throw new Error('Invalid withdrawal request');

        const { data: wallet, error: walletError } = await supabase
          .from('wallets')
          .select('earnings')
          .eq('user_id', withdrawalRequest.user_id)
          .single();

        if (walletError || !wallet || wallet.earnings < amount) throw new Error('Insufficient earnings');

        await supabase
          .from('withdrawal_requests')
          .update({ status: 'processing' })
          .eq('id', withdrawalRequestId);

        const transfer = await stripe.transfers.create({
          amount: amountInCents,
          currency: 'usd',
          destination: accountId,
          metadata: { withdrawalRequestId, userId: withdrawalRequest.user_id },
        });

        await supabase
          .from('wallets')
          .update({ earnings: wallet.earnings - amount })
          .eq('user_id', withdrawalRequest.user_id);

        await supabase
          .from('withdrawal_requests')
          .update({ status: 'completed', stripe_transfer_id: transfer.id, processed_at: new Date().toISOString() })
          .eq('id', withdrawalRequestId);

        await supabase.from('transactions').insert({
          from_user_id: withdrawalRequest.user_id,
          to_user_id: null,
          amount: -amount,
          transaction_type: 'withdrawal',
          description: `Withdrawal to Stripe Connect account: $${amount.toFixed(2)}`,
        });

        return res.json({ success: true, transferId: transfer.id, message: 'Withdrawal processed successfully' });
      } catch (error) {
        await supabase
          .from('withdrawal_requests')
          .update({ status: 'failed', failure_reason: error.message, processed_at: new Date().toISOString() })
          .eq('id', withdrawalRequestId);
        throw error;
      }
    }

    // Legacy flow: no withdrawalRequestId — frontend manages DB state
    try {
      const transfer = await stripe.transfers.create({
        amount: amountInCents,
        currency: 'usd',
        destination: accountId,
        transfer_group: transferGroup,
        metadata: { type: 'withdrawal', amount_dollars: amount.toFixed(2) },
      });

      return res.json({ success: true, transferId: transfer.id, amount, message: 'Withdrawal processed successfully' });
    } catch (stripeError) {
      if (stripeError.code === 'insufficient_funds' || stripeError.code === 'balance_insufficient') {
        return res.status(202).json({
          success: true,
          pending: true,
          amount,
          message: 'Withdrawal request accepted and will be processed within 7-14 business days',
        });
      }
      throw stripeError;
    }
  } catch (error) {
    console.error('Error processing withdrawal:', error);
    if (error.code === 'account_invalid') {
      return res.status(400).json({ error: 'Invalid Stripe Connect account' });
    }
    res.status(500).json({
      error: 'Failed to process withdrawal',
      message: process.env.NODE_ENV === 'development' ? error.message : 'Please try again or contact support',
    });
  }
});

// ============================================================
// Call Recording Subscription
// ============================================================

async function getOrCreateStripeCustomer(userId, email) {
  const { data: existing } = await supabase
    .from('subscriptions')
    .select('stripe_customer_id')
    .eq('user_id', userId)
    .not('stripe_customer_id', 'is', null)
    .limit(1)
    .maybeSingle();

  if (existing?.stripe_customer_id) return existing.stripe_customer_id;

  const customer = await stripe.customers.create({
    email,
    metadata: { user_id: userId },
  });
  return customer.id;
}

app.post('/stripe/create-subscription-checkout', verifyToken, async (req, res) => {
  try {
    if (!STRIPE_RECORDING_PRICE_ID) {
      return res.status(500).json({ error: 'STRIPE_RECORDING_PRICE_ID not configured' });
    }
    const { successUrl, cancelUrl } = req.body;
    const customerId = await getOrCreateStripeCustomer(req.user.id, req.user.email);

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: STRIPE_RECORDING_PRICE_ID, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: { user_id: req.user.id, product: 'call_recording' },
      subscription_data: {
        metadata: { user_id: req.user.id, product: 'call_recording' },
      },
    });

    res.json({ url: session.url, sessionId: session.id });
  } catch (error) {
    console.error('Create subscription checkout failed:', error);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

app.post('/stripe/cancel-subscription', verifyToken, async (req, res) => {
  try {
    const { data: sub } = await supabase
      .from('subscriptions')
      .select('stripe_subscription_id')
      .eq('user_id', req.user.id)
      .eq('product', 'call_recording')
      .in('status', ['active', 'trialing', 'past_due'])
      .maybeSingle();

    if (!sub?.stripe_subscription_id) {
      return res.status(404).json({ error: 'No active subscription' });
    }

    const updated = await stripe.subscriptions.update(sub.stripe_subscription_id, {
      cancel_at_period_end: true,
    });

    await supabase
      .from('subscriptions')
      .update({ cancel_at_period_end: true })
      .eq('stripe_subscription_id', sub.stripe_subscription_id);

    res.json({ success: true, cancel_at_period_end: updated.cancel_at_period_end });
  } catch (error) {
    console.error('Cancel subscription failed:', error);
    res.status(500).json({ error: 'Failed to cancel subscription' });
  }
});

// ============================================================
// Stripe webhook event handler
// ============================================================

async function handleStripeEvent(event) {
  const obj = event.data.object;

  switch (event.type) {
    case 'payment_intent.succeeded':
      console.log(`Payment succeeded: ${obj.id}`);
      break;
    case 'payment_intent.payment_failed':
      console.log(`Payment failed: ${obj.id}`);
      break;
    case 'checkout.session.completed': {
      if (obj.mode !== 'subscription') return;
      const userId = obj.metadata?.user_id;
      if (!userId) return;
      const subscription = await stripe.subscriptions.retrieve(obj.subscription);
      await upsertSubscriptionRow(userId, subscription, obj.customer);
      break;
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const userId = obj.metadata?.user_id;
      if (!userId) return;
      await upsertSubscriptionRow(userId, obj, obj.customer);
      break;
    }
    case 'transfer.updated': {
      if (obj.status === 'paid') await handleTransferPaid(obj);
      else if (obj.status === 'failed') await handleTransferFailed(obj);
      break;
    }
    default:
      break;
  }
}

async function handleRecordingSubscriptionEvent(event) {
  const obj = event.data.object;

  switch (event.type) {
    case 'checkout.session.completed': {
      if (obj.mode !== 'subscription') return;
      const userId = obj.metadata?.user_id;
      if (!userId) return;
      const subscription = await stripe.subscriptions.retrieve(obj.subscription);
      await upsertSubscriptionRow(userId, subscription, obj.customer);
      break;
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const userId = obj.metadata?.user_id;
      if (!userId) return;
      await upsertSubscriptionRow(userId, obj, obj.customer);
      break;
    }
    default:
      break;
  }
}

async function upsertSubscriptionRow(userId, subscription, customerId) {
  await supabase.from('subscriptions').upsert(
    {
      user_id: userId,
      product: subscription.metadata?.product || 'call_recording',
      stripe_customer_id: typeof customerId === 'string' ? customerId : customerId?.id,
      stripe_subscription_id: subscription.id,
      status: subscription.status,
      current_period_end: subscription.current_period_end
        ? new Date(subscription.current_period_end * 1000).toISOString()
        : null,
      cancel_at_period_end: !!subscription.cancel_at_period_end,
    },
    { onConflict: 'stripe_subscription_id' }
  );
}

async function handleTransferPaid(transfer) {
  try {
    const { data: withdrawalRequest, error: findError } = await supabase
      .from('withdrawal_requests')
      .select('*')
      .eq('stripe_transfer_id', transfer.id)
      .single();

    if (findError || !withdrawalRequest) return;

    await supabase
      .from('withdrawal_requests')
      .update({ status: 'completed', processed_at: new Date().toISOString() })
      .eq('id', withdrawalRequest.id);

    await supabase
      .from('transactions')
      .update({ description: `Withdrawal completed: $${withdrawalRequest.amount.toFixed(2)} (${transfer.id})` })
      .eq('from_user_id', withdrawalRequest.user_id)
      .eq('amount', -withdrawalRequest.amount)
      .eq('transaction_type', 'withdrawal');
  } catch (error) {
    console.error('Error handling transfer.paid:', error);
  }
}

async function handleTransferFailed(transfer) {
  try {
    const { data: withdrawalRequest, error: findError } = await supabase
      .from('withdrawal_requests')
      .select('*')
      .eq('stripe_transfer_id', transfer.id)
      .single();

    if (findError || !withdrawalRequest) return;

    const { data: wallet } = await supabase
      .from('wallets')
      .select('earnings')
      .eq('user_id', withdrawalRequest.user_id)
      .single();

    if (wallet) {
      await supabase
        .from('wallets')
        .update({ earnings: wallet.earnings + withdrawalRequest.amount })
        .eq('user_id', withdrawalRequest.user_id);
    }

    await supabase
      .from('withdrawal_requests')
      .update({
        status: 'failed',
        failure_reason: transfer.failure_message || 'Transfer failed',
        processed_at: new Date().toISOString(),
      })
      .eq('id', withdrawalRequest.id);
  } catch (error) {
    console.error('Error handling transfer.failed:', error);
  }
}

// ============================================================
// Twilio room creation + recording webhook
// ============================================================

async function userHasActiveRecordingSubscription(userId) {
  const { data } = await supabase
    .from('subscriptions')
    .select('id')
    .eq('user_id', userId)
    .eq('product', 'call_recording')
    .in('status', ['active', 'trialing'])
    .limit(1)
    .maybeSingle();
  return !!data;
}
  app.post('/twilio/start-recording', verifyToken, async (req, res) => {                                           
    try {
      const { callId } = req.body;                                                                                 
      console.log('start-recording: callId=', callId, 'user=', req.user.id);
      if (!callId) return res.status(400).json({ error: 'callId required' });                                      
                                                                                                                   
      const roomName = `call-${callId}`;
      let room;
      try {
        room = await twilioClient.video.v1.rooms(roomName).fetch();
      } catch (e) {
        if (e?.status && e.status !== 404) {
          console.error('rooms.fetch failed:', e.status, e.code, e.message);
        }
        room = null;
      }

      if (!room || room.status === 'completed') {
        const callbackUrl = `${process.env.PUBLIC_BACKEND_URL || ''}/twilio/recording-webhook`;
        room = await twilioClient.video.v1.rooms.create({
          uniqueName: roomName,
          type: 'group',
          recordParticipantsOnConnect: true,                
          statusCallback: callbackUrl || undefined,                                                                
          statusCallbackMethod: 'POST',                     
        });                                                                                                        
      } else if (room.type !== 'group') {                   
        return res.status(409).json({                                                                              
          error: 'Room is peer-to-peer. End the call and start a new one to enable recording.',                    
        });                                                                                                        
      } else {                                                                                                     
        await twilioClient.video.v1.rooms(room.sid).recordingRules.update({                                        
          rules: [{ type: 'include', all: true }],                                                                 
        });                                                                                                        
      }                                                                                                            
                                                                                                                   
      // Best-effort DB update — won't fail the request if the row is missing                                      
      try {                                                                                                      
        await supabase                                                                                             
          .from('calls')                                    
          .update({                                                                                                
            recording_enabled: true,
            recording_subscriber_id: req.user.id,                                                                  
            twilio_room_sid: room.sid,                      
          })                                                                                                       
          .eq('id', callId);
      } catch (e) {                                                                                                
        console.warn('calls update skipped:', e?.message);  
      }                                                                                                            
   
      res.json({ recording: true, roomSid: room.sid });                                                            
    } catch (error) {                                       
      console.error('start-recording failed:', error);                                                             
      res.status(500).json({ error: error.message || 'failed to start recording' });
    }                                                                                                              
  });

app.post('/twilio/create-room', verifyToken, async (req, res) => {                                               
    try {                                                                                                        
      const { callId } = req.body;                                                                                 
      if (!callId) return res.status(400).json({ error: 'callId required' });                                      
                                                                                                                 
      const { data: callRow } = await supabase                                                                     
        .from('calls')                                      
        .select('id, caller_id, receiver_id, recording_enabled, twilio_room_sid')                                  
        .eq('id', callId)                                                                                          
        .single();                                                                                               
      if (!callRow) return res.status(404).json({ error: 'call not found' });                                      
      if (callRow.caller_id !== req.user.id && callRow.receiver_id !== req.user.id) {                              
        return res.status(403).json({ error: 'not a call participant' });                                          
      }                                                                                                            
                                                                                                                   
      const candidates = [callRow.caller_id, callRow.receiver_id];                                                 
      let subscriberId = null;                                                                                   
      if (await userHasActiveRecordingSubscription(req.user.id)) {                                                 
        subscriberId = req.user.id;                                                                                
      } else {                                                                                                     
        for (const uid of candidates) {                                                                            
          if (uid === req.user.id) continue;                                                                       
          if (await userHasActiveRecordingSubscription(uid)) {                                                   
            subscriberId = uid;                                                                                    
            break;
          }                                                                                                        
        }                                                   
      }                                                                                                          

      const roomName = `call-${callId}`;                                                                           
      let room;
      try {
        room = await twilioClient.video.v1.rooms(roomName).fetch();
      } catch (e) {
        if (e?.status && e.status !== 404) {
          console.error('rooms.fetch failed:', e.status, e.code, e.message);
        }
        room = null;
      }                                                                                                            
                                                                                                                   
      if (!room || room.status === 'completed') {                                                                
        const callbackUrl = `${process.env.PUBLIC_BACKEND_URL || ''}/twilio/recording-webhook`;                  
        room = await twilioClient.video.v1.rooms.create({                                                          
          uniqueName: roomName,
          type: 'group',                                                                                           
          recordParticipantsOnConnect: !!subscriberId,      
          statusCallback: callbackUrl || undefined,                                                                
          statusCallbackMethod: 'POST',                     
        });                                                                                                        
      }                                                     
                                                                                                                 
      if (subscriberId && !callRow.recording_enabled) {                                                            
        await supabase
          .from('calls')                                                                                           
          .update({ recording_enabled: true, recording_subscriber_id: subscriberId, twilio_room_sid: room.sid })
          .eq('id', callId);                                                                                       
      } else if (!callRow.twilio_room_sid) {
        await supabase.from('calls').update({ twilio_room_sid: room.sid }).eq('id', callId);                       
      }                                                                                                            
                                                                                                                   
      res.json({ recording: !!subscriberId, roomCreated: true, roomSid: room.sid });                               
    } catch (error) {                                                                                            
      console.error('create-room failed:', error);                                                                 
      res.status(500).json({ error: 'failed to create room' });                                                    
    }                                                                                                            
  });     

async function handleTwilioRecordingEvent(body) {
  const event = body.StatusCallbackEvent;
  const roomSid = body.RoomSid;
  if (!roomSid) return;

  if (event === 'room-ended') {
    const { data: callRow } = await supabase
      .from('calls')
      .select('id, recording_subscriber_id, call_type')
      .eq('twilio_room_sid', roomSid)
      .maybeSingle();
    if (!callRow || !callRow.recording_subscriber_id) return;

    const callbackUrl = `${process.env.PUBLIC_BACKEND_URL || ''}/twilio/recording-webhook`;

    const composition = await twilioClient.video.v1.compositions.create({
      roomSid,
      audioSources: ['*'],
      videoLayout:
        callRow.call_type === 'video' ? { grid: { video_sources: ['*'] } } : undefined,
      format: callRow.call_type === 'video' ? 'mp4' : 'mp3',
      statusCallback: callbackUrl || undefined,
      statusCallbackMethod: 'POST',
    });

    await supabase.from('call_recordings').insert({
      call_id: callRow.id,
      subscriber_user_id: callRow.recording_subscriber_id,
      twilio_composition_sid: composition.sid,
      storage_path: '',
      media_format: callRow.call_type === 'video' ? 'mp4' : 'mp3',
      call_type: callRow.call_type,
      status: 'processing',
    });
    return;
  }

  if (event === 'composition-available') {
    const compositionSid = body.CompositionSid;
    if (!compositionSid) return;

    const { data: rec } = await supabase
      .from('call_recordings')
      .select('id, subscriber_user_id, call_id, media_format')
      .eq('twilio_composition_sid', compositionSid)
      .maybeSingle();
    if (!rec) return;

    const composition = await twilioClient.video.v1.compositions(compositionSid).fetch();
    const mediaUrl = `https://video.twilio.com${composition.url}/Media`;

    const mediaResp = await fetch(mediaUrl, {
      headers: {
        Authorization:
          'Basic ' +
          Buffer.from(`${process.env.TWILIO_API_KEY}:${process.env.TWILIO_API_SECRET}`).toString('base64'),
      },
      redirect: 'follow',
    });
    if (!mediaResp.ok) {
      console.error('Failed to fetch composition media:', mediaResp.status);
      return;
    }
    const buffer = await mediaResp.buffer();

    const ext = rec.media_format;
    const path = `${rec.subscriber_user_id}/${rec.call_id}.${ext}`;
    const { error: uploadErr } = await supabase.storage
      .from('recordings')
      .upload(path, buffer, {
        contentType: ext === 'mp4' ? 'video/mp4' : 'audio/mpeg',
        upsert: true,
      });
    if (uploadErr) {
      console.error('Failed to upload recording to storage:', uploadErr);
      return;
    }

    await supabase
      .from('call_recordings')
      .update({
        storage_path: path,
        size_bytes: buffer.length,
        duration_seconds: composition.duration || null,
        status: 'ready',
      })
      .eq('id', rec.id);

    try {
      await twilioClient.video.v1.compositions(compositionSid).remove();
    } catch (e) {
      console.warn('Failed to remove composition:', e.message);
    }
  }
}

// Signed download URL for a recording (subscriber-only)
app.get('/recordings/:id/signed-url', verifyToken, async (req, res) => {
  try {
    const { data: rec } = await supabase
      .from('call_recordings')
      .select('id, subscriber_user_id, storage_path, status')
      .eq('id', req.params.id)
      .maybeSingle();

    if (!rec) return res.status(404).json({ error: 'not found' });
    if (rec.subscriber_user_id !== req.user.id) return res.status(403).json({ error: 'forbidden' });
    if (rec.status !== 'ready' || !rec.storage_path) {
      return res.status(409).json({ error: 'recording not ready' });
    }

    const { data, error } = await supabase.storage
      .from('recordings')
      .createSignedUrl(rec.storage_path, 60 * 10);
    if (error) throw error;

    res.json({ url: data.signedUrl });
  } catch (error) {
    console.error('signed-url failed:', error);
    res.status(500).json({ error: 'failed to sign url' });
  }
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    error: 'Endpoint not found',
    available_endpoints: [
      'GET /',
      'GET /health',
      'GET /stripe/balance',
      'GET /recordings/:id/signed-url',
      'POST /create-payment-intent',
      'POST /stripe/create-express-account',
      'POST /stripe/create-account-link',
      'POST /stripe/account-status',
      'POST /stripe/process-withdrawal',
      'POST /stripe/create-subscription-checkout',
      'POST /stripe/cancel-subscription',
      'POST /stripe/webhook',
      'POST /webhook',
      'POST /twilio/create-room',
      'POST /twilio/recording-webhook',
    ],
  });
});

app.use((error, req, res, next) => {
  console.error('Server error:', error);
  res.status(500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong',
  });
});

process.on('SIGTERM', () => { console.log('SIGTERM received, shutting down gracefully'); process.exit(0); });
process.on('SIGINT', () => { console.log('SIGINT received, shutting down gracefully'); process.exit(0); });

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`TalkProfit Payment Server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`Stripe configured: ${process.env.STRIPE_SECRET_KEY ? 'yes' : 'no'}`);
  console.log(`Twilio configured: ${process.env.TWILIO_API_KEY ? 'yes' : 'no'}`);
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use`);
    process.exit(1);
  } else {
    throw error;
  }
});

module.exports = app;
