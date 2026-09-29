import { useState, type FormEvent } from "react";
import { LockKeyhole } from "lucide-react";
import { login } from "../api/client";

export default function Login({ onSuccess }: { onSuccess: () => void }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      await login(String(form.get("username")), String(form.get("password")));
      onSuccess();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Anmeldung fehlgeschlagen.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel login">
      <LockKeyhole size={28} />
      <h2>Bei Grid Analysis anmelden</h2>
      <p>
        Der Zugriff auf gespeicherte Ergebnisse und FDWH-Messdaten ist
        geschützt.
      </p>
      <form onSubmit={submit}>
        <label>
          Benutzername
          <input name="username" autoComplete="username" required />
        </label>
        <label>
          Passwort
          <input
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
        </label>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button className="primary" disabled={busy}>
          {busy ? "Anmeldung läuft …" : "Anmelden"}
        </button>
      </form>
    </section>
  );
}
