import { createClient } from "@supabase/supabase-js";

// Projeto "agrolinha" no Supabase. A chave anon é pública por design
// (a segurança real é o RLS, que limita cada usuário aos próprios dados).
const SUPABASE_URL = "https://dtuxdmiralinkqslfjwq.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImR0dXhkbWlyYWxpbmtxc2xmandxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU4MjI4ODEsImV4cCI6MjA5MTM5ODg4MX0.ofF_HUP_VqubGSxo_VbxVs9p63yL2qZqI8ZcfLkNgjo";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
