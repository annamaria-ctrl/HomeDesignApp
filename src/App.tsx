import { useEffect } from "react";
import { Dashboard } from "./components/layout/Dashboard";
import { AuthGate } from "./components/auth/AuthGate";
import { PublicViewer } from "./components/layout/PublicViewer";
import { useAuthStore } from "./store/useAuthStore";

const publicViewProjectId = new URLSearchParams(window.location.search).get("view");

function App() {
  const init = useAuthStore((s) => s.init);
  useEffect(() => {
    // a public share-link session never needs its own auth session
    if (!publicViewProjectId) init();
  }, [init]);

  if (publicViewProjectId) {
    return <PublicViewer projectId={publicViewProjectId} />;
  }

  return (
    <AuthGate>
      <Dashboard />
    </AuthGate>
  );
}

export default App;
