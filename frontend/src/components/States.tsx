import { Component, type ReactNode } from "react";
import { AlertCircle, RefreshCw } from "lucide-react";

export function Loading({
  label = "Analysedaten werden geladen …",
}: {
  label?: string;
}) {
  return (
    <div className="state" role="status">
      <RefreshCw size={22} className="spinner" />
      <p>{label}</p>
    </div>
  );
}
export function ErrorState({
  message,
  retry,
}: {
  message: string;
  retry?: () => void;
}) {
  return (
    <div className="state error" role="alert">
      <AlertCircle size={24} />
      <p>{message}</p>
      {retry && <button onClick={retry}>Erneut versuchen</button>}
    </div>
  );
}
export class ErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <ErrorState
        message="Diese Ansicht konnte nicht geladen werden."
        retry={() => window.location.reload()}
      />
    ) : (
      this.props.children
    );
  }
}
