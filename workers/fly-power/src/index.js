const DEFAULT_FLY_API_BASE = "https://api.machines.dev/v1";
const STOPPED_STATES = new Set(["stopped", "stopping", "created", "suspended"]);
const STATE_PRIORITY = new Map([
  ["started", 0],
  ["starting", 1],
  ["suspended", 2],
  ["stopping", 3],
  ["created", 4],
  ["stopped", 5],
  ["destroyed", 99],
]);

function trimValue(value) {
  return String(value ?? "").trim();
}

function isTruthy(value) {
  const normalized = trimValue(value).toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function jsonResponse(payload, status = 200) {
  return new Response(`${JSON.stringify(payload, null, 2)}\n`, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
  });
}

function getBearerToken(request) {
  const authHeader = trimValue(request.headers.get("authorization"));
  if (!authHeader.toLowerCase().startsWith("bearer ")) {
    return "";
  }
  return trimValue(authHeader.slice(7));
}

function readConfig(env) {
  return {
    appName: trimValue(env.FLY_APP_NAME),
    autoStopEnabled: trimValue(env.AUTO_STOP_ENABLED || "true"),
    flyApiBase: trimValue(env.FLY_API_BASE || DEFAULT_FLY_API_BASE).replace(/\/+$/, ""),
    flyApiToken: trimValue(env.FLY_API_TOKEN),
    shortcutToken: trimValue(env.SHORTCUT_TOKEN),
  };
}

function requireConfig(config) {
  const missing = [];
  if (!config.appName) {
    missing.push("FLY_APP_NAME");
  }
  if (!config.flyApiToken) {
    missing.push("FLY_API_TOKEN");
  }
  return missing;
}

function requireShortcutAuth(request, config) {
  if (!config.shortcutToken) {
    return jsonResponse({ ok: false, error: "Worker misconfigured: SHORTCUT_TOKEN missing" }, 500);
  }
  if (getBearerToken(request) !== config.shortcutToken) {
    return jsonResponse({ ok: false, error: "Unauthorized" }, 401);
  }
  return null;
}

async function flyRequest(config, path, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("authorization", `Bearer ${config.flyApiToken}`);
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  const response = await fetch(`${config.flyApiBase}${path}`, {
    ...init,
    headers,
  });

  const responseText = await response.text();
  let payload = null;
  if (responseText) {
    try {
      payload = JSON.parse(responseText);
    } catch {
      payload = responseText;
    }
  }

  if (!response.ok) {
    const detail = typeof payload === "string" ? payload : JSON.stringify(payload);
    throw new Error(`Fly API ${response.status} ${response.statusText}: ${detail || "no body"}`);
  }

  return payload;
}

function machinePriority(machine) {
  return STATE_PRIORITY.get(trimValue(machine.state)) ?? 50;
}

function machineTimestamp(machine) {
  const updatedAt = Date.parse(trimValue(machine.updated_at));
  const createdAt = Date.parse(trimValue(machine.created_at));
  if (Number.isFinite(updatedAt)) {
    return updatedAt;
  }
  if (Number.isFinite(createdAt)) {
    return createdAt;
  }
  return 0;
}

function simplifyMachine(machine) {
  return {
    id: trimValue(machine.id),
    name: trimValue(machine.name),
    region: trimValue(machine.region),
    state: trimValue(machine.state),
    updatedAt: trimValue(machine.updated_at),
  };
}

function pickMachine(machines) {
  const candidates = machines
    .filter((machine) => machine && typeof machine === "object")
    .filter((machine) => trimValue(machine.id) !== "")
    .filter((machine) => trimValue(machine.state) !== "destroyed");

  candidates.sort((left, right) => {
    const byState = machinePriority(left) - machinePriority(right);
    if (byState !== 0) {
      return byState;
    }
    return machineTimestamp(right) - machineTimestamp(left);
  });

  return candidates[0] ?? null;
}

async function listMachines(config) {
  const machines = await flyRequest(config, `/apps/${encodeURIComponent(config.appName)}/machines`);
  return Array.isArray(machines) ? machines : [];
}

async function resolveMachine(config) {
  const machines = await listMachines(config);
  const selected = pickMachine(machines);
  if (!selected) {
    throw new Error(`No machines found for app ${config.appName}`);
  }
  return {
    selected,
    machines,
  };
}

async function waitForState(config, machineId, state, timeoutSeconds = 60) {
  const query = new URLSearchParams({
    state,
    timeout: String(timeoutSeconds),
  });
  return flyRequest(
    config,
    `/apps/${encodeURIComponent(config.appName)}/machines/${encodeURIComponent(machineId)}/wait?${query.toString()}`,
    { method: "GET" },
  );
}

async function performStatus(config) {
  const { selected, machines } = await resolveMachine(config);
  return {
    app: config.appName,
    machine: simplifyMachine(selected),
    machines: machines.map((machine) => simplifyMachine(machine)),
    ok: true,
  };
}

async function performStart(config, waitForStarted = false) {
  const { selected } = await resolveMachine(config);
  const machineId = trimValue(selected.id);
  let currentState = trimValue(selected.state);

  let changed = false;
  if (currentState === "stopping") {
    await waitForState(config, machineId, "stopped");
    currentState = "stopped";
  }

  if (currentState !== "started" && currentState !== "starting") {
    try {
      await flyRequest(
        config,
        `/apps/${encodeURIComponent(config.appName)}/machines/${encodeURIComponent(machineId)}/start`,
        { method: "POST" },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("machine still active")) {
        throw error;
      }
      await waitForState(config, machineId, "stopped");
      await flyRequest(
        config,
        `/apps/${encodeURIComponent(config.appName)}/machines/${encodeURIComponent(machineId)}/start`,
        { method: "POST" },
      );
    }
    changed = true;
  }

  const waitResult = waitForStarted ? await waitForState(config, machineId, "started") : null;
  const status = await performStatus(config);

  return {
    action: "start",
    changed,
    ok: true,
    waitForStarted,
    waitResult,
    ...status,
  };
}

async function performStop(config, reason = "api") {
  const { selected } = await resolveMachine(config);
  const machineId = trimValue(selected.id);
  const currentState = trimValue(selected.state);

  let changed = false;
  if (!STOPPED_STATES.has(currentState)) {
    await flyRequest(
      config,
      `/apps/${encodeURIComponent(config.appName)}/machines/${encodeURIComponent(machineId)}/stop`,
      { method: "POST" },
    );
    changed = true;
  }

  const status = await performStatus(config);
  return {
    action: "stop",
    changed,
    ok: true,
    reason,
    ...status,
  };
}

function methodNotAllowed(method, expected) {
  return jsonResponse({
    ok: false,
    error: `Method ${method} not allowed. Expected ${expected}`,
  }, 405);
}

async function handleHttpRequest(request, env) {
  const config = readConfig(env);
  const missingConfig = requireConfig(config);
  if (missingConfig.length > 0) {
    return jsonResponse({
      ok: false,
      error: `Worker misconfigured: missing ${missingConfig.join(", ")}`,
    }, 500);
  }

  const authError = requireShortcutAuth(request, config);
  if (authError) {
    return authError;
  }

  const url = new URL(request.url);
  try {
    if (url.pathname === "/status") {
      if (request.method !== "GET") {
        return methodNotAllowed(request.method, "GET");
      }
      return jsonResponse(await performStatus(config));
    }

    if (url.pathname === "/start") {
      if (request.method !== "POST") {
        return methodNotAllowed(request.method, "POST");
      }
      const waitForStarted = isTruthy(url.searchParams.get("wait"));
      return jsonResponse(await performStart(config, waitForStarted));
    }

    if (url.pathname === "/stop") {
      if (request.method !== "POST") {
        return methodNotAllowed(request.method, "POST");
      }
      return jsonResponse(await performStop(config));
    }

    return jsonResponse(
      {
        ok: false,
        error: "Not found",
        routes: ["GET /status", "POST /start?wait=1", "POST /stop"],
      },
      404,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Request failed", {
      message,
      path: url.pathname,
    });
    return jsonResponse({ ok: false, error: "Upstream call failed", detail: message }, 502);
  }
}

async function handleScheduled(controller, env) {
  const config = readConfig(env);
  const missingConfig = requireConfig(config);
  if (missingConfig.length > 0) {
    console.error("Scheduled stop skipped: missing required config", missingConfig);
    return;
  }

  if (!isTruthy(config.autoStopEnabled)) {
    console.log("Scheduled stop skipped: AUTO_STOP_ENABLED is false");
    return;
  }

  try {
    const result = await performStop(config, "cron");
    console.log("Scheduled stop result", {
      cron: controller.cron,
      changed: result.changed,
      machine: result.machine,
      scheduledTime: controller.scheduledTime,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Scheduled stop failed", {
      cron: controller.cron,
      message,
      scheduledTime: controller.scheduledTime,
    });
  }
}

export default {
  fetch(request, env) {
    return handleHttpRequest(request, env);
  },
  scheduled(controller, env) {
    return handleScheduled(controller, env);
  },
};
