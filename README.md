# TalkProfit Payment Server

Stripe Payment Intent server for TalkProfit credit top-ups, optimized for Railway deployment.

## 🚀 Quick Railway Deployment

### 1. Deploy to Railway
[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/template/new)

**OR manually:**
1. Fork/Clone this repository
2. Go to [Railway.app](https://railway.app)
3. Click "New Project" → "Deploy from GitHub repo"
4. Select this repository
5. Railway will auto-deploy!

### 2. Set Environment Variables in Railway
Go to your project settings in Railway and add:

```bash
STRIPE_SECRET_KEY=sk_test_your_stripe_secret_key_here
FRONTEND_URL=https://your-frontend-domain.vercel.app
NODE_ENV=production
```

### 3. Get Your Railway URL
After deployment, Railway will provide a URL like:
`https://your-app-name.railway.app`

Use this URL in your frontend environment variables.

## 🔧 Local Development

```bash
# Install dependencies
npm install

# Copy environment file
cp .env.example .env

# Edit .env with your Stripe keys
# Then start the server
npm run dev
```

## 📡 API Endpoints

### Health Check
```
GET /
GET /health
```

### Create Payment Intent
```
POST /create-payment-intent
Content-Type: application/json

{
  "amount": 2500,        // Amount in cents ($25.00)
  "currency": "usd",     // Optional, defaults to USD
  "userId": "user_123"   // Required user identifier
}

Response:
{
  "client_secret": "pi_xxx_secret_xxx",
  "payment_intent_id": "pi_xxx"
}
```

### Webhook (for production security)
```
POST /webhook
Content-Type: application/json
Stripe-Signature: t=xxx,v1=xxx
```

## 🛡️ Security Features

✅ **Rate Limiting**: 5 payment attempts per minute per IP  
✅ **CORS Protection**: Configurable allowed origins  
✅ **Input Validation**: Amount limits ($1-$1000)  
✅ **Error Handling**: Detailed error messages for debugging  
✅ **Webhook Verification**: Stripe signature validation  
✅ **Helmet Security**: Basic security headers  

## 🔍 Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `STRIPE_SECRET_KEY` | Your Stripe secret key | ✅ Yes |
| `FRONTEND_URL` | Your frontend domain for CORS | ✅ Yes |
| `NODE_ENV` | Environment (production/development) | ⚠️ Recommended |
| `STRIPE_WEBHOOK_SECRET` | Webhook endpoint secret | 🔄 Optional |
| `PORT` | Server port (auto-set by Railway) | 🔄 Optional |

## 📊 Monitoring

The server includes comprehensive logging:
- ✅ Payment intent creation
- ❌ Failed payment attempts  
- 📥 Webhook events
- ⚠️ Rate limit violations
- 🔍 CORS violations

## 🚨 Troubleshooting

**Deployment fails?**
- Check that `package.json` has correct start script
- Verify all required environment variables are set

**CORS errors?**
- Add your frontend URL to `FRONTEND_URL` environment variable
- Check the CORS origins in server logs

**Stripe errors?**
- Verify `STRIPE_SECRET_KEY` is set correctly
- Check Stripe dashboard for API key status
- Ensure you're using the right key for your environment (test vs live)

**Rate limit errors?**
- Default: 5 payment attempts per minute per IP
- Adjust in `server.js` if needed for your use case

## 📈 Production Considerations

For production deployment, consider:
1. Set up Stripe webhooks pointing to `/webhook` endpoint
2. Use live Stripe keys instead of test keys
3. Configure custom domain in Railway
4. Set up monitoring/alerting for payment failures
5. Review rate limits based on your user base

## 🔄 Updates

To update the deployed server:
1. Push changes to your GitHub repository
2. Railway will automatically redeploy
3. Check deployment logs in Railway dashboard# talk-profit-payment-server
