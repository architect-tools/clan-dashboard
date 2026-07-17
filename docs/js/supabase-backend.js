// Supabase realtime transport. Domain validation and authorization live in
// Postgres RPC functions from supabase/migrations/001_clan_dashboard.sql.
import { CONFIG } from './config.js';

const configured = () => !!(CONFIG.SUPABASE_URL && CONFIG.SUPABASE_PUBLISHABLE_KEY);
let client = null;
let revisionChannel = null;

function requireClientLibrary() {
  const lib = globalThis.supabase;
  if (!lib?.createClient) throw new Error('Supabase 클라이언트 라이브러리를 불러오지 못했습니다.');
  return lib;
}

function unwrap({ data, error }) {
  if (error) throw new Error(error.message || String(error));
  return data;
}

export const SupabaseBackend = {
  isConfigured: configured,
  get client() { return client; },

  initClient() {
    if (!configured()) return null;
    if (!client) {
      const { createClient } = requireClientLibrary();
      client = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_PUBLISHABLE_KEY, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
      });
    }
    return client;
  },

  async ensureAnonymousSession() {
    const c = this.initClient();
    if (!c) return null;
    const { data: sessionData, error: sessionError } = await c.auth.getSession();
    if (sessionError) throw sessionError;
    if (sessionData.session) return sessionData.session;
    return unwrap(await c.auth.signInAnonymously()).session;
  },

  async roster() {
    const c = this.initClient();
    if (!c) return [];
    const rows = unwrap(await c.rpc('dashboard_roster', { p_slug: CONFIG.CLAN_SLUG }));
    return (rows || []).map((r) => r.name).filter(Boolean);
  },

  async claim(memberName, password) {
    await this.ensureAnonymousSession();
    return unwrap(await client.rpc('dashboard_claim', {
      p_slug: CONFIG.CLAN_SLUG,
      p_member_name: memberName,
      p_password: password,
    }));
  },

  async profile() {
    const c = this.initClient();
    if (!c) return null;
    const { data: sessionData } = await c.auth.getSession();
    if (!sessionData.session) return null;
    return unwrap(await c.rpc('dashboard_profile')) || null;
  },

  async state() {
    await this.ensureAnonymousSession();
    return unwrap(await client.rpc('dashboard_state'));
  },

  async save(state, baseAdminRevision) {
    return unwrap(await client.rpc('dashboard_save', {
      p_state: state,
      p_base_admin_revision: baseAdminRevision,
    }));
  },

  async mutate(kind, payload, mutationId) {
    return unwrap(await client.rpc('dashboard_mutate', {
      p_kind: kind,
      p_payload: payload || {},
      p_mutation_id: mutationId,
    }));
  },

  async subscribe(clanId, onRevision) {
    if (!client || !clanId) return null;
    if (revisionChannel) await client.removeChannel(revisionChannel);
    revisionChannel = client.channel(`clan-revision:${clanId}`)
      .on('postgres_changes', {
        event: 'UPDATE', schema: 'public', table: 'clans', filter: `id=eq.${clanId}`,
      }, (payload) => onRevision?.(payload.new?.revision, payload))
      .subscribe();
    return revisionChannel;
  },

  async releaseIdentity() {
    if (revisionChannel && client) await client.removeChannel(revisionChannel);
    revisionChannel = null;
    if (client) return unwrap(await client.rpc('dashboard_release'));
    return true;
  },

  async signOut() {
    if (revisionChannel && client) await client.removeChannel(revisionChannel);
    revisionChannel = null;
    if (client) await client.auth.signOut();
  },
};
