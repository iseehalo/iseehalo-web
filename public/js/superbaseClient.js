// public/js/supabaseClient.js

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";


const SUPABASE_URL = "https://eanzstoycfuxqguwjuom.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVhbnpzdG95Y2Z1eHFndXdqdW9tIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTc0NzkzOTcsImV4cCI6MjA3MzA1NTM5N30.w6jRHgfs70iFsec2FY3HW8YFSLO96kpptOsDBopojRQ";

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error("❌ Missing Supabase environment variables!");
}

// ✅ Create a global Supabase client available to all pages
window.supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

console.log("✅ Supabase client initialized:", SUPABASE_URL);
