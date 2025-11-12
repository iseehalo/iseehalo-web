// public/js/supabaseClient.js


const SUPABASE_URL = "https://eanzstoycfuxqguwjuom.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVhbnpzdG95Y2Z1eHFndXdqdW9tIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTc0NzkzOTcsImV4cCI6MjA3MzA1NTM5N30.w6jRHgfs70iFsec2FY3HW8YFSLO96kpptOsDBopojRQ";

if (!window.supabase?.createClient) {
  console.error("❌ Supabase UMD library not loaded!");
} else {
  window.supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  console.log("✅ Supabase client ready:", SUPABASE_URL);
}

