// public/js/supabaseClient.js
// ES module version using esm.sh

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = "https://eanzstoycfuxqguwjuom.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVhbnpzdG95Y2Z1eHFndXdqdW9tIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTc0NzkzOTcsImV4cCI6MjA3MzA1NTM5N30.w6jRHgfs70iFsec2FY3HW8YFSLO96kpptOsDBopojRQ";

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error("❌ Missing Supabase config in supabaseClient.js");
}

// Create client and expose globally
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
window.supabase = supabase;

console.log("✅ Supabase client initialized:", SUPABASE_URL);


