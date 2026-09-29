import { useEffect, useState } from "react";
import { get } from "../api/client";

export function useResource<T>(path: string | null) {
  const [retry, setRetry] = useState(0);
  const [state, setState] = useState<{
    path: string | null;
    data: T | null;
    error: string;
    loading: boolean;
  }>({ path: null, data: null, error: "", loading: false });
  useEffect(() => {
    if (!path) return;
    const controller = new AbortController();
    setState({ path, data: null, error: "", loading: true });
    void get<T>(path, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted)
          setState({ path, data, error: "", loading: false });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setState({
            path,
            data: null,
            error:
              error instanceof Error ? error.message : "Unbekannter Fehler",
            loading: false,
          });
      });
    return () => controller.abort();
  }, [path, retry]);
  return {
    ...(state.path === path
      ? state
      : { data: null, error: "", loading: Boolean(path) }),
    reload: () => setRetry((v) => v + 1),
  };
}
