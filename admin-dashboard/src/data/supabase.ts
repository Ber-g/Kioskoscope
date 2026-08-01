import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Client Supabase, configuré via variables d'environnement Vite (préfixe VITE_).
// Tant que les clés ne sont pas fournies (.env), le client est `null` et l'app
// retombe sur le mode mock — elle reste donc lançable sans backend.
//
// Ces valeurs sont PUBLIQUES par nature (elles vivent dans le frontend) :
// - VITE_SUPABASE_URL  : URL du projet
// - VITE_SUPABASE_ANON_KEY : clé anonyme (l'isolation est assurée par la RLS,
//   pas par le secret de la clé). Ne JAMAIS mettre ici la clé `service_role`.

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const isSupabaseConfigured: boolean = Boolean(url && anonKey);

/** URL du projet — nécessaire pour parler au endpoint d'envoi reprenable (CIN-101), qui n'est
 *  pas exposé par le SDK : `storage.upload()` est un POST unique, sans reprise ni progression. */
export const supabaseUrl: string | null = url ?? null;

export const supabase: SupabaseClient | null = isSupabaseConfigured
  ? createClient(url as string, anonKey as string)
  : null;
