require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL || 'https://placeholder.supabase.co';

// Use Service Role Key if available (bypasses RLS — required for server-side reads).
// Fall back to the publishable key if not set.
const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY || 'placeholder';

if (!process.env.SUPABASE_URL) {
  console.warn("⚠️  Missing SUPABASE_URL in environment variables.");
}
if (!process.env.SUPABASE_SERVICE_KEY) {
  console.warn("⚠️  SUPABASE_SERVICE_KEY not set — falling back to publishable key. RLS-protected tables (profiles, attendance) may return empty. Add SUPABASE_SERVICE_KEY to .env and Vercel settings.");
}

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false }
});

module.exports = supabase;
