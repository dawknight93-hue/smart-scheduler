import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "openai/gpt-oss-120b";

function buildSystemPrompt(): string {
  const today = new Date().toISOString().slice(0, 10);
  return "You are a goal-planning coach helping the user turn a rough goal into a SMART goal: Specific, Measurable, Achievable, Relevant, and Time-bound. Work through this conversationally, one or two questions at a time, like a coach would, never reciting the five letters as a checklist. Push back on vague answers such as faster, better, or someday, and ask for concrete numbers and a current baseline. Today's date is " + today + ". Whenever the user has given you a current value, a target value, and a rate of change (for example, a starting weight, a goal weight, and a pace per week), you must do the arithmetic yourself: compute the number of weeks or days required, add that to today's date, and state the resulting specific calendar date back to the user as the deadline (e.g. \"at 1.5-2 lb per week, that puts you at 190 lb by around November 23, 2026\") instead of asking them to pick a date out of thin air. Only ask the user to choose a deadline directly when there is no rate or pace given from which one could be computed. Once all five criteria genuinely hold up, say so plainly and stop asking further questions. You must always respond with a single JSON object and no other text, with keys: reply (a string, your natural-language response to show the user), complete (boolean, true only once all five criteria are solidly established), pillar (one of spiritual, family, mil_career, civ_career, financial, physical, mental, or null), specific (string or null), measurable (string or null), achievable (string or null), relevant (string or null), time_bound (string or null). Fill in whichever fields have been established so far even before complete is true, so progress is not lost if the conversation is interrupted.";
}

interface SmartGateRequest {
  action: "chat" | "history" | "approve";
  goal_id?: string;
  message?: string;
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
}

interface MessageRow {
  id: string;
  goal_id: string;
  role: string;
  content: string;
  created_at: string;
}

interface GroqChoice {
  message: { content: string };
}

interface GroqResponse {
  choices: GroqChoice[];
}

interface SmartGateLLMReply {
  reply: string;
  complete: boolean;
  pillar: string | null;
  specific: string | null;
  measurable: string | null;
  achievable: string | null;
  relevant: string | null;
  time_bound: string | null;
}

async function fetchGoal(goalId: string): Promise<GoalRow> {
  const { data, error } = await supabase
    .from("goals")
    .select("id, pillar, specific, measurable, achievable, relevant, time_bound, status")
    .eq("id", goalId)
    .maybeSingle();

  if (error) throw new Error(`Failed to load goal: ${error.message}`);
  if (!data) throw new Error("Goal not found.");
  return data as GoalRow;
}

async function fetchMessages(goalId: string): Promise<MessageRow[]> {
  const { data, error } = await supabase
    .from("goal_messages")
    .select("id, goal_id, role, content, created_at")
    .eq("goal_id", goalId)
    .order("created_at", { ascending: true });

  if (error) throw new Error(`Failed to load conversation: ${error.message}`);
  return (data ?? []) as MessageRow[];
}

async function saveMessage(goalId: string, role: string, content: string): Promise<void> {
  const { error } = await supabase
    .from("goal_messages")
    .insert({ goal_id: goalId, role, content });

  if (error) throw new Error(`Failed to save ${role} message: ${error.message}`);
}

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const CLAUDE_MODEL = "claude-sonnet-5";

type ChatTurn = { role: "user" | "assistant"; content: string };

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

/** Pull the JSON object out of a reply (Claude may wrap it in a code fence). */
function parseReply(content: string, who: string): SmartGateLLMReply {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : content;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  let parsed: SmartGateLLMReply;
  try {
    if (start < 0 || end <= start) throw new Error("no object");
    parsed = JSON.parse(body.slice(start, end + 1)) as SmartGateLLMReply;
  } catch {
    throw new GroqUpstreamError(`${who} returned non-JSON content.`);
  }
  if (typeof parsed.reply !== "string") throw new GroqUpstreamError(`${who} response missing 'reply' field.`);
  return parsed;
}

async function callClaude(messages: MessageRow[], key: string): Promise<SmartGateLLMReply> {
  const resp = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 2000,
      thinking: { type: "disabled" },
      system: buildSystemPrompt() + "\n\nReply with the JSON object only — no code fence, no text before or after it.",
      messages: claudeTurns(messages.map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content }))),
    }),
  });
  if (!resp.ok) throw new Error(`Claude returned ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  const data = await resp.json();
  const text = ((data.content ?? []) as { type: string; text?: string }[])
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("")
    .trim();
  return parseReply(text, "Claude");
}

/** Claude Sonnet 5 when ANTHROPIC_API_KEY is set; Groq otherwise or if Claude fails. */
async function callModel(messages: MessageRow[]): Promise<SmartGateLLMReply & { model: string }> {
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (key) {
    try {
      return { ...(await callClaude(messages, key)), model: "Claude Sonnet 5" };
    } catch (e) {
      console.error("Claude failed, using Groq:", e);
      return { ...(await callGroq(messages)), model: "Groq gpt-oss-120b (Claude unavailable)" };
    }
  }
  return { ...(await callGroq(messages)), model: "Groq gpt-oss-120b (Claude key not set)" };
}

async function callGroq(messages: MessageRow[]): Promise<SmartGateLLMReply> {
  const apiKey = Deno.env.get("GROQ_API_KEY");
  if (!apiKey) throw new GroqConfigError("GROQ_API_KEY not configured");

  const groqMessages = [
    { role: "system", content: buildSystemPrompt() },
    ...messages.map((m) => ({ role: m.role, content: m.content })),
  ];

  let resp: Response;
  try {
    resp = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: groqMessages,
        temperature: 0.4,
        response_format: { type: "json_object" },
      }),
    });
  } catch (err) {
    throw new GroqUpstreamError(
      `Failed to reach Groq: ${err instanceof Error ? err.message : "network error"}`
    );
  }

  if (!resp.ok) {
    const errText = await resp.text();
    throw new GroqUpstreamError(`Groq returned ${resp.status}: ${errText}`);
  }

  const data: GroqResponse = await resp.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new GroqUpstreamError("Groq returned an empty response.");

  let parsed: SmartGateLLMReply;
  try {
    parsed = JSON.parse(content) as SmartGateLLMReply;
  } catch {
    throw new GroqUpstreamError("Groq returned non-JSON content.");
  }

  if (typeof parsed.reply !== "string") {
    throw new GroqUpstreamError("Groq response missing 'reply' field.");
  }

  return parsed;
}

class GroqConfigError extends Error {}
class GroqUpstreamError extends Error {}

async function handleChat(
  goalId: string,
  userMessage: string
): Promise<SmartGateLLMReply & { model: string; smart: Record<string, string | null> }> {
  await fetchGoal(goalId);
  const messages = await fetchMessages(goalId);

  await saveMessage(goalId, "user", userMessage);

  const updatedMessages = [...messages, { role: "user", content: userMessage } as MessageRow];

  const llmReply = await callModel(updatedMessages);

  await saveMessage(goalId, "assistant", llmReply.reply);

  const updates: Record<string, string> = { updated_at: new Date().toISOString() };
  if (llmReply.specific) updates.specific = llmReply.specific;
  if (llmReply.measurable) updates.measurable = llmReply.measurable;
  if (llmReply.achievable) updates.achievable = llmReply.achievable;
  if (llmReply.relevant) updates.relevant = llmReply.relevant;
  if (llmReply.time_bound) updates.time_bound = llmReply.time_bound;
  if (llmReply.pillar) updates.pillar = llmReply.pillar;

  if (llmReply.complete) {
    updates.status = "smart_approved";
  }

  const { error: updateErr } = await supabase
    .from("goals")
    .update(updates)
    .eq("id", goalId);

  if (updateErr) throw new Error(`Failed to update goal: ${updateErr.message}`);

  const smart: Record<string, string | null> = {
    specific: llmReply.specific,
    measurable: llmReply.measurable,
    achievable: llmReply.achievable,
    relevant: llmReply.relevant,
    time_bound: llmReply.time_bound,
  };

  return { ...llmReply, smart };
}

async function handleHistory(
  goalId: string
): Promise<{ messages: MessageRow[]; smart: Record<string, string | null>; status: string }> {
  const goal = await fetchGoal(goalId);
  const messages = await fetchMessages(goalId);
  return {
    messages,
    smart: {
      specific: goal.specific,
      measurable: goal.measurable,
      achievable: goal.achievable,
      relevant: goal.relevant,
      time_bound: goal.time_bound,
    },
    status: goal.status,
  };
}

async function handleApprove(
  goalId: string
): Promise<{ success: boolean; smart: Record<string, string | null> }> {
  const goal = await fetchGoal(goalId);

  const { error } = await supabase
    .from("goals")
    .update({ status: "smart_approved", updated_at: new Date().toISOString() })
    .eq("id", goalId);

  if (error) throw new Error(`Failed to approve goal: ${error.message}`);

  return {
    success: true,
    smart: {
      specific: goal.specific,
      measurable: goal.measurable,
      achievable: goal.achievable,
      relevant: goal.relevant,
      time_bound: goal.time_bound,
    },
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const body: SmartGateRequest = await req.json();
    let result: Record<string, unknown>;

    switch (body.action) {
      case "chat": {
        if (!body.goal_id) throw new Error("goal_id is required.");
        if (!body.message) throw new Error("message is required.");
        result = { ...(await handleChat(body.goal_id, body.message)) };
        break;
      }

      case "history": {
        if (!body.goal_id) throw new Error("goal_id is required.");
        result = await handleHistory(body.goal_id);
        break;
      }

      case "approve": {
        if (!body.goal_id) throw new Error("goal_id is required.");
        result = await handleApprove(body.goal_id);
        break;
      }

      default:
        throw new Error(`Unknown action: ${body.action}`);
    }

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    const status = err instanceof GroqConfigError ? 500
      : err instanceof GroqUpstreamError ? 502
      : 500;
    return new Response(
      JSON.stringify({ success: false, error: message }),
      { status, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});



