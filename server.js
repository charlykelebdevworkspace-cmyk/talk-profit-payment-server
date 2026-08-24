const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');
const twilio = require('twilio');
const fetch = require('node-fetch');
const { RtcTokenBuilder, RtcRole } = require('agora-token');

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// Initialize Stripe
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Initialize Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Initialize Twilio
const twilioClient = twilio(
  process.env.TWILIO_API_KEY,
  process.env.TWILIO_API_SECRET,
  { accountSid: process.env.TWILIO_ACCOUNT_SID }
);

const STRIPE_RECORDING_PRICE_ID = process.env.STRIPE_RECORDING_PRICE_ID;
const STRIPE_WEBHOOK_SECRET_SUBSCRIPTION = process.env.STRIPE_WEBHOOK_SECRET_SUBSCRIPTION;
// Signing secret for the endpoint that delivers payment_intent.succeeded for
// credit top-ups. May be the same endpoint as the subscription one.
const STRIPE_WEBHOOK_SECRET_TOPUP = process.env.STRIPE_WEBHOOK_SECRET_TOPUP;

// What a single top-up may be, in dollars. Mirrors the custom-amount bounds in
// src/components/TopUpDialog.tsx; the client's limits are a courtesy, this is
// the one that counts.
const TOPUP_MIN = 1;
const TOPUP_MAX = 1000;

// Middleware
// Configure CORS to handle preflight and allow required headers/methods
// The production site, its www alias, and anything named in env. The real
// domain is built in rather than left to FRONTEND_URL alone: when that env var
// drifted away from the live domain, every browser call from yapski.com failed
// preflight — Connect onboarding, withdrawals, subscriptions and stream tokens
// alike — and the app could only report "Failed to fetch".
const DEFAULT_ORIGINS = ['https://yapski.com', 'https://www.yapski.com'];

const allowedOrigins = [...new Set([
  ...DEFAULT_ORIGINS,
  process.env.FRONTEND_URL,
  process.env.PREVIEW_ORIGIN,
  // Comma-separated, for any additional domain without a code change.
  ...(process.env.ALLOWED_ORIGINS || '').split(',').map((o) => o.trim()),
].filter(Boolean))];

// Helper to allow Lovable preview domains (*.lovable.app, *.lovableproject.com)
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
    // Allow non-browser requests (no origin), configured origins, and Lovable previews
    if (
      !origin ||
      allowedOrigins.includes(origin) ||
      isLovablePreview(origin)
    ) {
      callback(null, true);
    } else {
      // Refusing with an Error makes Express return 500 with no CORS headers,
      // so a misconfigured origin looks like the server is down. Say no
      // quietly instead, and leave a line in the logs naming the origin.
      console.warn('CORS: blocked origin', origin);
      callback(null, false);
    }
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
  optionsSuccessStatus: 204
};

app.use(cors(corsOptions));

// IMPORTANT: webhook routes must be mounted BEFORE express.json() because
// Stripe signature verification needs the raw body bytes.
app.post(
  '/stripe/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    // Subscriptions and credit top-ups can be configured as two separate
    // Stripe endpoints, each with its own signing secret, or as one endpoint
    // carrying both event types. Trying every secret we hold means either
    // setup works and neither has to be pointed at a different URL.
    let event;
    const secrets = [STRIPE_WEBHOOK_SECRET_SUBSCRIPTION, STRIPE_WEBHOOK_SECRET_TOPUP].filter(Boolean);
    let lastError = null;

    for (const secret of secrets) {
      try {
        event = stripe.webhooks.constructEvent(
          req.body,
          req.headers['stripe-signature'],
          secret
        );
        break;
      } catch (err) {
        lastError = err;
      }
    }

    if (!event) {
      console.error('Stripe webhook signature failed:', lastError?.message);
      return res.status(400).send(`Webhook Error: ${lastError?.message || 'no matching signing secret'}`);
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

// Twilio webhook (form-encoded). Must run before express.json() but with
// urlencoded parser so we can read the fields.
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

// Ensure Express handles JSON bodies (after raw-body webhooks above)
app.use(express.json());
// Explicitly handle all OPTIONS preflight requests
app.options('*', cors(corsOptions));

// Verify JWT token middleware
const verifyToken = async (req, res, next) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  
  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }

  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) {
      return res.status(401).json({ error: 'Invalid token' });
    }
    req.user = user;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Token verification failed' });
  }
};

// Create Stripe Connect Express account
app.post('/stripe/create-express-account', verifyToken, async (req, res) => {
  try {
    const { userId, email, returnUrl, refreshUrl } = req.body;

    // Create Stripe Express account
    const account = await stripe.accounts.create({
      type: 'express',
      email: email,
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true },
      },
      business_type: 'individual',
      metadata: {
        userId: userId
      }
    });

    // Create account link for onboarding
    const accountLink = await stripe.accountLinks.create({
      account: account.id,
      refresh_url: refreshUrl,
      return_url: returnUrl,
      type: 'account_onboarding',
    });

    res.json({
      accountId: account.id,
      onboardingUrl: accountLink.url
    });
  } catch (error) {
    // Pass Stripe's own message through. The common failure here is the
    // platform account not having Connect enabled in live mode, and a generic
    // 'Failed to create account' gives nobody a way to find that out.
    console.error('Error creating Express account:', error);
    res.status(500).json({ error: error?.message || 'Failed to create account' });
  }
});

// Mint a fresh onboarding link for an account that already exists.
//
// Stripe's account links expire minutes after they are created, so anyone who
// starts onboarding and comes back later needs a new one. The client has
// called this since Connect was built; it was never implemented, so the
// "continue setup" path 404'd.
app.post('/stripe/create-account-link', verifyToken, async (req, res) => {
  try {
    const { accountId, returnUrl, refreshUrl } = req.body || {};
    if (!accountId) return res.status(400).json({ error: 'accountId required' });

    // The account has to be the caller's own — the id alone is not authority
    // to generate an onboarding link into someone else's Stripe account.
    const { data: profile } = await supabase
      .from('profiles')
      .select('user_id')
      .eq('user_id', req.user.id)
      .eq('stripe_connect_account_id', accountId)
      .maybeSingle();

    if (!profile) {
      return res.status(403).json({ error: 'That account is not linked to you.' });
    }

    const accountLink = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: refreshUrl || `${process.env.FRONTEND_URL}/settings?stripe_refresh=true`,
      return_url: returnUrl || `${process.env.FRONTEND_URL}/settings?stripe_return=true`,
      type: 'account_onboarding',
    });

    res.json({ onboardingUrl: accountLink.url });
  } catch (error) {
    console.error('create-account-link failed:', error);
    res.status(500).json({ error: 'Could not create an onboarding link.' });
  }
});

// Get account status
app.post('/stripe/account-status', verifyToken, async (req, res) => {
  try {
    const { accountId } = req.body;

    const account = await stripe.accounts.retrieve(accountId);
    
    const isOnboarded = account.details_submitted && 
                       account.charges_enabled && 
                       account.payouts_enabled;
    
    const isEnabled = account.charges_enabled && account.payouts_enabled;

    let onboardingUrl = null;
    if (!isOnboarded) {
      const accountLink = await stripe.accountLinks.create({
        account: accountId,
        refresh_url: `${process.env.FRONTEND_URL}/settings?stripe_refresh=true`,
        return_url: `${process.env.FRONTEND_URL}/settings?stripe_return=true`,
        type: 'account_onboarding',
      });
      onboardingUrl = accountLink.url;
    }

    res.json({
      isOnboarded,
      isEnabled,
      onboardingUrl,
      requiresAction: account.requirements.currently_due.length > 0
    });
  } catch (error) {
    console.error('Error getting account status:', error);
    res.status(500).json({ error: 'Failed to get account status' });
  }
});

// Process withdrawal
app.post('/stripe/process-withdrawal', verifyToken, async (req, res) => {
  try {
    const { withdrawalRequestId, accountId, amount } = req.body;
    const userId = req.user.id;

    // Convert amount to cents for Stripe
    const amountInCents = Math.round(amount * 100);

    // Start a Supabase transaction-like operation
    try {
      // Check if withdrawal request exists and is pending
      const { data: withdrawalRequest, error: fetchError } = await supabase
        .from('withdrawal_requests')
        .select('*')
        .eq('id', withdrawalRequestId)
        .eq('user_id', userId)
        .eq('status', 'pending')
        .single();

      if (fetchError || !withdrawalRequest) {
        throw new Error('Invalid withdrawal request');
      }

      // Check user's earnings balance
      const { data: wallet, error: walletError } = await supabase
        .from('wallets')
        .select('earnings')
        .eq('user_id', userId)
        .single();

      if (walletError || !wallet || wallet.earnings < amount) {
        throw new Error('Insufficient earnings');
      }

      // Update withdrawal request to processing
      await supabase
        .from('withdrawal_requests')
        .update({ status: 'processing' })
        .eq('id', withdrawalRequestId);

      // Create Stripe transfer
      const transfer = await stripe.transfers.create({
        amount: amountInCents,
        currency: 'usd',
        destination: accountId,
        metadata: {
          withdrawalRequestId: withdrawalRequestId,
          userId: userId
        }
      });

      // Update user's earnings (subtract the withdrawn amount)
      const newEarnings = wallet.earnings - amount;
      await supabase
        .from('wallets')
        .update({ earnings: newEarnings })
        .eq('user_id', userId);

      // Update withdrawal request with success
      await supabase
        .from('withdrawal_requests')
        .update({
          status: 'completed',
          stripe_transfer_id: transfer.id,
          processed_at: new Date().toISOString()
        })
        .eq('id', withdrawalRequestId);

      // Create transaction record
      await supabase
        .from('transactions')
        .insert({
          from_user_id: userId,
          to_user_id: null, // External withdrawal
          amount: -amount, // Negative for withdrawal
          transaction_type: 'withdrawal',
          description: `Withdrawal to Stripe Connect account: $${amount.toFixed(2)}`
        });

      res.json({
        success: true,
        transferId: transfer.id,
        message: 'Withdrawal processed successfully'
      });

    } catch (error) {
      // Update withdrawal request with failure
      await supabase
        .from('withdrawal_requests')
        .update({
          status: 'failed',
          failure_reason: error.message,
          processed_at: new Date().toISOString()
        })
        .eq('id', withdrawalRequestId);

      throw error;
    }

  } catch (error) {
    console.error('Error processing withdrawal:', error);
    res.status(500).json({ 
      error: 'Failed to process withdrawal',
      message: error.message 
    });
  }
});

// ============================================================
// Call Recording subscription
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

// Create checkout session for the $50/mo recording subscription
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

// Cancel an active recording subscription (at period end)
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

// Stripe webhook handler, invoked from the raw-body route above
async function handleStripeEvent(event) {
  const sub = event.data.object;
  switch (event.type) {
    case 'checkout.session.completed': {
      if (sub.mode !== 'subscription') return;
      const userId = sub.metadata?.user_id;
      if (!userId) return;
      const subscription = await stripe.subscriptions.retrieve(sub.subscription);
      await upsertSubscriptionRow(userId, subscription, sub.customer);
      break;
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const userId = sub.metadata?.user_id;
      if (!userId) return;
      await upsertSubscriptionRow(userId, sub, sub.customer);
      break;
    }
    case 'payment_intent.succeeded': {
      // Only our own top-ups; a PaymentIntent created for anything else must
      // not turn into credits.
      if (sub.metadata?.type !== 'credit_topup') return;
      const userId = sub.metadata?.userId;
      if (!userId) return;
      await grantTopUpCredits(userId, sub.amount_received ?? sub.amount, sub.id);
      break;
    }
    default:
      break;
  }
}

/**
 * Turn a succeeded PaymentIntent into wallet credits, exactly once.
 *
 * `amountInCents` comes from Stripe rather than from the caller — the amount
 * granted has to be the amount actually captured, not what anyone claims it
 * was. credit_wallet_topup() is keyed on the PaymentIntent id, so calling this
 * twice (webhook plus inline confirmation) credits once.
 */
async function grantTopUpCredits(userId, amountInCents, paymentIntentId) {
  const amount = Math.round(Number(amountInCents)) / 100;

  const { data, error } = await supabase.rpc('credit_wallet_topup', {
    p_user_id: userId,
    p_amount: amount,
    p_payment_intent: paymentIntentId,
  });

  if (error) {
    console.error('credit_wallet_topup failed:', {
      paymentIntentId,
      userId,
      amount,
      message: error.message,
      code: error.code,
      details: error.details,
      hint: error.hint,
    });
    throw error;
  }

  console.log('top-up:', paymentIntentId, data?.status, 'balance', data?.balance);
  return data;
}

async function upsertSubscriptionRow(userId, subscription, customerId) {
  await supabase
    .from('subscriptions')
    .upsert(
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

// Pre-create a Twilio room with recording enabled if any call participant
// has an active recording subscription. Both parties call this before joining
// to ensure the room is created in the correct mode regardless of who joins first.
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

    // Find a subscriber among participants. Prefer the requester if they are one.
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

    if (!subscriberId) return res.json({ recording: false, roomCreated: false });

    const roomName = `call-${callId}`;
    let room;
    try {
      room = await twilioClient.video.v1.rooms(roomName).fetch();
    } catch (_) {
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
    }

    if (!callRow.recording_enabled) {
      await supabase
        .from('calls')
        .update({
          recording_enabled: true,
          recording_subscriber_id: subscriberId,
          twilio_room_sid: room.sid,
        })
        .eq('id', callId);
    }

    res.json({ recording: true, roomCreated: true, roomSid: room.sid });
  } catch (error) {
    console.error('create-room failed:', error);
    res.status(500).json({ error: 'failed to create room' });
  }
});

// Twilio fires this when the room completes; build a composition then ingest it
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
        callRow.call_type === 'video'
          ? { grid: { video_sources: ['*'] } }
          : undefined,
      // Portrait frame so the grid layout stacks the two participants
      // top/bottom (matching the mobile call UI) instead of side by side,
      // which is what grid does in the default landscape 640x480 frame.
      resolution: callRow.call_type === 'video' ? '720x1280' : undefined,
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
          Buffer.from(
            `${process.env.TWILIO_API_KEY}:${process.env.TWILIO_API_SECRET}`
          ).toString('base64'),
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

    // Best-effort cleanup of the source composition + room recordings on Twilio
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
    if (rec.subscriber_user_id !== req.user.id) {
      return res.status(403).json({ error: 'forbidden' });
    }
    if (rec.status !== 'ready' || !rec.storage_path) {
      return res.status(409).json({ error: 'recording not ready' });
    }

    // `download: true` sets Content-Disposition: attachment on the signed URL so
    // the browser downloads the file instead of playing it inline. This is what
    // makes downloads work on mobile Safari, where the client-side `download`
    // attribute is ignored for cross-origin URLs.
    const { data, error } = await supabase.storage
      .from('recordings')
      .createSignedUrl(rec.storage_path, 60 * 10, { download: true }); // 10-minute URL
    if (error) throw error;

    res.json({ url: data.signedUrl });
  } catch (error) {
    console.error('signed-url failed:', error);
    res.status(500).json({ error: 'failed to sign url' });
  }
});

// ── Livestreams ────────────────────────────────────────────────────────────
// The Agora token is the paywall. Roles and entitlement are decided here and
// signed into the token, so nothing the client says about itself matters: a
// viewer cannot promote themselves to publisher, a kicked viewer cannot
// refresh their way back in, and someone who skipped the charge is never given
// a token at all. The database gate (RLS on stream_viewers) stops them
// registering; this stops them receiving media.
const AGORA_APP_ID = process.env.AGORA_APP_ID;
const AGORA_APP_CERTIFICATE = process.env.AGORA_APP_CERTIFICATE;

// Long enough to sit through a show, and renewed from the client before it
// lapses (see token-privilege-will-expire in src/lib/agoraService.ts) so a
// viewer who paid is never dropped mid-stream.
const AGORA_TOKEN_TTL_SECONDS = 4 * 60 * 60;

// Agora uids are 32-bit unsigned ints, not uuids. Derive one deterministically
// from the user id so the same person always reconnects as the same uid —
// otherwise every rejoin would look like a new participant. 0 is reserved by
// the SDK for "assign me one", so it is never returned.
const agoraUidFor = (userId) => {
  let hash = 5381;
  for (let i = 0; i < userId.length; i++) {
    hash = ((hash * 33) ^ userId.charCodeAt(i)) >>> 0;
  }
  return hash === 0 ? 1 : hash;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

app.post('/agora/token', verifyToken, async (req, res) => {
  try {
    if (!AGORA_APP_ID || !AGORA_APP_CERTIFICATE) {
      console.error('agora token requested but AGORA_APP_ID/AGORA_APP_CERTIFICATE are not set');
      return res.status(500).json({ error: 'Live streaming is not configured.' });
    }

    const { streamId } = req.body;
    if (!streamId || !UUID_RE.test(streamId)) {
      return res.status(400).json({ error: "This stream link isn't valid." });
    }

    const userId = req.user.id;

    const { data: stream } = await supabase
      .from('streams')
      .select('id, host_id, price, status, last_seen_at')
      .eq('id', streamId)
      .maybeSingle();

    if (!stream) return res.status(404).json({ error: "This stream doesn't exist." });

    // Same freshness rule as is_stream_joinable(): a host who closed the tab
    // never wrote status='ended', but the show is over all the same.
    const stale = Date.now() - new Date(stream.last_seen_at).getTime() > 2 * 60 * 1000;
    if (stream.status !== 'live' || stale) {
      return res.status(410).json({ error: 'This stream has ended.' });
    }

    const isHost = stream.host_id === userId;
    let canPublish = isHost;

    if (!isHost) {
      const { data: viewer } = await supabase
        .from('stream_viewers')
        .select('kicked')
        .eq('stream_id', streamId)
        .eq('user_id', userId)
        .maybeSingle();

      if (viewer?.kicked) {
        return res.status(403).json({ error: 'You were removed from this stream.' });
      }

      // An accepted co-host publishes, and is never charged: they are part of
      // the show rather than its audience.
      const { data: guest } = await supabase
        .from('stream_guests')
        .select('status')
        .eq('stream_id', streamId)
        .eq('user_id', userId)
        .maybeSingle();

      canPublish = guest?.status === 'accepted';

      if (!canPublish) {
        // Entry is a ticket row, written only by pay_stream_entry(). Free
        // streams issue one too, so there is a single code path here and the
        // answer never depends on re-reading the price.
        const { data: entry } = await supabase
          .from('stream_entries')
          .select('id')
          .eq('stream_id', streamId)
          .eq('user_id', userId)
          .maybeSingle();

        if (!entry) {
          return res.status(402).json({
            error: 'Entry payment required for this stream.',
            price: Number(stream.price) || 0,
          });
        }
      }
    }

    const uid = agoraUidFor(userId);
    const channel = `stream-${streamId}`;
    const expire = Math.floor(Date.now() / 1000) + AGORA_TOKEN_TTL_SECONDS;

    const token = RtcTokenBuilder.buildTokenWithUid(
      AGORA_APP_ID,
      AGORA_APP_CERTIFICATE,
      channel,
      uid,
      canPublish ? RtcRole.PUBLISHER : RtcRole.SUBSCRIBER,
      AGORA_TOKEN_TTL_SECONDS,
      AGORA_TOKEN_TTL_SECONDS
    );

    res.json({ appId: AGORA_APP_ID, channel, token, uid, canPublish, expiresAt: expire });
  } catch (error) {
    console.error('agora token failed:', error);
    res.status(500).json({ error: 'Could not join this stream.' });
  }
});

// ── Credit top-ups ─────────────────────────────────────────────────────────
// Buying credits is the only way money enters the wallet, and the wallet is
// what pays for calls and stream entry, so the amount is decided here and
// confirmed against Stripe — never taken from the client.
app.post('/stripe/create-payment-intent', verifyToken, async (req, res) => {
  try {
    const amount = Number(req.body?.amount);

    if (!Number.isFinite(amount) || amount < TOPUP_MIN || amount > TOPUP_MAX) {
      return res.status(400).json({
        error: `Enter an amount between $${TOPUP_MIN} and $${TOPUP_MAX}.`,
      });
    }

    // The user id comes from the verified JWT, not the body: a PaymentIntent
    // must never be able to credit somebody else's wallet.
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100),
      currency: 'usd',
      // Explicit card-only, matching the client's confirmCardPayment() with a
      // CardElement. automatic_payment_methods would offer methods that flow
      // cannot confirm.
      payment_method_types: ['card'],
      metadata: {
        type: 'credit_topup',
        userId: req.user.id,
      },
    });

    res.json({
      client_secret: paymentIntent.client_secret,
      payment_intent_id: paymentIntent.id,
    });
  } catch (error) {
    console.error('create-payment-intent failed:', error);
    res.status(500).json({ error: 'Could not start this payment.' });
  }
});

// Called by the client the moment confirmCardPayment() resolves, so credits
// appear immediately instead of whenever the webhook lands. The webhook is
// still the safety net for a tab closed mid-payment; both funnel into the same
// idempotent grant, so whichever is second changes nothing.
app.post('/stripe/confirm-topup', verifyToken, async (req, res) => {
  try {
    const { paymentIntentId } = req.body || {};
    if (!paymentIntentId || typeof paymentIntentId !== 'string') {
      return res.status(400).json({ error: 'paymentIntentId required' });
    }

    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

    // Stripe is asked directly whether this succeeded. The client saying so is
    // not evidence.
    if (paymentIntent.status !== 'succeeded') {
      return res.status(400).json({ error: 'That payment has not completed.' });
    }
    if (paymentIntent.metadata?.type !== 'credit_topup') {
      return res.status(400).json({ error: 'That payment was not a credit top-up.' });
    }
    if (paymentIntent.metadata?.userId !== req.user.id) {
      return res.status(403).json({ error: 'That payment belongs to another account.' });
    }

    const result = await grantTopUpCredits(
      req.user.id,
      paymentIntent.amount_received ?? paymentIntent.amount,
      paymentIntent.id
    );

    res.json({
      status: result?.status || 'credited',
      balance: Number(result?.balance) || 0,
    });
  } catch (error) {
    // The caller owns this payment and is out of pocket until it resolves, so
    // they get the real reason rather than a dead end. Retrying is free and
    // safe: the grant is keyed to the PaymentIntent, so a later success
    // credits exactly once.
    console.error('confirm-topup failed:', error);
    res.status(500).json({
      error: 'Payment went through but credits could not be added.',
      detail: error?.message || String(error),
      code: error?.code || null,
      hint: error?.hint || null,
      paymentIntentId: req.body?.paymentIntentId || null,
    });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'OK', service: 'talk-profit-link-backend' });
});

app.listen(port, () => {
  console.log(`🚀 Talk Profit Link backend running on port ${port}`);
  console.log('🌐 Allowed origins:', allowedOrigins.join(', ') || '(none)');
  console.log('📊 Endpoints:');
  console.log('  POST /stripe/create-payment-intent');
  console.log('  POST /stripe/confirm-topup');
  console.log('  POST /stripe/create-express-account');
  console.log('  POST /stripe/create-account-link');
  console.log('  POST /stripe/account-status');
  console.log('  POST /stripe/process-withdrawal');
  console.log('  POST /stripe/create-subscription-checkout');
  console.log('  POST /stripe/cancel-subscription');
  console.log('  POST /stripe/webhook');
  console.log('  POST /agora/token');
  console.log('  POST /twilio/create-room');
  console.log('  POST /twilio/recording-webhook');
  console.log('  GET  /recordings/:id/signed-url');
  console.log('  GET  /health');
});

module.exports = app;