const base = `${(import.meta.env.VITE_API_BASE_URL || "").replace(/\/$/, "")}/api`;
export const sessionKey = "nahriva-analysis-token";

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function request(
  path: string,
  options: RequestInit = {},
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () =>
      controller.abort(
        new Error(
          "Zeitlimit überschritten. Zeitraum verkleinern oder Verbindung prüfen.",
        ),
      ),
    120_000,
  );
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  const token = sessionStorage.getItem(sessionKey);
  try {
    const response = await fetch(`${base}${path}`, {
      ...options,
      signal,
      headers: {
        Accept: "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...options.headers,
      },
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as {
        message?: string;
        detail?: unknown;
        request_id?: string;
      };
      if (response.status === 401 && token) {
        sessionStorage.removeItem(sessionKey);
        window.dispatchEvent(new Event("analysis:logout"));
      }
      const detail =
        typeof body.detail === "string"
          ? body.detail
          : "Anfrage konnte nicht verarbeitet werden.";
      throw new ApiError(
        `${body.message || detail}${body.request_id ? ` (Anfrage ${body.request_id})` : ""}`,
        response.status,
      );
    }
    return response;
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    if (error instanceof TypeError)
      throw new Error(
        "Backend nicht erreichbar. Verbindung prüfen und erneut versuchen.",
      );
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
export async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  return (await request(path, { signal })).json() as Promise<T>;
}
export async function login(username: string, password: string) {
  const response = await request("/auth/login", {
    method: "POST",
    body: new URLSearchParams({ username, password }),
  });
  const data = (await response.json()) as { access_token: string };
  sessionStorage.setItem(sessionKey, data.access_token);
}
export async function downloadCsv(query: string) {
  const response = await request(`/analysis/export.csv?${query}`);
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "nahriva-analysis.csv";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
