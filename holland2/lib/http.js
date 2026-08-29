export class HttpError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

export async function fetchJson(url, opts) {
  const options = opts || {};
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs;
  const timer = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : null;
  if (options.signal) {
    if (options.signal.aborted) controller.abort();
    else {
      options.signal.addEventListener("abort", () => controller.abort(), { once: true });
    }
  }
  try {
    const res = await fetch(url, {
      headers: options.headers,
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new HttpError(`Request failed (${res.status})`, res.status);
    }
    return await res.json();
  } finally {
    if (timer) clearTimeout(timer);
  }
}
