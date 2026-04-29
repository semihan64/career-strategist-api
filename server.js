const http = require("http");
const https = require("https");

// ── Config ────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY;

if (!API_KEY) {
  console.error("ERROR: Set ANTHROPIC_API_KEY environment variable first.");
  process.exit(1);
}

// ── Rate limiter: 10 req / IP / hour ─────────────────────────
const rateLimitMap = new Map();
const RATE_LIMIT = 10;
const RATE_WINDOW_MS = 60 * 60 * 1000;

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

// ── CORS ──────────────────────────────────────────────────────
function setCORS(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

// ── Fix 3: extract clean JSON text from Claude response ───────
function extractCleanJson(responseBody) {
  // Always pull text blocks only
  const content = responseBody.content || [];
  const raw = content
    .filter(b => b.type === "text")
    .map(b => b.text || "")
    .join("");

  if (!raw) return null;

  // Strip markdown wrappers
  let clean = raw
    .replace(/^```(?:json)?\s*/gm, "")
    .replace(/^```\s*$/gm, "")
    .trim();

  // Find outermost JSON object
  const s = clean.indexOf("{");
  const e = clean.lastIndexOf("}");
  if (s === -1 || e === -1) return null;

  return clean.slice(s, e + 1);
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
      res.on("data", chunk => (data += chunk));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          reject(new Error("Failed to parse Anthropic response"));
        }
      });
    });

    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

const SYSTEM_PROMPT = `You are an AI Career Strategist. You think like a senior hiring manager and insider recruiter, not a career coach. Direct, specific, honest. Never generic.

You will receive a candidate CV and a job description. The CV may contain the candidate's name, extract it if present.

Return ONLY a valid JSON object. Plain ASCII only. No markdown, no backticks, no explanation.

RULES FOR NAME USE:
- Extract the candidate name from the CV if present, store in "candidateName"
- Use the name ONLY in: mindsetBanner and whatToDoNext
- Everywhere else use "you" / "your", neutral tone
- Do NOT repeat the name more than once per field
- If no name found, set candidateName to "" and use neutral tone throughout

JSON keys:

candidateName: string, extracted from CV, or empty string
matchScore: integer 0-100
skillsLevel: "High" or "Medium" or "Low"
domainLevel: "Strong" or "Moderate" or "Weak"
seniorityLevel: "Aligned" or "Slight stretch" or "Mismatch"
mindsetBanner: 2-3 sentences. Warm, direct, specific. Use name if known. No dashes.
whyFit: exactly 2 bullets separated by | character
edge: 1 sentence. Clearest differentiator.
hiringManagerCares: 2 bullets separated by |
redFlags: 2 bullets separated by |
pitch: 30-second pitch. 55-70 words. Conversational.
positioning: "A [role identity] with [strength] in [domain]"
fitVerdict: "Strong fit" or "Stretch" or "Low probability"
fitReason: one sharp line under 15 words
applyVerdict: "Apply now" or "Winnable — reposition first" or "Skip this one"
applyReason: 1 sentence
whatToDoNext: 2-3 actions separated by |
rejectionRisk: 2 bullets separated by |
whatTheyAreTesting: 1-2 sentences
q1: Interview question specific to this role and candidate
q1whyAsking: 1 short line
q1intent: 1 sentence
q1approach: 2 short sentences
q1mistake: 1 sentence
q2: Second specific question
q2whyAsking: 1 short line
q2intent: 1 sentence
q2approach: 2 short sentences
q2mistake: 1 sentence
q3: Third specific question
q3whyAsking: 1 short line
q3intent: 1 sentence
q3approach: 2 short sentences
q3mistake: 1 sentence
exampleAnswer: 110-140 words. Conversational. Sounds like a real person.

Return ONLY the JSON object. Nothing else.`;

// ── Server ────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  setCORS(res);

  if (req.method === "OPTIONS") {
    res.writeHead(204); res.end(); return;
  }

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

  // Rate limiting
  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim()
    || req.socket.remoteAddress;
  if (isRateLimited(ip)) {
    res.writeHead(429, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "RATE_LIMITED" }));
    return;
  }

  // Read body using Buffer chunks to handle encoding correctly
  const chunks = [];

  req.on("data", chunk => chunks.push(chunk));

  req.on("end", async () => {
    const rawBody = Buffer.concat(chunks).toString("utf8");

    console.log("Body length:", rawBody.length);
    console.log("Body preview:", rawBody.slice(0, 100));

    let cv, jd;
    try {
      ({ cv, jd } = JSON.parse(rawBody));
    } catch (parseErr) {
      console.error("JSON parse error:", parseErr.message);
      console.error("Raw body sample:", rawBody.slice(0, 200));
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON body: " + parseErr.message }));
      return;
    }

    console.log("cv length:", (cv || "").length, "jd length:", (jd || "").length);

    // validate fields present
    if (!cv || !cv.trim() || !jd || !jd.trim()) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing cv or jd fields" }));
      return;
    }

    // Fix 1: backend-side size guard (frontend already trims, this is a safety net)
    const safeCv = cv.slice(0, 7000);
    const safeJd = jd.slice(0, 9000);

    try {
      const result = await callAnthropic({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 2500,
        system: SYSTEM_PROMPT,
        messages: [{
          role: "user",
          content: `${safeCv}\n\n${safeJd}`,
        }],
      });

      // Fix 3: surface Anthropic rate limit
      if (result.status === 429) {
        res.writeHead(429, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "RATE_LIMITED" }));
        return;
      }

      // Fix 3: extract clean JSON from Claude response on the backend
      const cleanJson = extractCleanJson(result.body);

      if (cleanJson) {
        // Return clean JSON string directly — frontend just needs to parse it
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ result: cleanJson }));
      } else {
        // Fall back to forwarding raw body so frontend can try
        res.writeHead(result.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result.body));
      }

    } catch (err) {
      console.error("Server error:", err.message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal server error" }));
    }
  });
});

server.listen(PORT, () => {
  console.log(`Career Strategist proxy running on port ${PORT}`);
});
