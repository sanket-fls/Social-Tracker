// Public settings the browser needs to sign in and read live data. The anon key is safe to expose; row-level security protects the data.
// openAccess (OPEN_ACCESS=1) tells the page to skip sign-in and use /api/docs instead. teamName (TEAM_NAME) brands the page.
import { send } from '../lib/auth.js';
import { maxUploadMb, BIG_UPLOAD_MB } from '../lib/store.js';

export default async function handler(req, res) {
  send(res, 200, { supabaseUrl: process.env.SUPABASE_URL || '', supabaseAnonKey: process.env.SUPABASE_ANON_KEY || '', openAccess: process.env.OPEN_ACCESS === '1', teamName: process.env.TEAM_NAME || '', maxUploadMb: await maxUploadMb(), bigUploadMb: BIG_UPLOAD_MB });
}
