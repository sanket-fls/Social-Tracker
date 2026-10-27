// Start Claude's routine right away instead of waiting for its next scheduled run.
// Needs CLAUDE_ROUTINE_URL (the routine's Fire URL) and CLAUDE_ROUTINE_TOKEN, both from
// claude.ai/code/routines > the routine > Edit > Trigger > API. Without them Claude simply picks the post up on its next run.
export async function wakeClaude(text) {
  const url = process.env.CLAUDE_ROUTINE_URL, token = process.env.CLAUDE_ROUTINE_TOKEN;
  if (!url || !token) return { fired: false, reason: 'not_set_up' };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'experimental-cc-routine-2026-04-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text }),
    });
    return res.ok ? { fired: true } : { fired: false, reason: 'http_' + res.status };
  } catch (e) {
    return { fired: false, reason: 'unreachable' };
  }
}
