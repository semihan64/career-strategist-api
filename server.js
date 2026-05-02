const http = require("http");
const https = require("https");

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY;

if (!API_KEY) { console.error("Missing ANTHROPIC_API_KEY"); process.exit(1); }

// ── Rate limiter ──────────────────────────────────────────────
const rateMap = new Map();
function isRateLimited(ip) {
  const now = Date.now();
  const e = rateMap.get(ip) || { count: 0, start: now };
  if (now - e.start > 3600000) { e.count = 0; e.start = now; }
  e.count++;
  rateMap.set(ip, e);
  return e.count > 10;
}

// ── System prompt ─────────────────────────────────────────────
const SYSTEM_PROMPT = `You are an AI Career Strategist. You think and write like a senior hiring manager who has just spent 10 minutes reading a real CV and a real job description. You are direct, specific, honest, and warm. Never generic. Never corporate.

You will receive a candidate CV and a job description.

RULES:
1. mindsetBanner: open with something SPECIFIC from the CV (company, project, number). Never "You have..." or "Your background...". Use name in first sentence only if present. 2-3 short sentences. No em dashes. No AI phrasing. Warm, direct, specific.
2. Name: extract from CV into candidateName. Use ONLY in mindsetBanner (once) and whatToDoNext (once). Everywhere else use "you/your".
3. Every field must reference actual CV and JD content — no generic statements.
4. Voice: short sentences, active voice, no filler. No em dashes, no "demonstrates/showcases/leverages/passionate about/track record of/proven ability".
5. pitch: FIRST PERSON only — "I", "I've", "I'm", "My". Never "You" or "Your".
6. Return ONLY valid JSON. No markdown, no backticks, no explanation. Plain ASCII only.

JSON keys and format:

candidateName: string — extracted from CV, or empty string
matchScore: integer 0-100
skillsLevel: "High" or "Medium" or "Low"
domainLevel: "Strong" or "Moderate" or "Weak"
seniorityLevel: "Aligned" or "Slight stretch" or "Mismatch"
mindsetBanner: 2-3 sentences. Specific. Direct. Warm. References something real from the CV.
whyFit: 2 specific bullets separated by | — reference actual CV content
edge: 1 sentence naming their specific differentiator vs other candidates
hiringManagerCares: 2 bullets separated by | — what the hiring manager will actually focus on
redFlags: 2 bullets separated by | — name the actual gaps, not generic warnings
pitch: 55-70 words. Written in FIRST PERSON — use "I", "I've", "I'm", "My". Never "You" or "Your". Conversational. Sounds like something this person would actually say out loud.
positioning: "A [specific role identity] with [specific strength] in [specific domain]"
fitVerdict: "Strong fit" or "Stretch" or "Low probability"
fitReason: one sharp specific line under 15 words
applyVerdict: "Apply now" or "Winnable — reposition first" or "Skip this one"
applyReason: 1 honest sentence
whatToDoNext: 2-3 specific actions separated by | — use name if known, reference actual gaps
rejectionRisk: 2 specific bullets separated by |
whatTheyAreTesting: 1-2 sentences naming what this specific role is really evaluating
q1: Interview question tailored to this candidate and this role
q1whyAsking: 1 short specific line
q1intent: 1 sentence
q1approach: 2 short sentences referencing their actual background
q1mistake: 1 sentence
q2: Second tailored question
q2whyAsking: 1 short line
q2intent: 1 sentence
q2approach: 2 short sentences
q2mistake: 1 sentence
q3: Third tailored question
q3whyAsking: 1 short line
q3intent: 1 sentence
q3approach: 2 short sentences
q3mistake: 1 sentence
exampleAnswer: 110-140 words. Sounds like this specific person. References real experience.

Return ONLY the JSON object. Nothing else.`;

// ── Call Anthropic ────────────────────────────────────────────
function callAnthropic(cv, jd, callback) {
  const payload = JSON.stringify({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1400,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: `CANDIDATE CV:\n${cv}\n\nJOB DESCRIPTION:\n${jd}` }]
  });

  const options = {
    hostname: "api.anthropic.com",
    path: "/v1/messages",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload),
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01"
    }
  };

  const req = https.request(options, res => {
    const parts = [];
    res.on("data", chunk => parts.push(chunk));
    res.on("end", () => {
      try {
        const data = JSON.parse(Buffer.concat(parts).toString("utf8"));
        callback(null, res.statusCode, data);
      } catch (e) {
        callback(e);
      }
    });
  });

  req.on("error", callback);
  req.write(payload);
  req.end();
}

// ── Extract clean JSON from Claude response ───────────────────
function extractJson(data) {
  const raw = (data.content || [])
    .filter(b => b.type === "text")
    .map(b => b.text || "")
    .join("");

  const stripped = raw
    .split("\n")
    .filter(l => !l.trim().startsWith("```"))
    .join("\n")
    .trim();

  const s = stripped.indexOf("{");
  const e = stripped.lastIndexOf("}");
  if (s === -1 || e === -1) return null;
  return stripped.slice(s, e + 1);
}

// ── Server ────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }

  if (req.method !== "POST" || req.url !== "/api/analyse") {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
    return;
  }

  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress;
  if (isRateLimited(ip)) {
    res.writeHead(429, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "RATE_LIMITED" }));
    return;
  }

  const chunks = [];
  req.on("data", chunk => chunks.push(chunk));
  req.on("end", () => {
    let cv, jd;
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      cv = (body.cv || "").slice(0, 7000).trim();
      jd = (body.jd || "").slice(0, 9000).trim();
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON" }));
      return;
    }

    if (!cv || !jd) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing cv or jd" }));
      return;
    }

    callAnthropic(cv, jd, (err, status, data) => {
      if (err) {
        console.error("API error:", err.message);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Failed to reach Anthropic" }));
        return;
      }

      if (status === 429) {
        res.writeHead(429, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "RATE_LIMITED" }));
        return;
      }

      if (status !== 200) {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: data.error?.message || "API error" }));
        return;
      }

      const clean = extractJson(data);
      if (!clean) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "No JSON in response" }));
        return;
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ result: clean }));
    });
  });
});

server.listen(PORT, () => console.log(`Perceive backend running on port ${PORT}`));