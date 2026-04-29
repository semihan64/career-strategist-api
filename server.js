const http = require("http");
const https = require("https");

// ── Config ────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY;

if (!API_KEY) {
  console.error("ERROR: Set ANTHROPIC_API_KEY environment variable first.");
  process.exit(1);
}

// Simple in-memory rate limiter: max 10 requests per IP per hour
const rateLimitMap = new Map();
const RATE_LIMIT = 10;
const RATE_WINDOW_MS = 60 * 60 * 1000; // 1 hour

function isRateLimited(ip) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip) || { count: 0, windowStart: now };
  if (now - entry.windowStart > RATE_WINDOW_MS) {
    entry.count = 0;
    entry.windowStart = now;
  }
  entry.count++;
  rateLimitMap.set(ip, entry);
  return entry.count > RATE_LIMIT;
}

// ── CORS headers ──────────────────────────────────────────────
function setCORS(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

// ── Proxy call to Anthropic ───────────────────────────────────
function callAnthropic(body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const options = {
      hostname: "api.anthropic.com",
      path: "/v1/messages",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        "x-api-key": API_KEY,
        "anthropic-version": "2023-06-01",
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch (e) {
          reject(new Error("Failed to parse Anthropic response"));
        }
      });
    });

    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

// ── Server ────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  setCORS(res);

  // Handle preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // Health check
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }

  // Only allow POST /api/analyse
  if (req.method !== "POST" || req.url !== "/api/analyse") {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
    return;
  }

  // Rate limiting
  const ip = req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.remoteAddress;
  if (isRateLimited(ip)) {
    res.writeHead(429, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "You're on a roll. Check back in an hour." }));
    return;
  }

  // Read body
  let rawBody = "";
  req.on("data", (chunk) => (rawBody += chunk));
  req.on("end", async () => {
    try {
      const { cv, jd } = JSON.parse(rawBody);

      if (!cv || !jd) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing cv or jd fields." }));
        return;
      }

      if (jd.length > 10000 || cv.length > 8000) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Input too long." }));
        return;
      }

      const SYSTEM_PROMPT = `You are an AI Career Strategist. You think like a senior hiring manager and insider recruiter — not a career coach. Direct, specific, honest. Never generic.

You will receive a candidate CV and a job description. The CV may contain the candidate's name — extract it if present.

Return ONLY a valid JSON object. Plain ASCII only. No markdown, no backticks, no explanation.

RULES FOR NAME USE:
- Extract the candidate name from the CV if present, store in "candidateName"
- Use the name ONLY in: mindsetBanner and whatToDoNext
- Everywhere else use "you" / "your" — neutral tone
- Do NOT repeat the name more than once per field
- If no name found, set candidateName to "" and use neutral tone throughout

JSON keys:

candidateName: string — extracted from CV, or empty string
matchScore: integer 0-100
skillsLevel: "High" or "Medium" or "Low"
domainLevel: "Strong" or "Moderate" or "Weak"
seniorityLevel: "Aligned" or "Slight stretch" or "Mismatch"
mindsetBanner: ONE punchy sentence max 15 words. Decisive. If name known use it once. Must be specific to this role and candidate.
whyFit: exactly 2 bullets separated by | character. Each under 18 words. Specific signals only.
edge: 1 sentence max. The single clearest differentiator vs other candidates. Concrete.
hiringManagerCares: 2 short bullets separated by | character. What they ACTUALLY care about. Each under 20 words.
redFlags: 2 short bullets separated by | character. Specific concerns. Each under 18 words.
pitch: Natural 30-second pitch. Conversational. 55-70 words. Zero buzzwords.
positioning: "A [specific role identity] with [concrete strength] in [relevant domain]"
fitVerdict: "Strong fit" or "Stretch" or "Low probability"
fitReason: one sharp line, under 15 words
applyVerdict: exactly one of: "Apply now" or "Winnable — reposition first" or "Skip this one"
applyReason: 1 sentence max. Specific.
whatToDoNext: 2-3 action instructions separated by | character. Direct, imperative. If name known use it once at start of first bullet only. Each under 20 words.
rejectionRisk: 2 short bullets separated by | character. Focused on positioning gaps or narrative weakness. Each under 20 words.
whatTheyAreTesting: 1-2 sentences. What the interviewer is actually validating.
q1: Interview question specific to this role and candidate. Not generic.
q1whyAsking: 1 short line. Why they're really asking. Under 15 words.
q1intent: What a strong answer must demonstrate. 1 sentence.
q1approach: How THIS candidate should answer. 2 short sentences max.
q1mistake: Most common mistake. 1 sentence.
q2: Second specific question.
q2whyAsking: 1 short line.
q2intent: 1 sentence.
q2approach: 2 short sentences max.
q2mistake: 1 sentence.
q3: Third specific question.
q3whyAsking: 1 short line.
q3intent: 1 sentence.
q3approach: 2 short sentences max.
q3mistake: 1 sentence.
exampleAnswer: Strong answer to the most important question. Conversational. 110-140 words. Sounds like a real person talking.

Return ONLY the JSON object. Nothing else.`;

      const result = await callAnthropic({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 2500,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: `CANDIDATE CV:\n${cv}\n\nJOB DESCRIPTION:\n${jd}`,
          },
        ],
      });

      res.writeHead(result.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result.body));
    } catch (err) {
      console.error("Server error:", err.message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal server error." }));
    }
  });
});

server.listen(PORT, () => {
  console.log(`Career Strategist proxy running on port ${PORT}`);
});