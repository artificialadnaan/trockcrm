import { Routes, Route, Navigate } from "react-router-dom";

function Dashboard() {
  return (
    <div className="flex items-center justify-center min-h-screen">
      <div className="text-center">
        <h1 className="text-3xl font-bold text-brand-purple">T Rock CRM</h1>
        <p className="mt-2 text-muted-foreground">Foundation running. Ready for features.</p>
      </div>
    </div>
  );
}

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Dashboard />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
