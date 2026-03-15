# 🎓 Joetito's School of Data v2

College basketball AI predictions with user accounts, self-learning model, and synced data across devices.

## Deploying to Vercel

### Step 1: Upload to GitHub
Upload all files to your GitHub repo (same as before — drag and drop).

### Step 2: Add Environment Variables in Vercel
Go to your Vercel project → Settings → Environment Variables. Add these 5 variables:

| Name | Value |
|------|-------|
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Your Clerk publishable key (pk_test_...) |
| `CLERK_SECRET_KEY` | Your Clerk secret key (sk_test_...) |
| `NEXT_PUBLIC_SUPABASE_URL` | Your Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Your Supabase anon/publishable key |
| `ANTHROPIC_API_KEY` | Your Anthropic API key (sk-ant-...) |

### Step 3: Deploy
Vercel auto-deploys when you push. If it doesn't, click Redeploy.

## Features
- Google sign-in + email/password login
- Per-user prediction history stored in Supabase
- Self-learning model weights synced across devices
- Secure API key (never exposed to browser)
- PWA support (add to home screen)
