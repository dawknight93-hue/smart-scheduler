import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const EXTRACTION_MODEL = "openai/gpt-oss-120b";

interface GoalResearchRequest {
  action: "kickoff" | "chat" | "history" | "cascade" | "daily";
  goal_id?: string;
  message?: string;
  sessions?: { ref: string; day: string; minutes: number }[];
}

interface TavilyResult {
  title: string;
  url: string;
  content: string;
}

interface Source {
  title: string;
  url: string;
}

interface GoalRow {
  id: string;
  pillar: string;
  specific: string | null;
  measurable: string | null;
  achievable: string | null;
  relevant: string | null;
  time_bound: string | null;
  status: string;
  approach: string | null;
  research_started: boolean;
  cadence_sessions_per_week: number | null;
  cadence_label: string | null;
  cadence_confirmed: boolean;
}

interface MessageRow {
  id: string;
  goal_id: string;
  role: "user" | "assistant";
  content: string;
  stage: "smart" | "research";
  created_at: string;
}

function stripSources(content: string): string {
  const idx = content.indexOf("\n\nSources:");
  return idx >= 0 ? content.slice(0, idx).trimEnd() : content;
}

function buildExtractionTranscript(messages: MessageRow[]): string {
  return messages.map((m) => `${m.role.toUpperCase()}: ${stripSources(m.content)}`).join("\n");
}

async function fetchWithRetry(
  url: string,
  options: RequestInit,
  maxRetries = 2,
): Promise<Response> {
  let lastResp: Response;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    lastResp = await fetch(url, options);
    if (lastResp.status !== 429) return lastResp;
    if (attempt === maxRetries) return lastResp;
    const body = await lastResp.text();
    const waitMatch = body.match(/try again in ~(\d+)s/);
    const waitSec = waitMatch ? parseInt(waitMatch[1], 10) : 5 * (attempt + 1);
    await new Promise((resolve) => setTimeout(resolve, waitSec * 1000));
  }
  return lastResp!;
}

// ---------------------------------------------------------------------------
// Model: Claude Sonnet 5 when ANTHROPIC_API_KEY is set, Groq otherwise (and as
// the fallback if Claude errors), so goal planning never stops working.

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const CLAUDE_MODEL = "claude-sonnet-5";
const CLAUDE_LABEL = "Claude Sonnet 5";
const GROQ_LABEL = "Groq gpt-oss-120b";

type ChatTurn = { role: "user" | "assistant"; content: string };

interface LLMResult {
  text: string;
  model: string;
  warning?: string;
}

/** Claude needs alternating turns that start and end with the user. */
function claudeTurns(turns: ChatTurn[]): ChatTurn[] {
  const out: ChatTurn[] = [];
  for (const t of turns) {
    const content = (t.content ?? "").trim();
    if (!content) continue;
    const last = out[out.length - 1];
    if (last && last.role === t.role) last.content += "\n\n" + content;
    else out.push({ role: t.role, content });
  }
  if (!out.length || out[0].role !== "user") out.unshift({ role: "user", content: "(Start of our conversation.)" });
  if (out[out.length - 1].role !== "user") out.push({ role: "user", content: "Please continue." });
  return out;
}

async function claudeCall(system: string, turns: ChatTurn[], maxTokens: number, key: string): Promise<string> {
  const resp = await fetchWithRetry(ANTHROPIC_URL, {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: maxTokens,
      thinking: { type: "disabled" },
      system,
      messages: claudeTurns(turns),
    }),
  });
  if (!resp.ok) throw new Error(`Claude request failed (${resp.status}): ${(await resp.text()).slice(0, 300)}`);
  const data = await resp.json();
  const text = ((data.content ?? []) as { type: string; text?: string }[])
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("")
    .trim();
  if (!text) throw new Error("Claude returned an empty reply.");
  return text;
}

async function groqCall(system: string, turns: ChatTurn[], json: boolean): Promise<string> {
  const resp = await fetchWithRetry(GROQ_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${Deno.env.get("GROQ_API_KEY")}` },
    body: JSON.stringify({
      model: EXTRACTION_MODEL,
      ...(json ? { response_format: { type: "json_object" } } : {}),
      messages: [{ role: "system", content: system }, ...turns],
    }),
  });
  if (!resp.ok) throw new Error(`Groq request failed: ${resp.status} ${await resp.text()}`);
  return String((await resp.json()).choices?.[0]?.message?.content ?? "").trim();
}

/** Pull the JSON object out of a reply (Claude may wrap it in a code fence). */
function parseJsonObject(text: string): any {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON object");
  return JSON.parse(body.slice(start, end + 1));
}

/**
 * One model call. With json=true the reply is parsed; if Claude's reply isn't
 * valid JSON (or Claude errors), the same request goes to Groq instead.
 */
async function llm(system: string, turns: ChatTurn[], opts: { json?: boolean; maxTokens?: number } = {}): Promise<LLMResult & { data?: any }> {
  const json = !!opts.json;
  const sys = json ? system + "\n\nReply with the JSON object only — no code fence, no text before or after it." : system;
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  let warning: string | undefined;
  if (key) {
    try {
      const text = await claudeCall(sys, turns, opts.maxTokens ?? 2000, key);
      return json ? { text, model: CLAUDE_LABEL, data: parseJsonObject(text) } : { text, model: CLAUDE_LABEL };
    } catch (e) {
      console.error("Claude failed, using Groq:", e);
      warning = String(e instanceof Error ? e.message : e).slice(0, 200);
    }
  }
  const text = await groqCall(sys, turns, json);
  const model = `${GROQ_LABEL} (${key ? "Claude unavailable" : "Claude key not set"})`;
  if (!json) return { text, model, warning };
  let data: any;
  try {
    data = parseJsonObject(text);
  } catch {
    data = undefined;
  }
  return { text, model, warning, data };
}

async function fetchGoal(goalId: string): Promise<GoalRow> {
  const { data, error } = await supabase
    .from("goals")
    .select("id, pillar, specific, measurable, achievable, relevant, time_bound, status, approach, research_started, cadence_sessions_per_week, cadence_label, cadence_confirmed")
    .eq("id", goalId)
    .maybeSingle();

  if (error) throw new Error(`Failed to load goal: ${error.message}`);
  if (!data) throw new Error("Goal not found.");
  return data as GoalRow;
}

async function fetchAllMessages(goalId: string): Promise<MessageRow[]> {
  const { data, error } = await supabase
    .from("goal_messages")
    .select("id, goal_id, role, content, stage, created_at")
    .eq("goal_id", goalId)
    .order("created_at", { ascending: true });

  if (error) throw new Error(`Failed to load conversation: ${error.message}`);
  return (data || []) as MessageRow[];
}

async function saveMessage(goalId: string, role: "user" | "assistant", content: string) {
  const { error } = await supabase
    .from("goal_messages")
    .insert({ goal_id: goalId, role, content, stage: "research" });
  if (error) throw new Error(`Failed to save message: ${error.message}`);
}

function buildResearchSystemPrompt(goal: GoalRow): string {
  const summary = [
    goal.specific ? `Specific: ${goal.specific}` : null,
    goal.measurable ? `Measurable: ${goal.measurable}` : null,
    goal.achievable ? `Achievable: ${goal.achievable}` : null,
    goal.relevant ? `Relevant: ${goal.relevant}` : null,
    goal.time_bound ? `Time-bound: ${goal.time_bound}` : null,
  ].filter(Boolean).join(" | ");

  return (
    "You are a goal-planning coach helping the user figure out HOW to actually achieve a SMART goal they have already locked in. " +
    "Their goal: " + summary + ". " +
    "Drawing on your own knowledge, suggest real, well-known, specific approaches, methods, programs, tools, or coaches relevant to this exact goal. Bring back concrete named options, not generic platitudes, each with a short reason it could fit this person's situation. " +
    "Talk to the user conversationally, one exchange at a time, like a knowledgeable coach walking them through choices, not a report. Surface 2-4 strong candidates at a time rather than a giant list, explain trade-offs briefly, answer follow-up questions, and help them reason toward a decision. " +
    "You must write in plain conversational prose only, as if you are talking out loud to the user. Do NOT use any markdown formatting: no headers, no bold or asterisks, no italics, no tables, no dash or numbered list syntax, no bullet points. When naming 2-4 concrete options, introduce each one by name in a flowing sentence and describe it and its trade-off in plain text, for example 'One option is Headspace, which walks beginners through short guided sessions and gradually adds a minute or two each week. It costs a few dollars a month after the trial, but the built-in pacing matches what you need.' rather than listing them with bullets or a table. Keep paragraphs short since this is a chat conversation, not a report. Separate each distinct thought or option into its own short paragraph with a blank line (a double newline) between paragraphs. CRITICAL FORMATTING RULE: You must separate every distinct thought, option, or response into its own short paragraph by inserting a blank line (press Enter twice, producing a double newline) between paragraphs. Never write two paragraphs on adjacent lines with no gap between them. Each option you present must be its own paragraph with a blank line before and after it. This is essential because the user's chat interface renders blank lines as visual paragraph breaks. " +
    "Push back gently if an option seems mismatched to their stated baseline or timeline. " +
    "Once the user clearly settles on one specific approach, reflect it back to them in a sentence or two so they can confirm it, and treat the research phase as done once they do."
  );
}

async function searchTavily(query: string): Promise<TavilyResult[]> {
  const apiKey = Deno.env.get("TAVILY_API_KEY");
  if (!apiKey) return [];

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const resp = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        max_results: 5,
        include_answer: false,
      }),
      signal: controller.signal,
    });
    if (!resp.ok) return [];
    const data = await resp.json();
    const results = Array.isArray(data?.results) ? data.results : [];
    return results
      .filter((r: Record<string, unknown>) => typeof r?.url === "string" && typeof r?.title === "string")
      .map((r: Record<string, unknown>) => ({
        title: r.title as string,
        url: r.url as string,
        content: typeof r.content === "string" ? r.content : "",
      }))
      .slice(0, 5);
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

function buildSearchQuery(goal: GoalRow, userMessage: string | null): string {
  const parts = [goal.specific, goal.pillar].filter(Boolean);
  if (userMessage) parts.push(userMessage);
  return parts.join(" ").slice(0, 200);
}

function formatSearchContext(results: TavilyResult[]): string {
  if (results.length === 0) return "";
  const lines = results.map((r, i) =>
    `[${i + 1}] ${r.title}\n    ${r.url}\n    ${r.content.slice(0, 300)}`
  );
  return "Here are relevant web search results to ground your suggestions. Reference them by number when relevant, and include the URL when you mention a specific source:\n\n" + lines.join("\n\n");
}

async function callResearchModel(
  systemPrompt: string,
  history: MessageRow[],
  newUserMessage: string | null,
  goal: GoalRow,
): Promise<{ reply: string; sources: Source[] }> {
  const searchQuery = buildSearchQuery(goal, newUserMessage);
  const searchResults = await searchTavily(searchQuery);
  const searchContext = formatSearchContext(searchResults);
  const sources: Source[] = searchResults.map((r) => ({ title: r.title, url: r.url }));

  const systemContent = searchContext
    ? systemPrompt + "\n\n" + searchContext
    : systemPrompt;

  const turns: ChatTurn[] = history.map((m) => ({ role: m.role, content: m.content }));
  if (newUserMessage) turns.push({ role: "user", content: newUserMessage });

  const { text, model } = await llm(systemContent, turns, { maxTokens: 2000 });
  lastModel = model;
  return { reply: text, sources };
}

/** Which model answered the most recent chat turn (reported back to the app). */
let lastModel: string | null = null;

async function extractApproach(
  goal: GoalRow,
  researchMessages: MessageRow[],
): Promise<{ approach_chosen: boolean; approach: string | null }> {
  const transcript = buildExtractionTranscript(researchMessages);

  const { data: parsed } = await llm(
    "You extract structured state from a coaching conversation about choosing an approach to achieve a goal. " +
      "Decide whether the user has clearly settled on one specific approach to pursue. " +
      "Respond with a single JSON object and no other text, with keys: approach_chosen (boolean), approach (a short string naming and briefly describing the chosen approach, or null if not chosen yet).",
    [{ role: "user", content: `Goal: ${goal.specific ?? "n/a"}\n\nTranscript:\n${transcript}` }],
    { json: true, maxTokens: 600 },
  );
  try {
    if (!parsed) throw new Error("unreadable");
    return {
      approach_chosen: Boolean(parsed.approach_chosen),
      approach: typeof parsed.approach === "string" ? parsed.approach : null,
    };
  } catch {
    return { approach_chosen: false, approach: null };
  }
}

async function extractCadence(
  goal: GoalRow,
  researchMessages: MessageRow[],
): Promise<{ sessions_per_week: number | null; label: string | null; confirmed: boolean }> {
  const transcript = buildExtractionTranscript(researchMessages);

  const { data: parsed } = await llm(
            "You extract the weekly session frequency being discussed for a chosen approach to a goal. " +
            "Read the conversation and determine what weekly frequency is currently being discussed, even if tentative (e.g. 'probably 3 to 4 times a week'). " +
            "Also decide whether the user has clearly committed to one specific number (not a range or possibility). " +
            "Respond with a single JSON object and no other text, with keys: sessions_per_week (integer or null, use the midpoint of a range if discussed), label (a short display string like '4x/week' or '~3x/week?' or null), confirmed (boolean, true only if the user has committed to a specific number).",
    [{ role: "user", content: `Goal: ${goal.specific ?? "n/a"}\nChosen approach: ${goal.approach ?? "n/a"}\n\nTranscript:\n${transcript}` }],
    { json: true, maxTokens: 600 },
  );
  try {
    if (!parsed) throw new Error("unreadable");
    return {
      sessions_per_week: typeof parsed.sessions_per_week === "number" ? parsed.sessions_per_week : null,
      label: typeof parsed.label === "string" ? parsed.label : null,
      confirmed: Boolean(parsed.confirmed),
    };
  } catch {
    return { sessions_per_week: null, label: null, confirmed: false };
  }
}

function withSources(reply: string, sources: Source[]): string {
  if (sources.length === 0) return reply;
  return `${reply}\n\nSources:\n${sources.map((s) => `- [${s.title}](${s.url})`).join("\n")}`;
}

async function handleKickoff(goalId: string) {
  const goal = await fetchGoal(goalId);

  if (!goal.research_started) {
    const systemPrompt = buildResearchSystemPrompt(goal);
    const { reply, sources } = await callResearchModel(
      systemPrompt,
      [],
      "Please research and suggest a few concrete approaches for achieving this goal.",
      goal,
    );
    await saveMessage(goalId, "assistant", withSources(reply, sources));

    const { error: updateError } = await supabase
      .from("goals")
      .update({ research_started: true })
      .eq("id", goalId);
    if (updateError) throw new Error(`Failed to update goal: ${updateError.message}`);
  }

  const messages = await fetchAllMessages(goalId);
  const refreshed = await fetchGoal(goalId);
  return { messages, goal_status: refreshed.status, approach: refreshed.approach, cadence_sessions_per_week: refreshed.cadence_sessions_per_week, cadence_label: refreshed.cadence_label, cadence_confirmed: refreshed.cadence_confirmed, model: lastModel };
}

async function handleChat(goalId: string, userMessage: string) {
  const goal = await fetchGoal(goalId);
  await saveMessage(goalId, "user", userMessage);

  const allMessages = await fetchAllMessages(goalId);
  const researchHistory = allMessages.filter((m) => m.stage === "research" && m.content !== userMessage);

  const systemPrompt = buildResearchSystemPrompt(goal);
  const { reply, sources } = await callResearchModel(systemPrompt, researchHistory.slice(0, -1), userMessage, goal);
  const fullReply = withSources(reply, sources);
  await saveMessage(goalId, "assistant", fullReply);

  const updatedMessages = await fetchAllMessages(goalId);
  const updatedResearchHistory = updatedMessages.filter((m) => m.stage === "research");
  const extraction = await extractApproach(goal, updatedResearchHistory);

  let goalStatus = goal.status;
  let approach = goal.approach;
  if (extraction.approach_chosen && extraction.approach) {
    const { error: updateError } = await supabase
      .from("goals")
      .update({ approach: extraction.approach, status: "approach_chosen" })
      .eq("id", goalId);
    if (updateError) throw new Error(`Failed to update goal: ${updateError.message}`);
    goalStatus = "approach_chosen";
    approach = extraction.approach;
  }

  const refreshedGoal = await fetchGoal(goalId);
  let cadenceSessions: number | null = refreshedGoal.cadence_sessions_per_week;
  let cadenceLabel: string | null = refreshedGoal.cadence_label;
  let cadenceConfirmed = refreshedGoal.cadence_confirmed;

  if (refreshedGoal.status === "approach_chosen" && !refreshedGoal.cadence_confirmed) {
    const cadence = await extractCadence(refreshedGoal, updatedResearchHistory);
    const updatePayload: Record<string, unknown> = {};
    if (cadence.sessions_per_week !== null) {
      updatePayload.cadence_sessions_per_week = cadence.sessions_per_week;
      cadenceSessions = cadence.sessions_per_week;
    }
    if (cadence.label !== null) {
      updatePayload.cadence_label = cadence.label;
      cadenceLabel = cadence.label;
    }
    if (cadence.confirmed) {
      updatePayload.cadence_confirmed = true;
      updatePayload.status = "active";
      cadenceConfirmed = true;
      goalStatus = "active";
    }
    if (Object.keys(updatePayload).length > 0) {
      const { error: cadenceError } = await supabase
        .from("goals")
        .update(updatePayload)
        .eq("id", goalId);
      if (cadenceError) throw new Error(`Failed to update cadence: ${cadenceError.message}`);
    }
  }

  return { messages: updatedMessages, goal_status: goalStatus, approach, cadence_sessions_per_week: cadenceSessions, cadence_label: cadenceLabel, cadence_confirmed: cadenceConfirmed, model: lastModel };
}

// ---------------------------------------------------------------------------
// Cascade: turn an active goal (approach + cadence) into internal milestones
// and a concrete weekly target. Only the weekly target ever reaches the
// calendar (through the Weekly Review); milestones stay inside the app.

interface Milestone {
  id: string;
  level: "year" | "quarter" | "month" | "week";
  title: string;
  due: string; // YYYY-MM-DD
  metric: string | null;
  done: boolean;
}

const CONTEXTS = ["desk", "home", "phone", "errand", "other"];

async function handleCascade(goalId: string) {
  const { data: goal, error } = await supabase
    .from("goals")
    .select("id, pillar, specific, measurable, achievable, relevant, time_bound, status, approach, deadline, cadence_sessions_per_week, cadence_label, cadence_confirmed, milestones")
    .eq("id", goalId)
    .maybeSingle();
  if (error) throw new Error(`Failed to load goal: ${error.message}`);
  if (!goal) throw new Error("Goal not found.");
  if (!goal.approach) throw new Error("This goal has no approach yet — finish Research first.");
  if (!goal.cadence_sessions_per_week) throw new Error("This goal has no weekly cadence yet — settle one in the Research chat first.");

  const today = new Date().toISOString().slice(0, 10);
  const system =
    "You are a planning assistant that breaks a SMART goal into a cascade of checkpoints. Today is " + today + ". " +
    "Scale the cascade to how far away the deadline is: 8 weeks or less -> one 'week' checkpoint per remaining week; up to 6 months -> one 'month' checkpoint per remaining month; up to 2 years -> 'quarter' checkpoints plus 'month' checkpoints for the next 3 months; longer -> 'year' checkpoints plus 'quarter' checkpoints for the next 12 months. " +
    "Each checkpoint is a concrete, measurable intermediate result on the way to the goal (e.g. 'Weigh 202 lb', 'Run 2 mi in 21:45'), with a due date on or before the goal deadline, never in the past. The final checkpoint is the goal itself on the deadline. " +
    "Also produce the weekly target that makes the plan happen: sessions_per_week (use the user's committed cadence), session_minutes (a realistic length for one session of the chosen approach), context (one of desk, home, phone, errand, other — where the session happens), label (a 1-4 word name for one session, e.g. 'Run', 'Budget check-in', 'Read Bible'), " +
    "and plan_mode: 'count' if the chosen approach is an app or service that already puts each session on the user's calendar by itself (for example Runna syncing workouts to Google Calendar), otherwise 'schedule'. " +
    "If the goal's deadline is not given, derive it from the time-bound text as a calendar date. " +
    "Respond with one JSON object only: {\"deadline\": \"YYYY-MM-DD\", \"milestones\": [{\"level\": \"year|quarter|month|week\", \"title\": string, \"due\": \"YYYY-MM-DD\", \"metric\": string|null}], \"weekly_target\": {\"label\": string, \"sessions_per_week\": integer, \"session_minutes\": integer, \"context\": string, \"plan_mode\": \"schedule|count\"}}.";
  const user =
    `Pillar: ${goal.pillar}\nSpecific: ${goal.specific ?? "n/a"}\nMeasurable: ${goal.measurable ?? "n/a"}\nAchievable: ${goal.achievable ?? "n/a"}\n` +
    `Relevant: ${goal.relevant ?? "n/a"}\nTime-bound: ${goal.time_bound ?? "n/a"}\nDeadline: ${goal.deadline ? String(goal.deadline).slice(0, 10) : "not set"}\n` +
    `Chosen approach: ${goal.approach}\nCommitted cadence: ${goal.cadence_label ?? goal.cadence_sessions_per_week + "x/week"}`;

  const planned = await llm(system, [{ role: "user", content: user }], { json: true, maxTokens: 4000 });
  const parsed: any = planned.data;
  if (!parsed) throw new Error("The planner returned something unreadable — try Generate plan again.");

  const isDate = (v: unknown) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
  const deadline = isDate(parsed.deadline) ? parsed.deadline : goal.deadline ? String(goal.deadline).slice(0, 10) : null;
  const milestones: Milestone[] = (Array.isArray(parsed.milestones) ? parsed.milestones : [])
    .filter((m: any) => m && typeof m.title === "string" && isDate(m.due) && ["year", "quarter", "month", "week"].includes(m.level))
    .map((m: any) => ({ id: crypto.randomUUID(), level: m.level, title: m.title.trim(), due: m.due, metric: typeof m.metric === "string" ? m.metric : null, done: false }))
    .sort((a: Milestone, b: Milestone) => a.due.localeCompare(b.due));
  const wt = parsed.weekly_target ?? {};
  const sessions = Number.isInteger(wt.sessions_per_week) && wt.sessions_per_week > 0 ? wt.sessions_per_week : goal.cadence_sessions_per_week;
  const minutes = Number.isInteger(wt.session_minutes) && wt.session_minutes >= 10 ? Math.min(wt.session_minutes, 240) : 30;
  const context = CONTEXTS.includes(wt.context) ? wt.context : "other";
  const label = typeof wt.label === "string" && wt.label.trim() ? wt.label.trim().slice(0, 40) : "Session";
  const planMode = wt.plan_mode === "count" ? "count" : "schedule";

  const update: Record<string, unknown> = {
    milestones,
    weekly_target: label,
    session_minutes: minutes,
    session_context: context,
    cascade_generated_at: new Date().toISOString(),
  };
  // End of the deadline day in Eastern time (03:59 UTC the next day).
  if (deadline) update.deadline = new Date(Date.parse(`${deadline}T00:00:00Z`) + (24 + 4) * 3600 * 1000 - 60 * 1000).toISOString();
  // Only set the plan mode the first time; after that it's the user's choice.
  const { data: cur } = await supabase.from("goals").select("plan_mode").eq("id", goalId).maybeSingle();
  if (!cur?.plan_mode) update.plan_mode = planMode;
  if (sessions !== goal.cadence_sessions_per_week) update.cadence_sessions_per_week = sessions;

  const { data: saved, error: saveErr } = await supabase.from("goals").update(update).eq("id", goalId).select("*").maybeSingle();
  if (saveErr) throw new Error(`Failed to save the plan: ${saveErr.message}`);
  return { goal: saved, model: planned.model };
}

/**
 * Daily level of the cascade: one short focus line (plus up to 3 steps) for
 * each approved session this week, written from the goal's next checkpoint and
 * what got done in recent sessions. Returns the lines; the app saves them.
 */
async function handleDaily(goalId: string, sessions: { ref: string; day: string; minutes: number }[]) {
  if (!sessions.length) return { items: [] };
  const { data: goal, error } = await supabase
    .from("goals")
    .select("id, pillar, specific, measurable, time_bound, approach, deadline, weekly_target, cadence_label, milestones")
    .eq("id", goalId)
    .maybeSingle();
  if (error) throw new Error(`Failed to load goal: ${error.message}`);
  if (!goal) throw new Error("Goal not found.");

  const today = new Date().toISOString().slice(0, 10);
  const open = ((goal.milestones ?? []) as Milestone[]).filter((m) => !m.done).sort((a, b) => a.due.localeCompare(b.due)).slice(0, 3);
  const since = new Date(Date.now() - 21 * 86400000).toISOString().slice(0, 10);
  const { data: recent } = await supabase
    .from("goal_daily_items")
    .select("day, focus, done")
    .eq("goal_id", goalId)
    .gte("day", since)
    .lt("day", today)
    .order("day");

  const system =
    "You turn a goal's weekly sessions into a day-by-day plan. Today is " + today + ". " +
    "For each session, write a focus: one concrete thing to do in that session, 3 to 9 words, imperative, specific to the chosen approach and the next checkpoint (e.g. 'Log August spending into the budget sheet', 'Read Romans 5 and journal one takeaway'). " +
    "Add 0 to 3 short steps only if they help; they must fit in the session length. " +
    "Build the sessions on each other across the week so they move toward the next checkpoint; if a recent session was not done, pick its work back up first. " +
    "Don't invent facts about the user, don't repeat the same focus twice, and don't restate the goal. " +
    "Respond with one JSON object only: {\"items\": [{\"ref\": string, \"focus\": string, \"steps\": [string]}]} with exactly one item per session ref given.";
  const user =
    `Pillar: ${goal.pillar}\nGoal: ${goal.specific ?? "n/a"}\nMeasure: ${goal.measurable ?? "n/a"}\nDeadline: ${goal.deadline ? String(goal.deadline).slice(0, 10) : goal.time_bound ?? "n/a"}\n` +
    `Approach: ${goal.approach ?? "n/a"}\nSession name: ${goal.weekly_target ?? "Session"} (${goal.cadence_label ?? ""})\n` +
    `Next checkpoints: ${open.length ? open.map((m) => `${m.title} by ${m.due}${m.metric ? ` (${m.metric})` : ""}`).join("; ") : "none left"}\n` +
    `Recent sessions: ${(recent ?? []).length ? (recent ?? []).map((r: any) => `${r.day} ${r.done ? "[done]" : "[not done]"} ${r.focus}`).join("; ") : "none yet"}\n` +
    `Sessions this week:\n${sessions.map((s) => `- ref ${s.ref}: ${s.day}, ${s.minutes} min`).join("\n")}`;

  const planned = await llm(system, [{ role: "user", content: user }], { json: true, maxTokens: 2500 });
  const parsed: any = planned.data;
  if (!parsed) throw new Error("The planner returned something unreadable — try again.");
  const refs = new Set(sessions.map((s) => s.ref));
  const items = (Array.isArray(parsed.items) ? parsed.items : [])
    .filter((i: any) => i && refs.has(String(i.ref)) && typeof i.focus === "string" && i.focus.trim())
    .map((i: any) => ({
      ref: String(i.ref),
      focus: i.focus.trim().replace(/\.$/, "").slice(0, 120),
      steps: (Array.isArray(i.steps) ? i.steps : []).filter((x: unknown) => typeof x === "string" && x.trim()).map((x: string) => x.trim().slice(0, 120)).slice(0, 3),
    }));
  return { items, model: planned.model };
}

async function handleHistory(goalId: string) {
  const goal = await fetchGoal(goalId);
  const messages = await fetchAllMessages(goalId);
  return { messages, goal_status: goal.status, approach: goal.approach, cadence_sessions_per_week: goal.cadence_sessions_per_week, cadence_label: goal.cadence_label, cadence_confirmed: goal.cadence_confirmed };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const body: GoalResearchRequest = await req.json();
    let result: Record<string, unknown>;

    switch (body.action) {
      case "kickoff": {
        if (!body.goal_id) throw new Error("goal_id is required.");
        result = await handleKickoff(body.goal_id);
        break;
      }
      case "chat": {
        if (!body.goal_id) throw new Error("goal_id is required.");
        if (!body.message) throw new Error("message is required.");
        result = await handleChat(body.goal_id, body.message);
        break;
      }
      case "history": {
        if (!body.goal_id) throw new Error("goal_id is required.");
        result = await handleHistory(body.goal_id);
        break;
      }
      case "cascade": {
        if (!body.goal_id) throw new Error("goal_id is required.");
        result = await handleCascade(body.goal_id);
        break;
      }
      case "daily": {
        if (!body.goal_id) throw new Error("goal_id is required.");
        if (!Array.isArray(body.sessions)) throw new Error("sessions is required.");
        result = await handleDaily(body.goal_id, body.sessions.slice(0, 14));
        break;
      }
      default:
        throw new Error("Unknown action.");
    }

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error.";
    return new Response(JSON.stringify({ error: message }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});


