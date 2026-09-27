import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

const realtimeWorkerSupported =
  typeof window !== "undefined" &&
  typeof window.Worker !== "undefined";

let supabase;

supabase = createClient(supabaseUrl, supabaseAnonKey, {
  realtime: {
    // Keep Realtime heartbeats running reliably when another browser
    // window/tab has focus.
    worker: realtimeWorkerSupported,

    // Detect a broken socket sooner than the default heartbeat interval.
    heartbeatIntervalMs: 15_000,

    // Explicitly reconnect if the heartbeat detects a silent disconnect.
    heartbeatCallback: (status) => {
      if (status === "disconnected") {
        supabase?.realtime?.connect();
      }
    },
  },
});

export { supabase };