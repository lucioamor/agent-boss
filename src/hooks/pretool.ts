// PreToolUse hook for executor sessions. Asks the supervisor whether this session may run
// the tool. Fails closed: if the supervisor can't be reached, the tool is denied.

const DENY_PREFIX = 'SUPERVISOR:';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function deny(reason: string) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
    }),
  );
}

const url = process.env.SUPERVISOR_URL;
const token = process.env.SUPERVISOR_TOKEN;
const epoch = Number(process.env.SUPERVISOR_EPOCH ?? 0);

try {
  const input = JSON.parse(await readStdin());
  if (!url || !token) {
    deny(`${DENY_PREFIX} hook running without supervisor context. End your turn.`);
  } else {
    const res = await fetch(`${url}/hook/pretool`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, epoch, tool_name: input.tool_name, tool_use_id: input.tool_use_id, tool_input: input.tool_input }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = (await res.json()) as { decision: string; reason?: string };
    // On allow, print nothing: the normal permission flow (mode + tools) still applies.
    if (d.decision !== 'allow') deny(d.reason ?? `${DENY_PREFIX} denied.`);
  }
} catch (err) {
  deny(`${DENY_PREFIX} supervisor unreachable (${(err as Error).message}). Do not call tools. End your turn.`);
}
