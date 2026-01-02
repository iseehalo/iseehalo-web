// public/js/supabaseClient.js
// ES module version using esm.sh

//import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm'
// NOT 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js'

const SUPABASE_URL = "https://eanzstoycfuxqguwjuom.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVhbnpzdG95Y2Z1eHFndXdqdW9tIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTc0NzkzOTcsImV4cCI6MjA3MzA1NTM5N30.w6jRHgfs70iFsec2FY3HW8YFSLO96kpptOsDBopojRQ";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// (optional) also expose globally for quick debugging
window.supabase = supabase;

console.log("✅ Supabase client initialized");




