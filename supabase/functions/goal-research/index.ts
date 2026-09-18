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
const COMPOUND_MODEL = "openai/gpt-oss-120b";
const EXTRACTION_MODEL = "openai/gpt-oss-120b";

interface GoalResearchRequest {
  action: "kickoff" | "chat" | "history";
  goal_id?: string;
  message?: string;
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

async function callGroqCompound(
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

  const messages = [
    { role: "system", content: systemContent },
    ...history.map((m) => ({ role: m.role, content: m.content })),
  ];
  if (newUserMessage) messages.push({ role: "user", content: newUserMessage });

  const resp = await fetch(GROQ_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${Deno.env.get("GROQ_API_KEY")}`,
    },
    body: JSON.stringify({
      model: COMPOUND_MODEL,
      messages,
    }),
  });

  if (!resp.ok) {
    throw new Error(`Groq compound request failed: ${resp.status} ${await resp.text()}`);
  }

  const data = await resp.json();
  const reply: string = data.choices?.[0]?.message?.content ?? "";

  return { reply, sources };
}

async function extractApproach(
  goal: GoalRow,
  researchMessages: MessageRow[],
): Promise<{ approach_chosen: boolean; approach: string | null }> {
  const transcript = buildExtractionTranscript(researchMessages);

  const resp = await fetchWithRetry(GROQ_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${Deno.env.get("GROQ_API_KEY")}`,
    },
    body: JSON.stringify({
      model: EXTRACTION_MODEL,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You extract structured state from a coaching conversation about choosing an approach to achieve a goal. " +
            "Decide whether the user has clearly settled on one specific approach to pursue. " +
            "Respond with a single JSON object and no other text, with keys: approach_chosen (boolean), approach (a short string naming and briefly describing the chosen approach, or null if not chosen yet).",
        },
        { role: "user", content: `Goal: ${goal.specific ?? "n/a"}\n\nTranscript:\n${transcript}` },
      ],
    }),
  });

  if (!resp.ok) {
    throw new Error(`Groq extraction request failed: ${resp.status} ${await resp.text()}`);
  }

  const data = await resp.json();
  const content: string = data.choices?.[0]?.message?.content ?? "{}";
  try {
    const parsed = JSON.parse(content);
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

  const resp = await fetchWithRetry(GROQ_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${Deno.env.get("GROQ_API_KEY")}`,
    },
    body: JSON.stringify({
      model: EXTRACTION_MODEL,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You extract the weekly session frequency being discussed for a chosen approach to a goal. " +
            "Read the conversation and determine what weekly frequency is currently being discussed, even if tentative (e.g. 'probably 3 to 4 times a week'). " +
            "Also decide whether the user has clearly committed to one specific number (not a range or possibility). " +
            "Respond with a single JSON object and no other text, with keys: sessions_per_week (integer or null, use the midpoint of a range if discussed), label (a short display string like '4x/week' or '~3x/week?' or null), confirmed (boolean, true only if the user has committed to a specific number).",
        },
        { role: "user", content: `Goal: ${goal.specific ?? "n/a"}\nChosen approach: ${goal.approach ?? "n/a"}\n\nTranscript:\n${transcript}` },
      ],
    }),
  });

  if (!resp.ok) {
    throw new Error(`Groq cadence extraction request failed: ${resp.status} ${await resp.text()}`);
  }

  const data = await resp.json();
  const content: string = data.choices?.[0]?.message?.content ?? "{}";
  try {
    const parsed = JSON.parse(content);
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
    const { reply, sources } = await callGroqCompound(
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
  return { messages, goal_status: refreshed.status, approach: refreshed.approach, cadence_sessions_per_week: refreshed.cadence_sessions_per_week, cadence_label: refreshed.cadence_label, cadence_confirmed: refreshed.cadence_confirmed };
}

async function handleChat(goalId: string, userMessage: string) {
  const goal = await fetchGoal(goalId);
  await saveMessage(goalId, "user", userMessage);

  const allMessages = await fetchAllMessages(goalId);
  const researchHistory = allMessages.filter((m) => m.stage === "research" && m.content !== userMessage);

  const systemPrompt = buildResearchSystemPrompt(goal);
  const { reply, sources } = await callGroqCompound(systemPrompt, researchHistory.slice(0, -1), userMessage, goal);
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

  return { messages: updatedMessages, goal_status: goalStatus, approach, cadence_sessions_per_week: cadenceSessions, cadence_label: cadenceLabel, cadence_confirmed: cadenceConfirmed };
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
