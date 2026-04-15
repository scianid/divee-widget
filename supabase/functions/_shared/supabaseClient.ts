// @ts-ignore: Deno globals and JSR imports are unavailable to the editor TS server
import { createClient } from "jsr:@supabase/supabase-js@2";

export function supabaseClient() {
  return createClient(
    // @ts-ignore: Deno globals and JSR imports are unavailable to the editor TS server
    Deno.env.get("SUPABASE_URL") ?? "",
    // @ts-ignore: Deno globals and JSR imports are unavailable to the editor TS server
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  );
}
