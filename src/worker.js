/**
 * wavzyy.in — Cloudflare Worker (src/worker.js)
 * Serves /api/ping, /api/download, /api/upload, /api/diagnose
 * and falls back to static assets in ./public via env.ASSETS.
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Requested-With",
  "Access-Control-Max-Age": "86400",
  "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...CORS_HEADERS,
    },
  });
}

function handleDownload(url) {
  const requested = parseInt(url.searchParams.get("bytes") || "10485760", 10);
  const totalBytes = Math.min(Math.max(Number.isFinite(requested) ? requested : 10485760, 1024), 50 * 1024 * 1024);
  const chunkSize = 65536;
  const chunk = new Uint8Array(chunkSize);
  for (let i = 0; i < chunkSize; i++) {
    chunk[i] = (i * 131 + 17) & 0xff;
  }

  let sent = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (sent >= totalBytes) {
        controller.close();
        return;
      }
      const remaining = totalBytes - sent;
      if (remaining >= chunkSize) {
        controller.enqueue(chunk);
        sent += chunkSize;
      } else {
        controller.enqueue(chunk.subarray(0, remaining));
        sent += remaining;
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(totalBytes),
      "Content-Encoding": "identity",
      ...CORS_HEADERS,
    },
  });
}

async function handleUpload(request) {
  const start = Date.now();
  const buffer = await request.arrayBuffer();
  return jsonResponse({
    ok: true,
    bytesReceived: buffer.byteLength,
    serverMs: Date.now() - start,
    timestamp: Date.now(),
  });
}

function ruleBasedDiagnosis({ downloadMbps = 0, uploadMbps = 0, pingMs = 0, jitterMs = 0, packetLossPct = 0 }) {
  const issues = [];
  const tips = [];

  if (pingMs > 80 || jitterMs > 20) {
    issues.push("High latency or jitter detected (likely Wi-Fi interference or bufferbloat).");
    tips.push("Switch to 5 GHz Wi-Fi or Ethernet, and enable SQM/QoS on your router.");
  }
  if (packetLossPct > 1) {
    issues.push(`Packet loss (${packetLossPct}%) may cause call freezes.`);
    tips.push("Check loose cables or reboot your modem/ONT.");
  }
  if (downloadMbps > 0 && uploadMbps > 0 && downloadMbps / uploadMbps > 10) {
    issues.push("Highly asymmetric upload speed.");
    tips.push("Pause large cloud backups before video calls.");
  }
  if (downloadMbps > 0 && downloadMbps < 15) {
    issues.push("Low download throughput for multi-device HD streaming.");
    tips.push("Test closer to the router to rule out signal drop-off.");
  }

  if (issues.length === 0) {
    return {
      grade: "Healthy",
      summary: `Strong connection (${downloadMbps.toFixed(1)} Mbps down, ${uploadMbps.toFixed(1)} Mbps up, ${pingMs.toFixed(0)} ms ping).`,
      tips: ["Suitable for 4K streaming, video calls, and low-latency gaming."],
      source: "rule-engine",
    };
  }

  return {
    grade: packetLossPct > 2 || pingMs > 120 ? "Needs Attention" : "Fair",
    summary: issues.join(" "),
    tips,
    source: "rule-engine",
  };
}

async function handleDiagnose(request, env) {
  let metrics;
  try {
    metrics = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const fallback = ruleBasedDiagnosis(metrics);

  if (env && env.AI) {
    try {
      const prompt = [
        "You are wavzyy.in AI Connection Doctor. Analyze these speed test metrics concisely in 2-3 bullet points with practical fixes:",
        JSON.stringify({
          downloadMbps: metrics.downloadMbps,
          uploadMbps: metrics.uploadMbps,
          pingMs: metrics.pingMs,
          jitterMs: metrics.jitterMs,
          packetLossPct: metrics.packetLossPct ?? 0,
        }),
      ].join("\n");

      const aiResult = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
        messages: [{ role: "user", content: prompt }],
        max_tokens: 220,
      });

      return jsonResponse({
        ...fallback,
        aiSummary: aiResult?.response || fallback.summary,
        source: "workers-ai",
      });
    } catch {
      return jsonResponse(fallback);
    }
  }

  return jsonResponse(fallback);
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    if (url.pathname === "/api/ping" && request.method === "GET") {
      return jsonResponse({
        ok: true,
        ts: Date.now(),
        colo: request.cf?.colo || "edge",
        isp: request.cf?.asOrganization || "Unknown ISP",
      });
    }
    if (url.pathname === "/api/download" && request.method === "GET") {
      return handleDownload(url);
    }
    if (url.pathname === "/api/upload" && request.method === "POST") {
      return handleUpload(request);
    }
    if (url.pathname === "/api/diagnose" && request.method === "POST") {
      return handleDiagnose(request, env);
    }

    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return jsonResponse({ error: "Not found", path: url.pathname }, 404);
  },
};
