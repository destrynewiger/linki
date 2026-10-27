import { z } from "zod";
import { randomUUID } from "node:crypto";

import { getDb } from "@/lib/db";

const AccountStatusSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  is_authenticated: z.boolean(),
  timezone: z.string(),
  daily_connection_limit: z.number().int(),
  connections_sent_today: z.number().int(),
  connections_remaining_today: z.number().int(),
  pending_connection_reservations: z.number().int(),
  staging_slots_remaining: z.number().int(),
  daily_message_limit: z.number().int(),
  messages_sent_today: z.number().int(),
  messages_remaining_today: z.number().int(),
});

const WorkflowStatusSchema = z.object({
  id: z.string(),
  name: z.string(),
  run_id: z.string(),
  run_status: z.string(),
});

const ListStatusSchema = z.object({
  id: z.string(),
  name: z.string(),
  target_count: z.number().int(),
});

export const OutreachStatusSchema = z.object({
  account: AccountStatusSchema.nullable(),
  workflow: WorkflowStatusSchema.nullable(),
  list: ListStatusSchema.nullable(),
  configuration_valid: z.boolean(),
  ready_to_stage: z.boolean(),
  writes_enabled: z.boolean(),
});

export type OutreachStatus = z.infer<typeof OutreachStatusSchema>;

// Accept only public HTTPS profile addresses, never arbitrary runner navigation URLs.
export function canonicalLinkedInUrl(value: string): string {
  const url = new URL(value.trim());
  if (url.protocol !== "https:" || !["www.linkedin.com", "linkedin.com"].includes(url.hostname)
      || url.username || url.password || url.port
      || !/^\/in\/[a-zA-Z0-9._-]+\/?$/.test(url.pathname)) {
    throw new Error("Expected a public HTTPS LinkedIn /in/ profile URL.");
  }
  return `https://www.linkedin.com${url.pathname.replace(/\/$/, "")}`;
}

const ProfileUrlSchema = z.string().trim().max(2048).refine(value => {
  try { canonicalLinkedInUrl(value); return true; } catch { return false; }
}, "Expected a public HTTPS LinkedIn /in/ profile URL.");
const EvidenceUrlSchema = z.string().trim().url().max(2048).refine(value => {
  const url = new URL(value);
  return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password;
}, "Expected an HTTP(S) evidence URL without credentials.");

const StagedProspectSchema = z.object({
  account_key: z.string().trim().min(1).max(255),
  signal_key: z.string().trim().min(1).max(255),
  signal_source: z.string().trim().min(1).max(64),
  signal_url: EvidenceUrlSchema,
  signal_summary: z.string().trim().min(1).max(2000),
  linkedin_url: ProfileUrlSchema,
  first_name: z.string().trim().min(1).max(200),
  last_name: z.string().trim().min(1).max(200),
  title: z.string().trim().min(1).max(255),
  company: z.string().trim().min(1).max(255),
}).strict();

export const StageProspectsInputSchema = z.object({
  confirm_staging: z.literal(true),
  prospects: z.array(StagedProspectSchema).min(1).max(25),
}).strict();

export const StageProspectsOutputSchema = z.object({
  run_id: z.string(),
  run_status: z.literal("paused"),
  received: z.number().int(),
  staged: z.number().int(),
  created_targets: z.number().int(),
  added_to_list: z.number().int(),
  enrolled: z.number().int(),
  duplicate_signals: z.number().int(),
  new_accounts: z.number().int(),
  skipped_already_enrolled: z.number().int(),
  skipped_active_elsewhere: z.number().int(),
  outreach_started: z.literal(false),
});

export type StageProspectsInput = z.infer<typeof StageProspectsInputSchema>;
export type StageProspectsOutput = z.infer<typeof StageProspectsOutputSchema>;

const OUTREACH_DAILY_LIMIT = 25;

type AccountRow = {
  id: string;
  name: string;
  email: string;
  is_authenticated: number;
  timezone: string | null;
  daily_connection_limit: number;
  daily_message_limit: number;
  connections_sent_today: number;
  messages_sent_today: number;
  pending_connection_reservations: number;
};

type WorkflowRow = {
  id: string;
  name: string;
  run_id: string;
  run_status: string;
};

type ListRow = {
  id: string;
  name: string;
  target_count: number;
  purpose: string | null;
};

export function getOutreachStatus(): OutreachStatus {
  const accountId = process.env.MCP_ACCOUNT_ID;
  const workflowId = process.env.MCP_WORKFLOW_ID;
  const listId = process.env.MCP_LIST_ID;
  const writesEnabled = process.env.MCP_WRITES_ENABLED === "true";

  if (!accountId || !workflowId || !listId) {
    return {
      account: null,
      workflow: null,
      list: null,
      configuration_valid: false,
      ready_to_stage: false,
      writes_enabled: writesEnabled,
    };
  }

  const db = getDb();
  const account = db.prepare(
    `SELECT a.id, a.name, a.email, a.is_authenticated, a.timezone,
            a.daily_connection_limit, a.daily_message_limit,
            (SELECT COUNT(*) FROM logs l
             JOIN runs r ON r.id = l.run_id
             WHERE r.account_id = a.id
               AND l.message LIKE 'Connection request sent%'
               AND date(l.created_at) = date('now')) AS connections_sent_today,
            (SELECT COUNT(*) FROM logs l
             JOIN runs r ON r.id = l.run_id
             WHERE r.account_id = a.id
               AND l.message LIKE 'Message sent%'
               AND date(l.created_at) = date('now')) AS messages_sent_today,
            (SELECT COUNT(*) FROM run_profiles rp
             JOIN runs r ON r.id = rp.run_id
             JOIN run_profile_tracks rt ON rt.run_profile_id = rp.id
             JOIN targets t ON t.id = rp.target_id
             WHERE r.account_id = a.id AND r.status IN ('pending', 'paused', 'running')
               AND rt.track = 'linkedin' AND rt.state NOT IN ('completed', 'failed', 'skipped')
               AND t.connection_requested_at IS NULL) AS pending_connection_reservations
     FROM accounts a
     WHERE a.id = ?`,
  ).get(accountId) as AccountRow | undefined;

  const workflows = db.prepare(
    `SELECT w.id, w.name, r.id AS run_id, r.status AS run_status
     FROM workflows w
     JOIN runs r ON r.workflow_id = w.id
     WHERE w.id = ? AND r.account_id = ? AND r.list_id = ?
       AND r.status IN ('paused', 'running')
     ORDER BY r.id`,
  ).all(workflowId, accountId, listId) as WorkflowRow[];
  // Ambiguous queues must be repaired explicitly instead of picking an arbitrary run.
  const workflow = workflows.length === 1 ? workflows[0] : undefined;
  const steps = db.prepare(
    'SELECT step_type, track, connect_note FROM workflow_steps WHERE workflow_id = ? AND enabled = 1',
  ).all(workflowId) as { step_type: string; track: string; connect_note: string | null }[];
  const blankConnectOnly = steps.length === 1 && steps[0].step_type === 'connect'
    && steps[0].track === 'linkedin' && !(steps[0].connect_note ?? '').trim();

  const list = db.prepare(
    `SELECT l.id, l.name, l.purpose, COUNT(lt.target_id) AS target_count
     FROM lists l
     LEFT JOIN list_targets lt ON lt.list_id = l.id
     WHERE l.id = ?
     GROUP BY l.id`,
  ).get(listId) as ListRow | undefined;

  const normalizedAccount = account ? {
    id: account.id,
    name: account.name,
    email: account.email,
    is_authenticated: account.is_authenticated === 1,
    timezone: account.timezone ?? "UTC",
    daily_connection_limit: account.daily_connection_limit,
    connections_sent_today: account.connections_sent_today,
    connections_remaining_today: Math.max(
      0,
      Math.min(account.daily_connection_limit, OUTREACH_DAILY_LIMIT) - account.connections_sent_today,
    ),
    pending_connection_reservations: account.pending_connection_reservations,
    staging_slots_remaining: Math.max(0, Math.min(account.daily_connection_limit, OUTREACH_DAILY_LIMIT)
      - account.connections_sent_today - account.pending_connection_reservations),
    daily_message_limit: account.daily_message_limit,
    messages_sent_today: account.messages_sent_today,
    messages_remaining_today: Math.max(
      0,
      account.daily_message_limit - account.messages_sent_today,
    ),
  } : null;

  const normalizedWorkflow = workflow ? {
    id: workflow.id,
    name: workflow.name,
    run_id: workflow.run_id,
    run_status: workflow.run_status,
  } : null;

  const normalizedList = list ? {
    id: list.id,
    name: list.name,
    target_count: list.target_count,
  } : null;

  const configurationValid = Boolean(
    normalizedAccount &&
    normalizedAccount.is_authenticated &&
    Number.isInteger(normalizedAccount.daily_connection_limit) &&
    normalizedAccount.daily_connection_limit > 0 &&
    normalizedAccount.daily_connection_limit <= OUTREACH_DAILY_LIMIT &&
    blankConnectOnly && list?.purpose === "linkedin" &&
    normalizedWorkflow?.run_status === "paused" &&
    normalizedList,
  );

  return OutreachStatusSchema.parse({
    account: normalizedAccount,
    workflow: normalizedWorkflow,
    list: normalizedList,
    configuration_valid: configurationValid,
    ready_to_stage: configurationValid && writesEnabled,
    writes_enabled: writesEnabled,
  });
}

export function stageProspects(input: StageProspectsInput): StageProspectsOutput {
  const parsed = StageProspectsInputSchema.parse(input);
  for (const prospect of parsed.prospects) prospect.linkedin_url = canonicalLinkedInUrl(prospect.linkedin_url);
  // Serialize validation, reservation accounting, and insertion across processes.
  return getDb().transaction(() => stageInTransaction(parsed)).immediate();
}

function stageInTransaction(parsed: StageProspectsInput): StageProspectsOutput {
  const status = getOutreachStatus();
  if (!status.writes_enabled) {
    throw new Error("Staging is disabled. Set MCP_WRITES_ENABLED=true after reviewing the configured queue.");
  }
  if (!status.configuration_valid || !status.account || !status.workflow || !status.list) {
    throw new Error("The MCP account, paused workflow run, or list is not configured correctly.");
  }
  const account = status.account;
  const workflow = status.workflow;
  const list = status.list;
  let slots = account.staging_slots_remaining;
  const db = getDb();

  const counts = {
    staged: 0,
    created_targets: 0,
    added_to_list: 0,
    enrolled: 0,
    duplicate_signals: 0,
    new_accounts: 0,
    skipped_already_enrolled: 0,
    skipped_active_elsewhere: 0,
  };

  const findSignal = db.prepare(
    `SELECT e.id, t.linkedin_url FROM mcp_signal_events e LEFT JOIN targets t ON t.id = e.target_id
     WHERE e.source = ? AND e.account_key = ? AND e.signal_key = ?`,
  );
  const findAccountSignal = db.prepare(
    "SELECT id FROM mcp_signal_events WHERE source = ? AND account_key = ? LIMIT 1",
  );
  const findTargets = db.prepare("SELECT id, linkedin_url FROM targets WHERE linkedin_url LIKE ? ESCAPE '!' OR linkedin_url LIKE ? ESCAPE '!'");
  const insertTarget = db.prepare(
    `INSERT INTO targets
      (id, linkedin_url, first_name, last_name, full_name, title, company)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const fillTarget = db.prepare(
    `UPDATE targets SET
       first_name = COALESCE(first_name, ?),
       last_name = COALESCE(last_name, ?),
       full_name = COALESCE(full_name, ?),
       title = COALESCE(title, ?),
       company = COALESCE(company, ?)
     WHERE id = ?`,
  );
  const insertSignal = db.prepare(
    `INSERT INTO mcp_signal_events
      (id, source, signal_key, account_key, signal_url, signal_summary, target_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const addToList = db.prepare(
    "INSERT OR IGNORE INTO list_targets (list_id, target_id) VALUES (?, ?)",
  );
  const alreadyEnrolled = db.prepare(
    `SELECT 1 FROM run_profiles rp
     JOIN runs r ON r.id = rp.run_id
     WHERE r.workflow_id = ? AND rp.target_id = ?
     LIMIT 1`,
  );
  const activeElsewhere = db.prepare(
    `SELECT 1 FROM run_profiles rp
     JOIN runs r ON r.id = rp.run_id
     WHERE rp.target_id = ? AND r.status IN ('pending', 'running', 'paused')
       AND r.id != ?
       AND EXISTS (
         SELECT 1 FROM run_profile_tracks rt
         WHERE rt.run_profile_id = rp.id
           AND rt.state NOT IN ('completed', 'failed', 'skipped')
       )
     LIMIT 1`,
  );
  const insertProfile = db.prepare(
    "INSERT INTO run_profiles (id, run_id, target_id, email_account_id) VALUES (?, ?, ?, NULL)",
  );
  const insertTrack = db.prepare(
    `INSERT INTO run_profile_tracks
      (id, run_profile_id, track, state, current_step)
     VALUES (?, ?, 'linkedin', 'pending', 0)`,
  );

  for (const prospect of parsed.prospects) {
    const signalSource = prospect.signal_source.trim().toLowerCase();
    const accountKey = prospect.account_key.trim().toLowerCase();
    const signalKey = prospect.signal_key.trim();

    const priorSignal = findSignal.get(signalSource, accountKey, signalKey) as { linkedin_url: string | null } | undefined;
    if (priorSignal) {
      if (!priorSignal.linkedin_url || canonicalLinkedInUrl(priorSignal.linkedin_url) !== prospect.linkedin_url) {
        throw new Error("Signal key is already bound to a different or deleted profile. No prospects were staged.");
      }
      counts.duplicate_signals += 1;
      continue;
    }

    const isNewAccount = !findAccountSignal.get(signalSource, accountKey);

    const profilePath = new URL(prospect.linkedin_url).pathname.replace(/[!%_]/g, "!$&");
    const candidates = findTargets.all(`https://www.linkedin.com${profilePath}%`, `https://linkedin.com${profilePath}%`) as { id: string; linkedin_url: string }[];
    const matchingTargets = candidates.filter(target => {
      try { return canonicalLinkedInUrl(target.linkedin_url) === prospect.linkedin_url; } catch { return false; }
    });
    if (matchingTargets.length > 1) throw new Error("Multiple existing targets match this profile. Reconcile them before staging.");
    const existingTarget = matchingTargets[0];
    const targetId = existingTarget?.id ?? randomUUID();
    const fullName = `${prospect.first_name} ${prospect.last_name}`.trim();
    if (existingTarget) {
      fillTarget.run(
        prospect.first_name,
        prospect.last_name,
        fullName,
        prospect.title,
        prospect.company,
        targetId,
      );
    } else {
      insertTarget.run(
        targetId,
        prospect.linkedin_url,
        prospect.first_name,
        prospect.last_name,
        fullName,
        prospect.title,
        prospect.company,
      );
      counts.created_targets += 1;
    }

    insertSignal.run(
      randomUUID(),
      signalSource,
      signalKey,
      accountKey,
      prospect.signal_url,
      prospect.signal_summary,
      targetId,
    );
    counts.staged += 1;
    if (isNewAccount) counts.new_accounts += 1;

    if (addToList.run(list.id, targetId).changes > 0) {
      counts.added_to_list += 1;
    }

    if (alreadyEnrolled.get(workflow.id, targetId)) {
      counts.skipped_already_enrolled += 1;
      continue;
    }
    if (activeElsewhere.get(targetId, workflow.run_id)) {
      counts.skipped_active_elsewhere += 1;
      continue;
    }

    if (slots <= 0) throw new Error("No unreserved connection slots remain today. No prospects were staged.");
    slots -= 1;
    const runProfileId = randomUUID();
    insertProfile.run(runProfileId, workflow.run_id, targetId);
    insertTrack.run(randomUUID(), runProfileId);
    counts.enrolled += 1;
  }

  return StageProspectsOutputSchema.parse({
    run_id: workflow.run_id,
    run_status: "paused",
    received: parsed.prospects.length,
    ...counts,
    outreach_started: false,
  });
}
